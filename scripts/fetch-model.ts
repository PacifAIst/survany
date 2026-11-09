#!/usr/bin/env node
// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fetches the models trained in this repository from their GitHub release and verifies each one's
 * SHA-256 against models/fire-smoke/CHECKSUMS.txt in memory, before anything is written to disk
 * (PLAN M2, SG-26). A file that does not match is never written. A present file that matches is
 * left alone, so this is cheap to run on every install.
 *
 * Runs on `pnpm install` (root postinstall) and again from the extension's `fetch-assets` (CI), which
 * then copies the verified file into the bundle and checks it against models/checksums.json.
 *
 *   node scripts/fetch-model.ts
 *   SA_SKIP_MODEL_FETCH=1 pnpm install   # offline: skip here; fetch-assets fails clearly if the file is missing
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_BASE = 'https://github.com/PacifAIst/survany/releases/download';

/** Release tag per model file. A new model gets a new tag and a new CHECKSUMS.txt line. */
export const MODEL_RELEASES: Record<string, string> = {
  'fire_smoke_yolox_tiny.onnx': 'fire-smoke-yolox-tiny-v1',
};

export interface ChecksumEntry {
  sha256: string;
  file: string;
}

// Plain fields, not parameter properties: Node runs this file with type stripping only.
export class ChecksumMismatch extends Error {
  readonly file: string;
  readonly expected: string;
  readonly got: string;
  constructor(file: string, expected: string, got: string) {
    super(`${file}: downloaded SHA-256 ${got} does not match the pinned ${expected}; nothing was written`);
    this.name = 'ChecksumMismatch';
    this.file = file;
    this.expected = expected;
    this.got = got;
  }
}

/** Parses `sha256sum` output format: "<64 hex>  <file>" per line; blank lines ignored. */
export function parseChecksums(text: string): ChecksumEntry[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
      if (!m?.[1] || !m[2]) throw new Error(`CHECKSUMS.txt: malformed line: ${line}`);
      return { sha256: m[1], file: m[2] };
    });
}

export function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Ensures `dest` holds exactly the pinned bytes. Downloads into memory, hashes, and only then writes
 * (to a temporary name, renamed into place), so a corrupted or tampered download never reaches disk
 * and an interrupted write never leaves a half file under the real name.
 */
export async function ensureVerified(url: string, expected: string, dest: string, fetchFn: FetchFn = fetch): Promise<'present' | 'downloaded'> {
  if (existsSync(dest) && sha256(readFileSync(dest)) === expected) return 'present';
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = sha256(bytes);
  if (got !== expected) throw new ChecksumMismatch(dest.split(/[\\/]/).pop() ?? dest, expected, got);
  const tmp = `${dest}.download`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
  return 'downloaded';
}

export async function fetchModels(dir: string, fetchFn: FetchFn = fetch, log: (s: string) => void = console.info): Promise<void> {
  const entries = parseChecksums(readFileSync(join(dir, 'CHECKSUMS.txt'), 'utf8'));
  for (const e of entries) {
    const tag = MODEL_RELEASES[e.file];
    if (!tag) throw new Error(`${e.file} is pinned in CHECKSUMS.txt but has no release in MODEL_RELEASES`);
    const url = `${RELEASE_BASE}/${tag}/${e.file}`;
    const r = await ensureVerified(url, e.sha256, join(dir, e.file), fetchFn);
    log(`${r === 'present' ? 'ok        ' : 'downloaded'} models/fire-smoke/${e.file} (sha256 ${e.sha256.slice(0, 12)}…${r === 'downloaded' ? `, from ${url}` : ''})`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env['SA_SKIP_MODEL_FETCH'] === '1') {
    console.info('fetch-model: skipped (SA_SKIP_MODEL_FETCH=1)');
  } else {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'models', 'fire-smoke');
    fetchModels(dir).catch((e: unknown) => {
      console.error(`fetch-model: ${e instanceof Error ? e.message : String(e)}`);
      console.error('Offline? Re-run with SA_SKIP_MODEL_FETCH=1 and run `node scripts/fetch-model.ts` later.');
      process.exit(1);
    });
  }
}
