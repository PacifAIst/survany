/**
 * The README quickstart (T0, extension only), driven end to end on the built extension (dist/):
 * consent -> Options (direct Telegram, Telegram as the only channel with the one-time acknowledgement,
 * the Fire or smoke rule, AI confirmation off = zero cost) -> watch -> the demo's fire scene -> an
 * "unconfirmed" alert reaches the Telegram Bot API.
 *
 * Two steps differ from a person following the README, because automation cannot click browser UI:
 *  - the source is the camera, with Chromium's fake camera playing the demo's fire scene (a Y4M built
 *    here from the same CC0 D-Fire image demo/ shows), instead of "Watch this tab" from the toolbar;
 *  - the bot token goes straight into storage, because storing it from Options asks for the
 *    api.telegram.org host permission in a browser prompt. Telegram itself is answered by the test.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { acceptConsentAndCamera, type DebugStats, type Harness, launch, waitFor } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js') as { decode(b: Buffer, o: { useTArray: boolean }): { width: number; height: number; data: Uint8Array } };

/** The demo's incident as a fake-camera video: 640x360 I420 frames of the fire image, slowly zooming. */
function fireY4m(): string {
  const img = jpeg.decode(readFileSync(join(here, '..', '..', '..', 'bench', 'fixtures', 'dfire', 'AoF07798.jpg')), { useTArray: true });
  const W = 640;
  const H = 360;
  const frames: Buffer[] = [];
  for (let f = 0; f < 30; f++) {
    const zoom = 1 + 0.04 * Math.sin(f / 5);
    const y = Buffer.alloc(W * H);
    const u = Buffer.alloc((W / 2) * (H / 2));
    const v = Buffer.alloc((W / 2) * (H / 2));
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const sx = Math.min(img.width - 1, Math.max(0, Math.round(((i - W / 2) / zoom + W / 2) * (img.width / W))));
        const sy = Math.min(img.height - 1, Math.max(0, Math.round(((j - H / 2) / zoom + H / 2) * (img.height / H))));
        const p = (sy * img.width + sx) * 4;
        const r = img.data[p] ?? 0;
        const g = img.data[p + 1] ?? 0;
        const b = img.data[p + 2] ?? 0;
        y[j * W + i] = Math.max(0, Math.min(255, Math.round(0.257 * r + 0.504 * g + 0.098 * b + 16)));
        if (j % 2 === 0 && i % 2 === 0) {
          const k = (j / 2) * (W / 2) + i / 2;
          u[k] = Math.max(0, Math.min(255, Math.round(-0.148 * r - 0.291 * g + 0.439 * b + 128)));
          v[k] = Math.max(0, Math.min(255, Math.round(0.439 * r - 0.368 * g - 0.071 * b + 128)));
        }
      }
    }
    frames.push(Buffer.from('FRAME\n'), y, u, v);
  }
  const path = join(mkdtempSync(join(tmpdir(), 'sa-y4m-')), 'demo-fire.y4m');
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...frames]));
  return path;
}

let h: Harness;
test.afterEach(async () => {
  await h?.close();
});

test('README quickstart (T0): the demo fire scene produces a Telegram alert with no backend and no AI model', async () => {
  test.setTimeout(5 * 60_000);
  h = await launch({ extraArgs: [`--use-file-for-fake-video-capture=${fireY4m()}`] });
  const sent: { method: string; body: string }[] = [];
  await h.context.route('https://api.telegram.org/**', async (route) => {
    sent.push({ method: route.request().url().split('/').pop() ?? '', body: route.request().postDataBuffer()?.toString('latin1') ?? '' });
    await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '{"ok":true,"result":{"message_id":1}}' });
  });
  await acceptConsentAndCamera(h);

  // Options, as the README says.
  const page = await h.context.newPage();
  await page.goto(`chrome-extension://${h.extId}/src/options/index.html`);
  await page.getByRole('checkbox', { name: 'Direct Telegram' }).check();
  await page.getByLabel('Chat ID for owner').fill('123456789');
  await page.evaluate(async () => chrome.storage.local.set({ secrets: { key_telegram_bot: 'TEST_BOT_TOKEN_NOT_REAL' } }));
  await page.getByRole('checkbox', { name: 'Email', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Alerts will not be redundant' }).getByRole('button', { name: 'I understand, use one channel' }).click();
  await page.getByRole('checkbox', { name: 'Confirm candidates with AI' }).uncheck();
  // The default rules are Fire or smoke and Other; keep only Fire or smoke.
  await page.getByRole('checkbox', { name: /^Anything unusual/ }).uncheck();
  await expect(page.getByRole('checkbox', { name: /^Fire or smoke/ })).toBeChecked();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('saved')).toContainText('Saved at');

  // Watch (the camera plays the demo's fire scene).
  const armed = await h.send({ type: 'arm', source: { kind: 'camera', label: 'Loading dock, camera 2' } });
  expect(armed.ok, armed.error).toBe(true);
  await waitFor(async () => sent.length, (n) => n > 0, 90_000, 1000).catch(async (e: unknown) => {
    const dbg = await h.send<DebugStats>({ type: 'debug-stats' });
    throw new Error(`${String(e)}\n${dbg.value?.log.join('\n')}`);
  });
  const alert = sent[0]!;
  expect(['sendPhoto', 'sendMessage']).toContain(alert.method);
  expect(alert.body).toContain('123456789');
  expect(alert.body).toContain('Fire or smoke');
  expect(alert.body).toContain('UNCONFIRMED: AI confirmation is turned off');
  const log = (await h.send<DebugStats>({ type: 'debug-stats' })).value?.log.join('\n') ?? '';
  expect(log).toMatch(/detector fire-smoke-yolox-tiny ready/);
  console.info(`QUICKSTART: first alert via ${alert.method} after the fire scene; ${sent.length} Telegram call(s).`);
});
