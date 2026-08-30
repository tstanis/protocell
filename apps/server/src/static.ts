/**
 * Serving the built client from the sim server. SPEC.md §15.10.
 *
 * In development the client is a separate vite server on :5173 and the sim is on :8787,
 * and that split is worth keeping — hot reload is not negotiable. In production they are
 * one origin, and that is not merely tidier:
 *
 *   - **No CORS.** Same-origin requests need no `Access-Control-Allow-*` at all, so the
 *     allow-list stops being a thing that can be wrong.
 *   - **Cookies simply work.** A `SameSite=Lax` session cookie is sent on a same-origin
 *     WebSocket upgrade without argument. Cross-origin it needs `SameSite=None; Secure`,
 *     which browsers are steadily tightening and third-party cookie deprecation is
 *     actively breaking.
 *   - **One URL to configure.** `PUBLIC_ORIGIN` and `APP_ORIGIN` collapse into the same
 *     value, which is also the Google redirect URI's host — three things that must agree
 *     become one thing that cannot disagree.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export class StaticFiles {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolve a URL path to a file inside the root, or null.
   *
   * The containment check is the whole function. `normalize` collapses `..`, and the
   * result is then required to sit under the root — a request for
   * `/../../../../etc/passwd` resolves outside and is refused. Serving user-supplied
   * paths without this is the oldest bug on the web and it is one line to not have.
   */
  private resolveSafe(urlPath: string): string | null {
    const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
    const candidate = resolve(join(this.root, normalize(decoded)));
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) return null;
    return candidate;
  }

  /** Returns true if it served something. */
  async serve(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    let file = this.resolveSafe(urlPath === '/' ? '/index.html' : urlPath);
    if (!file) return false;

    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }

    // SPA fallback: an unknown path that is not obviously an asset gets index.html, so a
    // deep link or a refresh lands on the app rather than a 404. Paths with a file
    // extension are excluded — a missing .js should 404 loudly, not silently return HTML
    // that the browser then fails to parse as a module.
    if (!info?.isFile()) {
      if (/\.[a-z0-9]+$/i.test(urlPath)) return false;
      file = join(this.root, 'index.html');
      info = await stat(file).catch(() => null);
      if (!info?.isFile()) return false;
    }

    const ext = file.slice(file.lastIndexOf('.'));
    // Vite fingerprints asset filenames, so those are immutable and cacheable forever.
    // index.html must never be, or a deploy ships new assets that nobody fetches.
    const immutable = /\/assets\//.test(file.replace(/\\/g, '/'));
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    await new Promise<void>((done) => {
      const s = createReadStream(file);
      s.pipe(res);
      s.on('end', () => done());
      s.on('error', () => {
        res.destroy();
        done();
      });
    });
    return true;
  }
}
