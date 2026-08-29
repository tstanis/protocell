/**
 * Signing in with Google. SPEC.md §15.7.
 *
 * ── The flow, and why it is the server-side one ─────────────────────────────
 * Authorization Code flow, not implicit. The browser only ever carries an opaque `code`;
 * the ID token is fetched by THIS process, directly from Google's token endpoint, over
 * TLS. A token that never touches the browser cannot be stolen from it.
 *
 * That choice is also what lets this file have no dependencies. OIDC Core §3.1.3.7 says
 * that when an ID Token is received "via direct communication between the Client and the
 * Token Endpoint", TLS server validation MAY stand in for verifying the signature — we
 * know it came from Google because we opened the connection to Google. So the token is
 * decoded rather than signature-verified, and `iss`, `aud`, `exp` and `nonce` are all
 * still checked.
 *
 * **That reasoning is specific to this flow and does not generalise.** An ID token
 * arriving from the browser — implicit flow, or a Google Sign-In button posting a
 * credential — has passed through a place we do not control, and for those the signature
 * MUST be verified against Google's JWKS. If this file ever grows such an endpoint, it
 * grows a JWKS dependency with it.
 *
 * ── Sessions ────────────────────────────────────────────────────────────────
 * A signed cookie, not a server-side session table: the whole point of the payload is a
 * stable Google `sub`, and storing a row to look up a value we already hold buys nothing
 * except a lookup. HMAC-SHA256 over the payload, compared in constant time.
 *
 * ── Not configured is a supported state ─────────────────────────────────────
 * Without `GOOGLE_CLIENT_ID`, everything here goes dormant and the server behaves exactly
 * as it did before: anonymous, `?game=<id>`, no sign-in. Breaking `npm run server` for
 * anyone without OAuth credentials to hand would be a poor trade for a feature they
 * cannot use.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];

/** How long a sign-in lasts. */
const SESSION_TTL_S = 30 * 24 * 3600;
/** How long the browser has to complete a round trip to Google. */
const LOGIN_TTL_S = 10 * 60;

export interface Session {
  /** Google's stable subject id. The only thing we key a cell on. */
  sub: string;
  email?: string;
  name?: string;
  /** Issued-at, seconds. */
  iat: number;
}

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  /** Public origin of THIS server, e.g. http://localhost:8787 — must match Google exactly. */
  origin: string;
  secret: Buffer;
  /** Where to send the browser once signed in. */
  appOrigin: string;
}

export function loadAuthConfig(): AuthConfig | null {
  const clientId = process.env['GOOGLE_CLIENT_ID'];
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return null;

  const origin = process.env['PUBLIC_ORIGIN'] ?? `http://localhost:${process.env['PORT'] ?? 8787}`;
  const appOrigin = process.env['APP_ORIGIN'] ?? 'http://localhost:5173';

  // A generated secret means every restart invalidates every session. Fine locally,
  // actively bad in production, so it says so rather than failing quietly at 3am.
  const raw = process.env['SESSION_SECRET'];
  if (!raw && process.env['NODE_ENV'] === 'production') {
    throw new Error('SESSION_SECRET is required in production — sessions must survive a restart');
  }
  const secret = raw ? Buffer.from(raw, 'utf8') : randomBytes(32);
  if (!raw) console.warn('  ! SESSION_SECRET unset — generated one; sign-ins end at restart');

  return { clientId, clientSecret, origin, secret, appOrigin };
}

// ── signed payloads ──────────────────────────────────────────────────────────

function b64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(secret: Buffer, payload: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

export function seal(secret: Buffer, value: unknown): string {
  const payload = b64url(Buffer.from(JSON.stringify(value), 'utf8'));
  return `${payload}.${sign(secret, payload)}`;
}

/** Returns null on any tampering, rather than throwing into a request handler. */
export function unseal<T>(secret: Buffer, token: string | undefined): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(secret, payload);
  // Constant-time: a length check first, because timingSafeEqual throws on a mismatch.
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    return JSON.parse(unb64url(payload).toString('utf8')) as T;
  } catch {
    return null;
  }
}

// ── cookies ──────────────────────────────────────────────────────────────────

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function setCookie(res: ServerResponse, name: string, value: string, maxAge: number, secure: boolean): void {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
  res.setHeader('Set-Cookie', [...list, bits.join('; ')]);
}

export const SESSION_COOKIE = 'pc_session';
const LOGIN_COOKIE = 'pc_login';

// ── the flow ─────────────────────────────────────────────────────────────────

export function beginLogin(cfg: AuthConfig, res: ServerResponse): void {
  // `state` defeats CSRF on the callback; `nonce` defeats replay of an ID token. Both are
  // random, and both are carried in a signed cookie rather than server memory so a restart
  // mid-login is survivable.
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const secure = cfg.origin.startsWith('https:');
  setCookie(res, LOGIN_COOKIE, seal(cfg.secret, { state, nonce, t: Date.now() }), LOGIN_TTL_S, secure);

  const u = new URL(GOOGLE_AUTH);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', `${cfg.origin}/auth/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  res.writeHead(302, { Location: u.toString() });
  res.end();
}

interface IdTokenClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  nonce?: string;
  email?: string;
  name?: string;
}

/** Decode a JWT payload. See the header note on why this is not signature-verified. */
function decodeIdToken(jwt: string): IdTokenClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(unb64url(parts[1]!).toString('utf8')) as IdTokenClaims;
  } catch {
    return null;
  }
}

export async function handleCallback(
  cfg: AuthConfig,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const fail = (why: string): void => {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`sign-in failed: ${why}`);
  };

  const pending = unseal<{ state: string; nonce: string; t: number }>(
    cfg.secret,
    readCookie(req, LOGIN_COOKIE),
  );
  if (!pending) return fail('no pending sign-in (cookie missing or tampered)');
  if (Date.now() - pending.t > LOGIN_TTL_S * 1000) return fail('sign-in expired, try again');

  const state = url.searchParams.get('state');
  if (!state || state !== pending.state) return fail('state mismatch');

  const code = url.searchParams.get('code');
  if (!code) return fail(url.searchParams.get('error') ?? 'no code returned');

  let idToken: string | undefined;
  try {
    const body = new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: `${cfg.origin}/auth/callback`,
      grant_type: 'authorization_code',
    });
    const r = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) return fail(`token exchange returned ${r.status}`);
    idToken = ((await r.json()) as { id_token?: string }).id_token;
  } catch {
    return fail('could not reach Google');
  }
  if (!idToken) return fail('no id_token in the token response');

  const c = decodeIdToken(idToken);
  if (!c) return fail('unreadable id_token');
  if (!c.iss || !GOOGLE_ISS.includes(c.iss)) return fail('wrong issuer');
  if (c.aud !== cfg.clientId) return fail('token was not issued for this app');
  if (!c.exp || c.exp * 1000 < Date.now()) return fail('token expired');
  if (c.nonce !== pending.nonce) return fail('nonce mismatch');
  if (!c.sub) return fail('no subject');

  const secure = cfg.origin.startsWith('https:');
  const session: Session = { sub: c.sub, iat: Math.floor(Date.now() / 1000) };
  if (c.email) session.email = c.email;
  if (c.name) session.name = c.name;
  setCookie(res, SESSION_COOKIE, seal(cfg.secret, session), SESSION_TTL_S, secure);
  setCookie(res, LOGIN_COOKIE, '', 0, secure); // spend the one-time state

  res.writeHead(302, { Location: cfg.appOrigin });
  res.end();
}

export function sessionFrom(cfg: AuthConfig, req: IncomingMessage): Session | null {
  const s = unseal<Session>(cfg.secret, readCookie(req, SESSION_COOKIE));
  if (!s || !s.sub) return null;
  if (s.iat + SESSION_TTL_S < Math.floor(Date.now() / 1000)) return null;
  return s;
}

export function logout(cfg: AuthConfig, res: ServerResponse): void {
  setCookie(res, SESSION_COOKIE, '', 0, cfg.origin.startsWith('https:'));
  res.writeHead(204);
  res.end();
}

/**
 * The cell belonging to a signed-in player. One per account, as decided.
 *
 * Derived from the Google subject rather than stored in a mapping table, so there is no
 * row to get out of step and no way for two accounts to end up pointed at one cell. The
 * `u:` prefix keeps the namespace disjoint from anonymous `?game=` ids, so a signed-in
 * player can never be handed someone's sandbox by naming it.
 */
export function cellIdFor(session: Session): string {
  return `u:${session.sub}`;
}
