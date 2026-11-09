#!/usr/bin/env node
// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Every first-party source file carries the copyright line and the SPDX license id near the top (after a
 * shebang, if any). LICENSE itself stays the verbatim AGPL-3.0 text. `pnpm check:headers` checks,
 * `node scripts/check-headers.ts --fix` adds the header where it is missing.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COPYRIGHT = 'Copyright (C) 2026 PacifAIst';
export const SPDX = 'SPDX-License-Identifier: AGPL-3.0-only';

const SOURCE = /\.(ts|tsx|js|mjs|py|sh)$/;
const SKIP = /(^|\/)(dist|dist-e2e|public|node_modules|release)\//;

export function commentFor(path: string): string {
  return /\.(py|sh)$/.test(path) ? '#' : '//';
}

export function hasHeader(text: string): boolean {
  const head = text.split(/\r?\n/).slice(0, 6).join('\n');
  return head.includes(COPYRIGHT) && head.includes(SPDX);
}

/** Inserts the header after a shebang line, keeping the file's line endings. */
export function withHeader(path: string, text: string): string {
  if (hasHeader(text)) return text;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const c = commentFor(path);
  const header = `${c} ${COPYRIGHT}${nl}${c} ${SPDX}${nl}`;
  if (text.startsWith('#!')) {
    const end = text.indexOf('\n');
    return text.slice(0, end + 1) + header + text.slice(end + 1);
  }
  return header + text;
}

function main(): void {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const fix = process.argv.includes('--fix');
  const files = execSync('git ls-files', { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => SOURCE.test(f) && !SKIP.test(f));
  const missing: string[] = [];
  for (const f of files) {
    const p = join(root, f);
    const text = readFileSync(p, 'utf8');
    if (hasHeader(text)) continue;
    if (fix) writeFileSync(p, withHeader(f, text));
    else missing.push(f);
  }
  if (missing.length) {
    for (const f of missing) console.error(`::error file=${f}::missing copyright/SPDX header (run: node scripts/check-headers.ts --fix)`);
    console.error(`check-headers: ${missing.length} of ${files.length} source files lack the header`);
    process.exit(1);
  }
  console.info(`check-headers: ${files.length} source files ${fix ? 'have (or now have)' : 'carry'} the copyright and SPDX header`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
