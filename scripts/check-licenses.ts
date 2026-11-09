#!/usr/bin/env node
// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * §11 license policy:
 *  - production npm dependencies must carry an allowlisted license;
 *  - bundled models must be Apache-2.0/MIT and never Ultralytics weights (AGPL + paid);
 *  - the media plane in deploy/ may only be OvenMediaEngine (principle 6).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_LICENSES = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Unlicense',
  'Python-2.0',
  'MPL-2.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
]);

/** Image name fragments for media servers that are not AGPL OvenMediaEngine. */
export const FORBIDDEN_MEDIA_SERVERS = [
  'restreamer',
  'livekit',
  'mediamtx',
  'janus',
  'ossrs',
  'srs:',
  'kurento',
  'red5',
  'wowza',
  'nginx-rtmp',
  'mediasoup',
];

export function licenseAllowed(expr: string): boolean {
  const cleaned = expr.replace(/[()]/g, ' ').trim();
  if (ALLOWED_LICENSES.has(cleaned)) return true;
  // "A OR B": acceptable if any alternative is allowed. "A AND B": all must be.
  if (/\sOR\s/.test(cleaned)) return cleaned.split(/\s+OR\s+/).some((p) => licenseAllowed(p));
  if (/\sAND\s/.test(cleaned)) return cleaned.split(/\s+AND\s+/).every((p) => licenseAllowed(p));
  return false;
}

export function checkModels(checksumsJson: string): string[] {
  const errors: string[] = [];
  const data = JSON.parse(checksumsJson) as { files: { name: string; license: string; sha256: string }[] };
  for (const f of data.files) {
    if (/yolov5|yolov8|yolo11|yolo12|ultralytics/i.test(f.name)) errors.push(`model ${f.name}: Ultralytics weights are not bundled (§11)`);
    if (!['Apache-2.0', 'MIT'].includes(f.license)) errors.push(`model ${f.name}: license ${f.license} not allowed`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) errors.push(`model ${f.name}: missing sha256 (SG-26)`);
  }
  return errors;
}

export function checkCompose(composeYaml: string): string[] {
  const errors: string[] = [];
  for (const m of composeYaml.matchAll(/^\s*image:\s*(\S+)/gm)) {
    const image = (m[1] ?? '').toLowerCase();
    if (FORBIDDEN_MEDIA_SERVERS.some((frag) => image.includes(frag))) {
      errors.push(`deploy image ${image}: only OvenMediaEngine (AGPL-3.0) may serve the media plane`);
    }
  }
  return errors;
}

interface PnpmLicenseEntry {
  name: string;
  versions: string[];
  license: string;
}

function main(): void {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const errors: string[] = [];
  const out = execSync('pnpm licenses list --json --prod --recursive', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const byLicense = JSON.parse(out || '{}') as Record<string, PnpmLicenseEntry[]>;
  let count = 0;
  for (const [license, pkgs] of Object.entries(byLicense)) {
    for (const p of pkgs) {
      count++;
      if (!licenseAllowed(license)) errors.push(`npm ${p.name}@${p.versions.join(',')}: license '${license}' not in allowlist`);
    }
  }
  const checksums = join(root, 'models', 'checksums.json');
  if (existsSync(checksums)) errors.push(...checkModels(readFileSync(checksums, 'utf8')));
  const compose = join(root, 'deploy', 'docker-compose.yml');
  if (existsSync(compose)) errors.push(...checkCompose(readFileSync(compose, 'utf8')));
  for (const e of errors) console.error(`::error::check-licenses: ${e}`);
  console.info(`check-licenses: ${count} production packages checked, ${errors.length} problems`);
  if (errors.length > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
