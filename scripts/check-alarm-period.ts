#!/usr/bin/env node
/**
 * C1: packaged extensions get chrome.alarms at most every 30 s. A shorter period
 * works unpacked and silently breaks at release, so CI rejects any alarm period or
 * delay under 0.5 min. Values must be numeric literals or same-file numeric consts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_MINUTES = 0.5;

export interface AlarmFinding {
  file: string;
  line: number;
  key: string;
  value: number | null;
  raw: string;
}

export function findAlarmPeriods(source: string, file: string): AlarmFinding[] {
  const consts = new Map<string, number>();
  for (const m of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*([0-9]*\.?[0-9]+)\s*;/g)) {
    if (m[1] && m[2]) consts.set(m[1], Number(m[2]));
  }
  const findings: AlarmFinding[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/\b(periodInMinutes|delayInMinutes)\s*:\s*([^,}\s]+)/g)) {
      const key = m[1] ?? '';
      const raw = (m[2] ?? '').trim();
      let value: number | null = null;
      if (/^[0-9]*\.?[0-9]+$/.test(raw)) value = Number(raw);
      else if (consts.has(raw)) value = consts.get(raw) ?? null;
      findings.push({ file, line: i + 1, key, value, raw });
    }
  });
  return findings;
}

export function violations(findings: AlarmFinding[]): string[] {
  return findings
    .filter((f) => f.value === null || f.value < MIN_MINUTES)
    .map((f) =>
      f.value === null
        ? `${f.file}:${f.line} ${f.key}: '${f.raw}' is not a resolvable numeric constant`
        : `${f.file}:${f.line} ${f.key}: ${f.value} min is under ${MIN_MINUTES} min`,
    );
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
}

function main(): void {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const srcDir = join(root, 'apps', 'extension', 'src');
  const files: string[] = [];
  walk(srcDir, files);
  const all = files.flatMap((f) => findAlarmPeriods(readFileSync(f, 'utf8'), relative(root, f)));
  const bad = violations(all);
  for (const b of bad) console.error(`::error::check-alarm-period: ${b}`);
  console.info(`check-alarm-period: ${all.length} alarm periods/delays found, ${bad.length} violations`);
  if (bad.length > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
