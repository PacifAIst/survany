/** CSPRNG-backed identifiers (§6.5). Works in Node 24, service workers and pages. */
import { bytesToBase64Url } from './base64';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ID22_RE = /^[A-Za-z0-9_-]{22}$/;
export const TOKEN256_RE = /^[A-Za-z0-9_-]{43}$/;

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function uuidv4(): string {
  return crypto.randomUUID();
}

export function isUuidV4(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** 128-bit base64url id (22 chars), used in callback data. */
export function newId22(): string {
  return bytesToBase64Url(randomBytes(16));
}

/** 256-bit base64url token (43 chars): publisher and viewer tokens, device tokens. */
export function newToken256(): string {
  return bytesToBase64Url(randomBytes(32));
}
