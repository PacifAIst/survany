// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function hmacSha1Base64Url(key: string, data: string | Buffer): string {
  return createHmac('sha1', key).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function token256(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as SHA-256 (SG-10). */
export function tokenHash(token: string): string {
  return sha256Hex(`sa-token:${token}`);
}

/** Pairing codes: 8 characters from an unambiguous alphabet (C17). */
export function pairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let s = '';
  for (const b of bytes) {
    if (b < 256 - (256 % alphabet.length)) s += alphabet[b % alphabet.length];
    if (s.length === 8) return s;
  }
  return pairingCode();
}
