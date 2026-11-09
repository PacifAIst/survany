#!/usr/bin/env node
/**
 * Fetches the bundled models and ORT WASM into public/ and verifies each SHA-256 against
 * models/checksums.json (SG-26). Run once after install; CI runs it before the build.
 * Also renders the toolbar icons.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const repoRoot = join(appRoot, '..', '..');
const publicDir = join(appRoot, 'public');

interface Entry {
  name: string;
  path: string;
  sha256: string;
  source: string;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function obtain(e: Entry): Promise<Buffer> {
  if (e.source.startsWith('repo:')) {
    // A model trained in this repository: scripts/fetch-model.ts downloads it from its GitHub release and
    // verifies it against models/fire-smoke/CHECKSUMS.txt (runs on pnpm install and before this script).
    const p = join(repoRoot, e.source.slice(5));
    if (!existsSync(p)) throw new Error(`${e.name}: ${e.source.slice(5)} is missing. Run: node scripts/fetch-model.ts`);
    return readFileSync(p);
  }
  if (e.source.startsWith('npm:')) {
    const spec = e.source.slice(4); // onnxruntime-web@1.30.0/dist/file
    const [pkgAndVersion, ...rest] = spec.split('/');
    const pkg = (pkgAndVersion ?? '').replace(/@[^@]+$/, '');
    const require = createRequire(join(appRoot, 'package.json'));
    // The package may not export package.json, so walk up from its main entry to its root.
    let pkgDir = dirname(require.resolve(pkg));
    while (!existsSync(join(pkgDir, 'package.json')) || (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name?: string }).name !== pkg) {
      const up = dirname(pkgDir);
      if (up === pkgDir) throw new Error(`cannot locate package root for ${pkg}`);
      pkgDir = up;
    }
    const version = (pkgAndVersion ?? '').split('@').pop();
    const installed = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version;
    if (version && installed !== version) throw new Error(`${pkg}: installed ${installed}, checksums.json pins ${version}`);
    return readFileSync(join(pkgDir, ...rest));
  }
  const res = await fetch(e.source);
  if (!res.ok) throw new Error(`${e.name}: HTTP ${res.status} from ${e.source}`);
  return Buffer.from(await res.arrayBuffer());
}

function png(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(raw, y * (width * 4 + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer): number => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** An eye: dark rounded square, white almond, blue iris, dark pupil. */
function icon(size: number): Buffer {
  const px = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x - c) / (size / 2);
      const dy = (y - c) / (size / 2);
      const corner = Math.max(Math.abs(dx), Math.abs(dy)) > 0.92 && Math.hypot(Math.abs(dx) - 0.72, Math.abs(dy) - 0.72) > 0.2 && Math.abs(dx) > 0.72 && Math.abs(dy) > 0.72;
      let rgb: [number, number, number, number] = corner ? [0, 0, 0, 0] : [24, 32, 44, 255];
      const almond = Math.abs(dy) < 0.5 * (1 - dx * dx) && Math.abs(dx) < 0.86;
      if (!corner && almond) rgb = [240, 244, 248, 255];
      const r = Math.hypot(dx, dy);
      if (!corner && almond && r < 0.34) rgb = [40, 110, 220, 255];
      if (!corner && r < 0.15) rgb = [10, 14, 20, 255];
      px.set(rgb, i);
    }
  }
  return png(size, size, px);
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'models', 'checksums.json'), 'utf8')) as { files: Entry[] };
  for (const e of manifest.files) {
    const dest = join(publicDir, e.path);
    if (existsSync(dest) && sha256(readFileSync(dest)) === e.sha256) {
      console.info(`ok      ${e.path}`);
      continue;
    }
    const buf = await obtain(e);
    const got = sha256(buf);
    if (got !== e.sha256) throw new Error(`${e.name}: sha256 ${got} does not match pinned ${e.sha256}`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    console.info(`fetched ${e.path} (${buf.length} bytes, sha256 verified)`);
  }
  mkdirSync(join(publicDir, 'icons'), { recursive: true });
  for (const s of [16, 32, 48, 128]) writeFileSync(join(publicDir, 'icons', `icon-${s}.png`), icon(s));
  copyFileSync(join(repoRoot, 'models', 'checksums.json'), join(publicDir, 'checksums.json'));
  console.info('icons and checksums.json written');
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
