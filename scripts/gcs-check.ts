/**
 * Prove the GCS store actually works against a real bucket.
 *
 *   npm run gcs:check
 *
 * Writes a throwaway cell, reads it back, verifies it byte for byte, then deletes it.
 * Every failure mode reports what to fix rather than a bare status code — the whole point
 * is that a misconfigured bucket and a bad key look identical from a 403.
 */

import { GcsCellStore, gcsCredentialSource } from '../apps/server/src/store.js';
import { decodeSnapshot, encodeSnapshot } from '../apps/server/src/codec.js';
import { World } from '../packages/sim/src/world.js';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env is fine if the variables are already in the environment.
}

const bucket = process.env['GCS_BUCKET'];
if (!bucket) {
  console.error('GCS_BUCKET is not set. Add it to .env — see .env.example.');
  process.exit(1);
}

const prefix = process.env['GCS_PREFIX'] ?? 'cells/';
console.log(`bucket      gs://${bucket}`);
console.log(`prefix      ${prefix}`);
console.log(`credentials ${gcsCredentialSource()}`);
console.log('');

const store = new GcsCellStore(bucket, prefix);
const id = `__check__:${Date.now()}`;

function explain(e: unknown): string {
  const m = (e as Error).message;
  if (m.includes('401')) {
    return 'auth rejected. The key is wrong, malformed, or belongs to a deleted account.';
  }
  if (m.includes('403')) {
    return (
      'authenticated, but not permitted. Grant the service account "Storage Object Admin"\n' +
      '  ON THE BUCKET (Bucket → Permissions → Grant access), not just at project level.\n' +
      '  If this is a brand new project, also check the Cloud Storage API is enabled.'
    );
  }
  if (m.includes('404')) {
    return `bucket "${bucket}" does not exist, or is in a different project from the key.`;
  }
  if (m.includes('ENOENT')) {
    return 'the key file path in GOOGLE_APPLICATION_CREDENTIALS does not exist.';
  }
  if (m.includes('metadata')) {
    return (
      'no credentials at all. Set GOOGLE_APPLICATION_CREDENTIALS to a key file path,\n' +
      '  or run on a Google Cloud instance with a service account attached.'
    );
  }
  return m;
}

async function main(): Promise<void> {
  // A real cell, not a toy payload: this exercises the codec, the gzip and the size.
  const w = new World();
  w.buildGlucoseChannel();
  w.buildEnzyme();
  for (let i = 0; i < 120 * 20; i++) w.step();
  const blob = encodeSnapshot(w.snapshot());
  console.log(`payload     ${(blob.length / 1024).toFixed(1)} KB (a real cell, 20 s played)`);

  let t = Date.now();
  await store.save(id, blob);
  console.log(`  write     ok, ${Date.now() - t} ms`);

  t = Date.now();
  const back = await store.load(id);
  console.log(`  read      ok, ${Date.now() - t} ms`);
  if (!back) throw new Error('read back null immediately after a successful write');
  if (!back.equals(blob)) {
    throw new Error(`read back ${back.length} bytes, wrote ${blob.length} — CORRUPTED`);
  }
  console.log('  verify    byte-identical');

  // And it must still restore into a working cell, which is the thing that actually matters.
  const restored = new World();
  restored.restore(decodeSnapshot(back));
  if (restored.tick !== w.tick) throw new Error('restored cell is at a different tick');
  console.log(`  restore   ok, tick ${restored.tick}, ${restored.enzymes.length} enzyme(s)`);

  const missing = await store.load('__check__:definitely-not-here');
  if (missing !== null) throw new Error('a missing object should read as null, not throw');
  console.log('  missing   reads as null');

  await store.remove(id);
  if ((await store.load(id)) !== null) throw new Error('object still present after remove');
  console.log('  delete    ok');

  console.log('');
  console.log('GCS is working. Set GCS_BUCKET in .env and the server will use it.');
}

main().catch((e: unknown) => {
  console.error('');
  console.error('FAILED:', explain(e));
  console.error('');
  console.error(`  raw: ${(e as Error).message}`);
  // Leave no litter behind even on failure.
  void store.remove(id).catch(() => undefined);
  process.exit(1);
});
