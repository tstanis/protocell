/**
 * §15.7 — sign-in, and the things it must refuse.
 *
 * Auth code is the code most likely to be tested only for the happy path, which is the
 * one case that proves nothing: a check that never rejects anything passes every
 * happy-path test ever written. Most of what follows asserts a refusal.
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { cellIdFor, readCookie, seal, unseal, type Session } from '../src/auth.js';

const secret = Buffer.from('a-test-secret-that-is-long-enough', 'utf8');

function reqWith(cookie: string): IncomingMessage {
  return { headers: { cookie } } as IncomingMessage;
}

describe('§15.7 — sealed payloads', () => {
  it('round-trips a session', () => {
    const s: Session = { sub: '12345', email: 'a@b.c', iat: 1000 };
    expect(unseal<Session>(secret, seal(secret, s))).toEqual(s);
  });

  it('REFUSES a payload whose contents were edited', () => {
    // The attack this stops: swap the `sub` for someone else's and you are them.
    const token = seal(secret, { sub: 'mine', iat: 1 });
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'yours', iat: 1 }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(unseal(secret, `${forged}.${mac}`)).toBeNull();
    expect(unseal(secret, `${payload}.${mac}`)).not.toBeNull(); // control
  });

  it('REFUSES a payload signed with a different secret', () => {
    const other = randomBytes(32);
    expect(unseal(secret, seal(other, { sub: 'x', iat: 1 }))).toBeNull();
  });

  it('REFUSES malformed tokens instead of throwing into a request handler', () => {
    for (const bad of ['', 'nodot', '.', 'a.', '.b', 'not.base64!!', 'a.b.c.d']) {
      expect(() => unseal(secret, bad)).not.toThrow();
      expect(unseal(secret, bad)).toBeNull();
    }
    expect(unseal(secret, undefined)).toBeNull();
  });

  it('REFUSES a truncated signature rather than crashing on length', () => {
    // timingSafeEqual throws on differing lengths, so the length check has to come first.
    const token = seal(secret, { sub: 'x', iat: 1 });
    const short = `${token.split('.')[0]}.${token.split('.')[1]!.slice(0, 8)}`;
    expect(() => unseal(secret, short)).not.toThrow();
    expect(unseal(secret, short)).toBeNull();
  });
});

describe('§15.7 — cookies', () => {
  it('reads the right one out of several', () => {
    const req = reqWith('other=1; pc_session=abc; another=2');
    expect(readCookie(req, 'pc_session')).toBe('abc');
    expect(readCookie(req, 'missing')).toBeUndefined();
  });

  it('is not fooled by a name that merely ends with the one it wants', () => {
    // `evil_pc_session` must not satisfy a read of `pc_session`.
    const req = reqWith('evil_pc_session=attacker; pc_session=real');
    expect(readCookie(req, 'pc_session')).toBe('real');
  });

  it('handles a missing cookie header', () => {
    expect(readCookie({ headers: {} } as IncomingMessage, 'pc_session')).toBeUndefined();
  });

  it('decodes percent-encoding, since a sealed token can contain padding', () => {
    expect(readCookie(reqWith('k=a%20b'), 'k')).toBe('a b');
  });
});

describe('§15.7 — one cell per account', () => {
  it('derives the cell id from the Google subject, not from anything the client sends', () => {
    expect(cellIdFor({ sub: 'abc', iat: 1 })).toBe('u:abc');
    expect(cellIdFor({ sub: 'abc', iat: 999 })).toBe('u:abc'); // stable across sessions
    expect(cellIdFor({ sub: 'xyz', iat: 1 })).not.toBe(cellIdFor({ sub: 'abc', iat: 1 }));
  });

  it('namespaces user cells away from anonymous ?game= ids', () => {
    // Without the prefix, connecting anonymously as `?game=<someone's sub>` would open
    // their cell — the classic insecure direct object reference.
    expect(cellIdFor({ sub: 'abc', iat: 1 }).startsWith('u:')).toBe(true);
  });
});
