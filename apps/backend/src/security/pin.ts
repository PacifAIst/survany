/**
 * Contact PINs (§6.5): 6-8 digits, scrypt with a per-contact salt, per-contact lockout with
 * exponential backoff. Only well-formed submissions count as attempts, so a mail scanner that
 * auto-submits the form cannot lock a contact out. There is no route that changes a PIN in place.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/migrate';

export const PIN_RE = /^\d{6,8}$/;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
export const PIN_POLICY = {
  attemptsPerHour: 5,
  lockoutBaseMs: 15 * 60 * 1000,
  lockoutMaxMs: 24 * 60 * 60 * 1000,
  ownerAlertAfterFailures: 3,
} as const;

export function hashPin(pin: string): string {
  if (!PIN_RE.test(pin)) throw new Error('PIN must be 6 to 8 digits');
  const salt = randomBytes(16);
  const dk = scryptSync(pin, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, dkB64] = parts as [string, string, string, string, string, string];
  const dk = Buffer.from(dkB64, 'base64url');
  const got = scryptSync(pin, Buffer.from(saltB64, 'base64url'), dk.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === dk.length && timingSafeEqual(got, dk);
}

export type PinCheck =
  | { result: 'ok' }
  | { result: 'malformed' }
  | { result: 'wrong'; failuresLastHour: number; alertOwner: boolean }
  | { result: 'locked'; until: number }
  | { result: 'no-pin' };

/** Verifies a PIN with lockout accounting. Malformed input is rejected without counting. */
export function checkPin(db: Db, contactId: string, pin: unknown, now = Date.now()): PinCheck {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) return { result: 'malformed' };
  const lock = db.prepare('SELECT until, count FROM pin_lockouts WHERE contact_id = ?').get(contactId) as { until: number; count: number } | undefined;
  if (lock && lock.until > now) return { result: 'locked', until: lock.until };
  const row = db.prepare('SELECT pin_hash FROM contacts WHERE id = ?').get(contactId) as { pin_hash: string | null } | undefined;
  if (!row?.pin_hash) return { result: 'no-pin' };
  const ok = verifyPin(pin, row.pin_hash);
  db.prepare('INSERT INTO pin_attempts(contact_id, at, ok) VALUES (?, ?, ?)').run(contactId, now, ok ? 1 : 0);
  if (ok) return { result: 'ok' };
  const failures = db.prepare('SELECT COUNT(*) AS n FROM pin_attempts WHERE contact_id = ? AND at > ? AND ok = 0').get(contactId, now - 3_600_000) as { n: number };
  if (failures.n >= PIN_POLICY.attemptsPerHour) {
    lockFor(db, contactId, lock?.count ?? 0, now);
  }
  return { result: 'wrong', failuresLastHour: failures.n, alertOwner: failures.n === PIN_POLICY.ownerAlertAfterFailures };
}

function lockFor(db: Db, contactId: string, previousCount: number, now: number): { result: 'locked'; until: number } {
  const count = previousCount + 1;
  const ms = Math.min(PIN_POLICY.lockoutBaseMs * 2 ** (count - 1), PIN_POLICY.lockoutMaxMs);
  const until = now + ms;
  db.prepare('INSERT INTO pin_lockouts(contact_id, until, count) VALUES (?, ?, ?) ON CONFLICT(contact_id) DO UPDATE SET until = excluded.until, count = excluded.count').run(contactId, until, count);
  db.prepare('DELETE FROM pin_attempts WHERE contact_id = ?').run(contactId);
  return { result: 'locked', until };
}
