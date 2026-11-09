#!/usr/bin/env node
// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Enforces the §7 security gate register (docs/PLAN.md §0 rule 6).
 *
 * For every gate SG-xx: code must carry a `SECURITY-GATE SG-xx:` marker and some
 * test file must reference SG-xx. Mode is derived from docs/PROGRESS.md:
 *  - any of the gate's milestones `done`  -> missing marker/test is a hard failure
 *  - any of the gate's milestones `doing` -> soft warning
 *  - otherwise                            -> not checked yet
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type MilestoneStatus = 'todo' | 'doing' | 'done';
export interface Gate {
  id: string;
  milestones: string[];
}
export interface ScanResult {
  markers: Map<string, string[]>;
  tests: Map<string, string[]>;
}
export interface Evaluation {
  errors: string[];
  warnings: string[];
  checked: number;
}

const MARKER_RE = /SECURITY-GATE (SG-\d{2}):\s*\S/g;
const SG_RE = /\bSG-(\d{2})\b/g;
const TEST_FILE_RE = /(\.(test|spec)\.(ts|tsx|js|mjs)$)|([\\/]e2e[\\/])/;
const SCANNED_EXT = /\.(ts|tsx|js|mjs|cjs|yaml|yml|xml|html|sql|py|css|json)$|(^|[\\/])Caddyfile$|(^|[\\/])Dockerfile$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'docs', 'coverage', 'release', 'test-results', 'playwright-report', '.vite', 'public']);

export function parseGates(planMd: string): Gate[] {
  const gates: Gate[] = [];
  for (const line of planMd.split(/\r?\n/)) {
    const m = /^\|\s*(SG-\d{2})\s*\|/.exec(line);
    if (!m || !m[1]) continue;
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    const last = cells[cells.length - 1] ?? '';
    const milestones = [...last.matchAll(/M\d+/g)].map((x) => x[0]);
    if (milestones.length === 0) continue;
    gates.push({ id: m[1], milestones });
  }
  return gates;
}

export function parseMilestoneStatus(progressMd: string): Map<string, MilestoneStatus> {
  const out = new Map<string, MilestoneStatus>();
  for (const line of progressMd.split(/\r?\n/)) {
    const m = /^\|\s*(M\d+)\s*\|\s*(todo|doing|done)\s*\|/.exec(line);
    if (m && m[1] && m[2]) out.set(m[1], m[2] as MilestoneStatus);
  }
  return out;
}

function walk(dir: string, root: string, files: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, files);
    else if (SCANNED_EXT.test(relative(root, full))) files.push(full);
  }
}

export function scanTree(root: string, excludeRel: string[] = []): ScanResult {
  const files: string[] = [];
  walk(root, root, files);
  const markers = new Map<string, string[]>();
  const tests = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, id: string, file: string): void => {
    const list = map.get(id) ?? [];
    if (!list.includes(file)) list.push(file);
    map.set(id, list);
  };
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    if (excludeRel.includes(rel)) continue;
    const text = readFileSync(file, 'utf8');
    if (TEST_FILE_RE.test(file)) {
      for (const m of text.matchAll(SG_RE)) add(tests, `SG-${m[1]}`, rel);
    } else {
      for (const m of text.matchAll(MARKER_RE)) if (m[1]) add(markers, m[1], rel);
    }
  }
  return { markers, tests };
}

export function evaluate(gates: Gate[], status: Map<string, MilestoneStatus>, scan: ScanResult): Evaluation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let checked = 0;
  for (const gate of gates) {
    const states = gate.milestones.map((m) => status.get(m) ?? 'todo');
    const hard = states.includes('done');
    const soft = !hard && states.includes('doing');
    if (!hard && !soft) continue;
    checked++;
    const problems: string[] = [];
    if (!scan.markers.has(gate.id)) problems.push('no code marker');
    if (!scan.tests.has(gate.id)) problems.push('no test');
    if (problems.length === 0) continue;
    const msg = `${gate.id} (${gate.milestones.join(', ')}): ${problems.join(' and ')}`;
    (hard ? errors : warnings).push(msg);
  }
  return { errors, warnings, checked };
}

function main(): void {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const plan = readFileSync(join(root, 'docs', 'PLAN.md'), 'utf8');
  const progress = readFileSync(join(root, 'docs', 'PROGRESS.md'), 'utf8');
  const gates = parseGates(plan);
  if (gates.length < 27) {
    console.error(`check-security-gates: parsed only ${gates.length} gates from PLAN.md §7`);
    process.exit(1);
  }
  const scan = scanTree(root, ['scripts/check-security-gates.test.ts']);
  const result = evaluate(gates, parseMilestoneStatus(progress), scan);
  for (const w of result.warnings) console.warn(`::warning::SECURITY-GATE soft: ${w}`);
  for (const e of result.errors) console.error(`::error::SECURITY-GATE hard: ${e}`);
  const withMarker = gates.filter((g) => scan.markers.has(g.id) && scan.tests.has(g.id)).length;
  console.info(
    `check-security-gates: ${gates.length} gates, ${withMarker} with marker+test, ${result.checked} in enforced milestones, ` +
      `${result.errors.length} errors, ${result.warnings.length} warnings`,
  );
  if (result.errors.length > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
