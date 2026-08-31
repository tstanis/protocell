/**
 * Where cells live when they are not in memory. SPEC.md §15.9.
 *
 * A cell is an opaque blob keyed by its id. There are no queries, no joins and no search,
 * which is why this is not a database: the access pattern is `get(id)` / `put(id, bytes)`
 * and a 31 KB value. Metrics, when they are wanted, come from extracting saves into a
 * warehouse rather than from making the hot path carry a schema.
 *
 * Two implementations, and the local one is not a toy — it is the default, so that
 * `npm run server` needs no bucket, no credentials and no network to run.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export interface CellStore {
  /** The stored blob, or null if this cell has never been saved. */
  load(id: string): Promise<Buffer | null>;
  save(id: string, blob: Buffer): Promise<void>;
  /** Ids whose last write is older than `before` (ms epoch). For sweeping the abandoned. */
  stale(before: number): Promise<string[]>;
  remove(id: string): Promise<void>;
  /**
   * Optional: do the expensive setup now rather than on the first real save.
   *
   * Measured against GCS, the first write cost 1,954 ms and the fourth cost 212 ms — the
   * difference being a token exchange, a DNS lookup and two TLS handshakes. Paying that
   * at boot means the first player to disconnect is not the one who pays it.
   */
  warm?(): Promise<void>;
  readonly kind: string;
}

/**
 * A cell id (`u:<google-sub>`) as a filename.
 *
 * Encoded rather than used directly, for two reasons that are easy to underestimate: `:`
 * is not a legal filename character on Windows, and an id that reached the filesystem
 * unescaped would make `../` a path traversal straight out of the data directory. The id
 * is attacker-influenced in exactly one way — it derives from a Google subject — but
 * "currently unreachable" is a poor reason to leave a traversal in.
 *
 * base64url keeps it reversible, so `stale()` can hand back real ids.
 */
function toKey(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}
function fromKey(key: string): string {
  return Buffer.from(key, 'base64url').toString('utf8');
}

const SUFFIX = '.snap.gz';

export class FileCellStore implements CellStore {
  readonly kind = 'file';
  private readonly dir: string;
  private ready: Promise<void> | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  private async ensure(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  async load(id: string): Promise<Buffer | null> {
    await this.ensure();
    try {
      return await readFile(join(this.dir, toKey(id) + SUFFIX));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * Write, then fsync, THEN rename.
   *
   * The ordering is the whole point. A rename is atomic, so a reader sees either the old
   * file or the new one and never a half-written one — but only if the new file's contents
   * are actually on disk before the rename is published. Skipping the fsync gives a
   * rename that can land before the data does, and a crash in that window leaves a
   * perfectly-named, zero-length save. That is worse than no save at all, because it
   * replaces a good one.
   */
  async save(id: string, blob: Buffer): Promise<void> {
    await this.ensure();
    const final = join(this.dir, toKey(id) + SUFFIX);
    const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
    let handle;
    try {
      handle = await open(tmp, 'w');
      await handle.writeFile(blob);
      await handle.sync();
    } finally {
      await handle?.close();
    }
    try {
      await rename(tmp, final);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  async stale(before: number): Promise<string[]> {
    await this.ensure();
    const out: string[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(SUFFIX)) continue;
      const s = await stat(join(this.dir, name)).catch(() => null);
      // mtime IS the metadata layer here. It is why this store needs no index.
      if (s && s.mtimeMs < before) out.push(fromKey(name.slice(0, -SUFFIX.length)));
    }
    return out;
  }

  async remove(id: string): Promise<void> {
    await this.ensure();
    await rm(join(this.dir, toKey(id) + SUFFIX), { force: true });
  }
}

/**
 * Google Cloud Storage.
 *
 * Hand-rolled against the JSON API rather than pulling in `@google-cloud/storage`, for the
 * same reason `auth.ts` is hand-rolled: the surface actually used here is four operations,
 * and the SDK is a large dependency tree to carry for them.
 *
 * **The honest caveat**, because this is the one place in the project where a bug costs a
 * player their cell rather than a frame: this cannot be tested against real GCS without
 * credentials, so it ships verified only against its own unit tests. `FileCellStore` is
 * the default and the tested-by-default path; GCS is opt-in via `GCS_BUCKET`. If it
 * misbehaves, swapping in the official SDK is one file.
 *
 * Auth is the service-account JWT-bearer flow: sign a short-lived assertion with the
 * account's private key, exchange it for an access token, cache it. Running ON Google
 * Cloud, the metadata server hands out a token directly and no key is needed at all,
 * which is the better posture — a key that does not exist cannot leak.
 */
export class GcsCellStore implements CellStore {
  readonly kind = 'gcs';
  private readonly bucket: string;
  private readonly prefix: string;
  private token: { value: string; expires: number } | null = null;

  constructor(bucket: string, prefix = 'cells/') {
    this.bucket = bucket;
    this.prefix = prefix;
  }

  private path(id: string): string {
    // The object name is opaque to GCS but still gets URL-encoded on the way in, so a
    // hash keeps names short, flat and free of anything needing escaping.
    return `${this.prefix}${createHash('sha256').update(id).digest('hex')}.snap.gz`;
  }

  /**
   * A bearer token, cached until shortly before it expires.
   *
   * The 60 s margin is not superstition: a token that expires between the check and the
   * request arriving at Google fails with a 401 that looks exactly like a misconfigured
   * key, and that is a genuinely miserable thing to debug at 3am.
   */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires - 60_000) return this.token.value;

    // Two ways in, and the file path is the one to prefer.
    //
    // A service-account key's `private_key` is a PEM containing real newlines. Pasting
    // that JSON into a `.env` line does not work — the file format is line-oriented — and
    // the workarounds (escaping, quoting, base64) are all things to get subtly wrong at
    // the exact moment nothing works and there is no good error. `GOOGLE_APPLICATION_
    // CREDENTIALS` is a PATH, which is also the variable every other Google tool reads,
    // so the same key works with gcloud and gsutil unchanged.
    const path = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    const raw = path
      ? await readFile(path, 'utf8')
      : process.env['GOOGLE_APPLICATION_CREDENTIALS_JSON'];
    let value: string;
    let ttl = 3600;

    if (raw) {
      const key = JSON.parse(raw) as { client_email: string; private_key: string };
      const now = Math.floor(Date.now() / 1000);
      const claim = {
        iss: key.client_email,
        scope: 'https://www.googleapis.com/auth/devstorage.read_write',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now,
      };
      const { createSign } = await import('node:crypto');
      const b64 = (o: unknown): string =>
        Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
      const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claim)}`;
      const sig = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${unsigned}.${sig}`,
        }),
      });
      if (!r.ok) throw new Error(`GCS token exchange failed: ${r.status}`);
      const j = (await r.json()) as { access_token: string; expires_in: number };
      value = j.access_token;
      ttl = j.expires_in;
    } else {
      // On Google Cloud the metadata server serves the attached service account, so there
      // is no key material anywhere in the deployment.
      const r = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } },
      );
      if (!r.ok) throw new Error(`no GCS credentials: metadata server returned ${r.status}`);
      const j = (await r.json()) as { access_token: string; expires_in: number };
      value = j.access_token;
      ttl = j.expires_in;
    }

    this.token = { value, expires: Date.now() + ttl * 1000 };
    return value;
  }

  /** Retries on 429 and 5xx, which are routine rather than exceptional at any volume. */
  private async request(url: string, init: RequestInit, attempts = 4): Promise<Response> {
    let last: Response | null = null;
    for (let i = 0; i < attempts; i++) {
      const token = await this.accessToken();
      const r = await fetch(url, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
      });
      if (r.status !== 429 && r.status < 500) return r;
      last = r;
      // Exponential backoff with jitter, so a fleet of cells autosaving does not retry in
      // lockstep and reconverge on the same overloaded moment.
      const wait = 2 ** i * 100 + Math.random() * 100;
      await new Promise((res) => setTimeout(res, wait));
    }
    return last!;
  }

  async warm(): Promise<void> {
    await this.accessToken();
  }

  async load(id: string): Promise<Buffer | null> {
    const url =
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}` +
      `/o/${encodeURIComponent(this.path(id))}?alt=media`;
    const r = await this.request(url, { method: 'GET' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GCS load ${id}: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async save(id: string, blob: Buffer): Promise<void> {
    const url =
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}` +
      `/o?uploadType=media&name=${encodeURIComponent(this.path(id))}`;
    const r = await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: new Uint8Array(blob),
    });
    if (!r.ok) throw new Error(`GCS save ${id}: ${r.status}`);
  }

  /**
   * NOT IMPLEMENTED, deliberately, rather than half-implemented.
   *
   * GCS object names here are hashes, so a listing cannot recover the ids it would need to
   * return. Sweeping abandoned cells in a bucket is a lifecycle rule — object storage
   * already does age-based deletion natively and does it better than a poll loop would.
   */
  async stale(): Promise<string[]> {
    return [];
  }

  async remove(id: string): Promise<void> {
    const url =
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}` +
      `/o/${encodeURIComponent(this.path(id))}`;
    const r = await this.request(url, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw new Error(`GCS remove ${id}: ${r.status}`);
  }
}

/** Which credential route is configured, for a startup line that says something useful. */
export function gcsCredentialSource(): string {
  if (process.env['GOOGLE_APPLICATION_CREDENTIALS']) return `key file ${process.env['GOOGLE_APPLICATION_CREDENTIALS']}`;
  if (process.env['GOOGLE_APPLICATION_CREDENTIALS_JSON']) return 'inline key JSON';
  return 'metadata server (attached service account)';
}

/**
 * Which store to use, and why local development gets none by default.
 *
 * `STORE` is `none` | `file` | `gcs`. Unset, it is `none` unless NODE_ENV=production,
 * which is the important half.
 *
 * The footgun this closes: `.env` carries `GCS_BUCKET` because `npm run gcs:check` needs
 * it, and cells are keyed by `u:<google-sub>` — the same subject locally and in
 * production. So a local server that persisted by default would write to the live bucket
 * under the live key, and playing on localhost would silently overwrite the cell on the
 * deployed service. Nothing about that is visible until the save you wanted is gone.
 *
 * Deriving persistence from "is a bucket configured" was the mistake. Configuration says
 * what is *available*, not what this process should *do* with it.
 */
export function loadStore(): CellStore | null {
  const prod = process.env['NODE_ENV'] === 'production';
  const mode = process.env['STORE'] ?? (prod ? (process.env['GCS_BUCKET'] ? 'gcs' : 'file') : 'none');

  if (mode === 'none') return null;
  if (mode === 'gcs') {
    const bucket = process.env['GCS_BUCKET'];
    if (!bucket) throw new Error('STORE=gcs but GCS_BUCKET is not set');
    return new GcsCellStore(bucket, process.env['GCS_PREFIX'] ?? 'cells/');
  }
  if (mode === 'file') return new FileCellStore(process.env['DATA_DIR'] ?? 'data/cells');
  throw new Error(`STORE=${mode} — expected none, file or gcs`);
}

export { toKey as __toKey, fromKey as __fromKey };
