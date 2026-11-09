/**
 * Low-resolution, distant, night-time fire: the shipped fire/smoke model must still trip the `fire`
 * gate. Runs the extension's JavaScript path (jpeg-js, letterbox, ORT WASM, decode, NMS) and then the
 * gate's own evaluateGate with the built-in `fire` recipe and the default minYoloConfidence.
 *
 * - bench/fixtures/dfire/AoF07798_144p.jpg: a CC0 D-Fire night scene scaled to 256x144 (committed;
 *   always runs, including in CI).
 * - bench/fixtures/burning-house-144p*.jpg: a 144p screenshot of a burning house at night supplied by
 *   the owner. It is a frame of third-party footage, so it is kept out of git (.gitignore) and this case
 *   is skipped where the file is absent.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinRecipe, DETECTOR_MODELS } from '@survey-anything/recipes';
import { EXAMPLE_CONFIG_JSON } from '@survey-anything/shared';
import { evaluateGate, normalizeDetections } from '../src/worker/gate';
import { nms } from '../src/worker/nms';
import { decodeYolox, scaleDetections } from '../src/worker/yolox-decode';

const repo = join(__dirname, '..', '..', '..');
const info = DETECTOR_MODELS['fire-smoke-yolox-tiny']!;
const modelPath = join(__dirname, '..', 'public', info.file);
const fire = builtinRecipe('fire')!;

async function gateOn(file: string) {
  const { runYolox } = await import('../scripts/gen-yolox-fixture');
  const r = await runYolox(file, modelPath);
  const dets = nms(scaleDetections(decodeYolox(r.output, info.classes.length, r.inputSize, r.inputSize, 0.1), r.ratio), 0.45);
  const blank = { data: new Uint8Array(4), width: 1, height: 1 };
  const hit = evaluateGate(
    fire,
    { gray: blank, rgba: blank, detections: new Map([[info.id, normalizeDetections(dets, info.classes, r.width, r.height)]]), missingModels: new Set() },
    { prev: null, ref: null, minYoloConfidence: EXAMPLE_CONFIG_JSON.vision.minYoloConfidence },
  );
  const bestFire = Math.max(0, ...dets.filter((d) => info.classes[d.classId] === 'fire').map((d) => d.score));
  return { hit, bestFire, width: r.width, height: r.height };
}

const cases = [
  // The screenshot is a 144p stream as the player showed it (upscaled to 646 px, still 144p detail).
  { name: 'CC0 D-Fire night fire at 256x144', file: join(repo, 'bench', 'fixtures', 'dfire', 'AoF07798_144p.jpg'), height: 144 },
  { name: 'burning house at night, 144p screenshot as captured (owner-supplied)', file: join(repo, 'bench', 'fixtures', 'burning-house-144p.jpg'), height: 646 },
  { name: 'burning house at night, scaled to 144 px high (owner-supplied)', file: join(repo, 'bench', 'fixtures', 'burning-house-144p-native.jpg'), height: 144 },
];

describe.skipIf(!existsSync(modelPath))('fire gate on low-resolution, distant night fire', () => {
  for (const c of cases) {
    it.skipIf(!existsSync(c.file))(c.name, async () => {
      const r = await gateOn(c.file);
      expect(r.height).toBe(c.height);
      expect(r.hit.via).toBe('detector');
      expect(r.hit.hit, `gate score ${r.hit.score.toFixed(3)}`).toBe(true);
      expect(r.hit.labels).toContain('fire');
      expect(r.bestFire).toBeGreaterThanOrEqual(fire.gate.type === 'detector' ? fire.gate.minConfidence : 0.6);
    }, 60_000);
  }
});
