#!/usr/bin/env node
// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M8: packs apps/extension/dist into a reproducible zip (sorted entries, fixed timestamps, no extra
 * metadata), so the same commit always produces the same bytes and anyone can check a release by
 * rebuilding. Writes release/survey-anything-extension-<version>.zip and its .sha256.
 *   pnpm build && pnpm pack:extension
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** A deterministic zip of `files` (path inside the zip -> bytes). DOS time is fixed at 1980-01-01 00:00. */
export function deterministicZip(files: { name: string; data: Uint8Array }[]): Buffer {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  for (const f of sorted) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 38); // no external attributes: no permissions or owners leak into the archive
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const dist = join(root, 'apps', 'extension', 'dist');
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as { version: string; host_permissions?: unknown };
  if (manifest.host_permissions) throw new Error('dist/manifest.json has host_permissions: this is an e2e build, not a release build');
  const files = listFiles(dist).filter((p) => statSync(p).size >= 0).map((p) => ({ name: relative(dist, p).split(sep).join('/'), data: readFileSync(p) }));
  const zip = deterministicZip(files);
  const sha = createHash('sha256').update(zip).digest('hex');
  mkdirSync(join(root, 'release'), { recursive: true });
  const name = `survey-anything-extension-${manifest.version}.zip`;
  writeFileSync(join(root, 'release', name), zip);
  writeFileSync(join(root, 'release', `${name}.sha256`), `${sha}  ${name}\n`);
  console.info(`release/${name}: ${files.length} files, ${zip.length} bytes, sha256 ${sha}`);
}
