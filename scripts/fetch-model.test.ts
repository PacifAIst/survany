/** M2 / SG-26: the model fetcher writes only bytes whose SHA-256 matches the pin. No network: fetch is stubbed. */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChecksumMismatch, ensureVerified, type FetchFn, fetchModels, MODEL_RELEASES, parseChecksums, RELEASE_BASE, sha256 } from './fetch-model.ts';

const GOOD = new TextEncoder().encode('the real model bytes');
const PIN = sha256(GOOD);

function stub(bytes: Uint8Array, status = 200): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    return { ok: status === 200, status, arrayBuffer: async () => bytes.slice().buffer };
  }) as FetchFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'sa-fetch-model-'));

describe('fetch-model', () => {
  it('a corrupted download is rejected and nothing is written to disk', async () => {
    const dir = tmp();
    const dest = join(dir, 'model.onnx');
    const corrupted = GOOD.slice();
    corrupted[3] = corrupted[3]! ^ 0xff;
    const err = await ensureVerified('https://example.invalid/model.onnx', PIN, dest, stub(corrupted)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChecksumMismatch);
    expect((err as ChecksumMismatch).got).toBe(sha256(corrupted));
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(dir)).toEqual([]); // no temporary file left behind either
  });

  it('a correct download is written and verified', async () => {
    const dir = tmp();
    const dest = join(dir, 'model.onnx');
    expect(await ensureVerified('https://example.invalid/model.onnx', PIN, dest, stub(GOOD))).toBe('downloaded');
    expect(sha256(readFileSync(dest))).toBe(PIN);
    expect(readdirSync(dir)).toEqual(['model.onnx']);
  });

  it('a present, matching file is kept without any download', async () => {
    const dir = tmp();
    const dest = join(dir, 'model.onnx');
    writeFileSync(dest, GOOD);
    const f = stub(GOOD);
    expect(await ensureVerified('https://example.invalid/model.onnx', PIN, dest, f)).toBe('present');
    expect(f.calls).toEqual([]);
  });

  it('a tampered local file is replaced by a verified download, never by a corrupted one', async () => {
    const dir = tmp();
    const dest = join(dir, 'model.onnx');
    writeFileSync(dest, 'tampered');
    await expect(ensureVerified('https://example.invalid/model.onnx', PIN, dest, stub(new TextEncoder().encode('also wrong')))).rejects.toBeInstanceOf(ChecksumMismatch);
    expect(readFileSync(dest, 'utf8')).toBe('tampered'); // the bad download did not overwrite anything
    expect(await ensureVerified('https://example.invalid/model.onnx', PIN, dest, stub(GOOD))).toBe('downloaded');
    expect(sha256(readFileSync(dest))).toBe(PIN);
  });

  it('an HTTP error writes nothing', async () => {
    const dir = tmp();
    await expect(ensureVerified('https://example.invalid/model.onnx', PIN, join(dir, 'model.onnx'), stub(GOOD, 404))).rejects.toThrow(/HTTP 404/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fetchModels downloads each pinned file from its release URL', async () => {
    const dir = tmp();
    const file = Object.keys(MODEL_RELEASES)[0]!;
    writeFileSync(join(dir, 'CHECKSUMS.txt'), `${PIN}  ${file}\n`);
    const f = stub(GOOD);
    await fetchModels(dir, f, () => undefined);
    expect(f.calls).toEqual([`${RELEASE_BASE}/${MODEL_RELEASES[file]}/${file}`]);
    expect(sha256(readFileSync(join(dir, file)))).toBe(PIN);
  });

  it('the repository pins agree: CHECKSUMS.txt, models/checksums.json, and a release for every file', () => {
    const root = join(__dirname, '..');
    const pins = parseChecksums(readFileSync(join(root, 'models', 'fire-smoke', 'CHECKSUMS.txt'), 'utf8'));
    expect(pins.length).toBeGreaterThan(0);
    const bundled = (JSON.parse(readFileSync(join(root, 'models', 'checksums.json'), 'utf8')) as { files: { name: string; sha256: string; source: string }[] }).files;
    for (const p of pins) {
      expect(MODEL_RELEASES[p.file], `${p.file} has a release`).toBeDefined();
      const b = bundled.find((x) => x.name === p.file);
      expect(b?.sha256, `${p.file} pinned the same in models/checksums.json`).toBe(p.sha256);
      expect(b?.source).toBe(`repo:models/fire-smoke/${p.file}`);
    }
  });

  it('parseChecksums accepts sha256sum format and refuses anything else', () => {
    expect(parseChecksums(`${PIN}  a.onnx\n${PIN} *b.onnx\n\n`)).toEqual([
      { sha256: PIN, file: 'a.onnx' },
      { sha256: PIN, file: 'b.onnx' },
    ]);
    expect(() => parseChecksums('not-a-hash  a.onnx')).toThrow(/malformed/);
  });
});
