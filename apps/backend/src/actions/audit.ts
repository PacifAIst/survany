// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SECURITY-GATE SG-22: the audit log is an append-only hash chain; any edited or deleted row breaks verification.
 */
import type { Db } from '../db/migrate';
import { sha256Hex } from '../security/hmac';

export const GENESIS = '0'.repeat(64);

export function appendAudit(db: Db, kind: string, data: unknown, now = Date.now()): string {
  const last = db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
  const prev = last?.hash ?? GENESIS;
  const body = JSON.stringify(data);
  const hash = sha256Hex(`${prev}\n${now}\n${kind}\n${body}`);
  db.prepare('INSERT INTO audit(at, kind, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?)').run(now, kind, body, prev, hash);
  return hash;
}

export function verifyAuditChain(db: Db): { ok: boolean; rows: number; brokenAt: number | null } {
  const rows = db.prepare('SELECT seq, at, kind, data, prev_hash, hash FROM audit ORDER BY seq').all() as {
    seq: number;
    at: number;
    kind: string;
    data: string;
    prev_hash: string;
    hash: string;
  }[];
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || sha256Hex(`${prev}\n${r.at}\n${r.kind}\n${r.data}`) !== r.hash) return { ok: false, rows: rows.length, brokenAt: r.seq };
    prev = r.hash;
  }
  return { ok: true, rows: rows.length, brokenAt: null };
}
