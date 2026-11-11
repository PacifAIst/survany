// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A rule with a region: the vision model must be able to see which part of the frame matters. The worker
 * outlines the region on the confirm image (black-and-white dashes) and the question says what the
 * rectangle is. Checked on what the model actually receives. Needs `pnpm build:e2e`.
 */
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { OUTLINE_NOTE } from '../../../packages/recipes/src/confirm';
import { EXAMPLE_CONFIG_JSON } from '@survey-anything/shared';
import { acceptConsentAndCamera, DIST_E2E, type Harness, launch } from './harness';
import { type ModelMock, startModelMock } from './model-mock';

const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js') as { decode(b: Buffer, o: { useTArray: boolean }): { width: number; height: number; data: Uint8Array } };

let h: Harness;
let mock: ModelMock;
test.afterAll(async () => {
  await h?.close();
  await mock?.close();
});

test('the region is outlined on the image the model sees, and the question explains the outline', async () => {
  mock = await startModelMock({ confirm: () => '{"event":"none","confidence":0.9,"reason":"nothing"}', reason: () => '{"tool":"none"}' });
  h = await launch({ dist: DIST_E2E });
  await acceptConsentAndCamera(h);
  const recipe = { id: 'zone-right-half', title: 'Movement in the right half', gate: { type: 'motion', pixelDelta: 8, threshold: 0.001, region: { x: 0.5, y: 0, w: 0.5, h: 1 } }, confirm: { prompt: 'Is anything moving inside the outlined area?', framesPerCheck: 1 }, severity: 'info' };
  await h.page.evaluate(async (r) => chrome.storage.local.set({ importedRecipes: [r] }), recipe);
  const saved = await h.send<{ ok: boolean; errors: string[] }>({
    type: 'save-config',
    config: {
      ...structuredClone(EXAMPLE_CONFIG_JSON),
      provider: { id: 'local', baseUrl: `${mock.url}/v1`, model: 'mock-vision', apiKeyRef: null },
      providerProfiles: {},
      failoverChain: ['local'],
      allowCloudProviders: false,
      vision: { ...EXAMPLE_CONFIG_JSON.vision, enableVision: true, scanIntervalMs: 1000 },
      alerts: { ...EXAMPLE_CONFIG_JSON.alerts, channels: ['telegram'], nonRedundantAck: true },
      contacts: { owner: { roles: ['viewer', 'approver'] } },
      routing: { 'zone-right-half': ['owner'] },
      rules: ['zone-right-half'],
    },
  });
  expect(saved.value, JSON.stringify(saved)).toEqual({ ok: true, errors: [] });
  expect((await h.send({ type: 'arm', source: { kind: 'camera', label: 'Outline camera' } })).ok).toBe(true);
  await expect.poll(() => mock.calls.filter((c) => c.kind === 'confirm').length, { timeout: 60_000 }).toBeGreaterThan(0);
  const call = mock.calls.find((c) => c.kind === 'confirm')!;
  expect(call.user).toContain(OUTLINE_NOTE);

  const img = jpeg.decode(Buffer.from(call.image!.split(',')[1]!, 'base64'), { useTArray: true });
  const luma = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
  };
  const extremes = (x: number) => {
    let dark = 0;
    let light = 0;
    for (let y = 0; y < img.height; y++) {
      const l = luma(x, y);
      if (l < 70) dark++;
      if (l > 185) light++;
    }
    return { dark: dark / img.height, light: light / img.height };
  };
  const edge = extremes(Math.round(img.width / 2));
  const control = extremes(Math.round(img.width / 4));
  test.info().annotations.push({ type: 'outline', description: JSON.stringify({ size: [img.width, img.height], edge, control }) });
  // Along the region's left edge the dashes alternate black and white; away from it they do not.
  expect(edge.dark).toBeGreaterThan(0.3);
  expect(edge.light).toBeGreaterThan(0.3);
  expect(Math.min(control.dark, control.light)).toBeLessThan(0.3);
});
