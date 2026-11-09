// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * confirm-gate-mcp device request signing (§6.5 "Approval binding", S17). Verified against the
 * project source 2026-11-09 (src/confirm_gate/evidence.py sign_request):
 *   hex(HMAC-SHA256(base64url_decode(key), "METHOD\nPATH?query\nTIMESTAMP\nhex(sha256(body))"))
 * Headers: x-device-id, x-timestamp (unix seconds), x-signature. Each signature is accepted once, ±60 s.
 */
import { createHash, createHmac } from 'node:crypto';

export function bodyHash(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function signRequest(keyB64Url: string, method: string, pathWithQuery: string, timestamp: number, body: Buffer | string): string {
  const key = Buffer.from(keyB64Url, 'base64url');
  const message = `${method.toUpperCase()}\n${pathWithQuery}\n${Math.trunc(timestamp)}\n${bodyHash(body)}`;
  return createHmac('sha256', key).update(message).digest('hex');
}

export function signedHeaders(deviceId: string, keyB64Url: string, method: string, pathWithQuery: string, body: Buffer | string, nowSec: number): Record<string, string> {
  return {
    'x-device-id': deviceId,
    'x-timestamp': String(Math.trunc(nowSec)),
    'x-signature': signRequest(keyB64Url, method, pathWithQuery, nowSec, body),
  };
}

/** Canonical JSON (sorted keys) so the params hash is stable across processes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function paramsHash(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson({ tool, args })).digest('hex');
}
