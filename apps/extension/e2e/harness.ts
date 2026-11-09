/** Loads the built extension into Chromium with a fake camera (M1 e2e harness). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';

export const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
/** `pnpm build:e2e`: same code, plus the two loopback origins pre-granted (manifest.config.ts). */
export const DIST_E2E = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-e2e');

export interface Harness {
  context: BrowserContext;
  extId: string;
  page: Page;
  sw: () => Promise<Worker>;
  send: <T>(msg: Record<string, unknown>) => Promise<{ ok: boolean; value?: T; error?: string }>;
  close: () => Promise<void>;
}

export async function launch(opts: { blockNetwork?: boolean; dist?: string } = {}): Promise<Harness> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'sa-e2e-'));
  const dist = opts.dist ?? DIST;
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env['HEADED'] !== '1',
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--disable-features=WebGPU',
      '--disable-gpu',
    ],
  });
  if (opts.blockNetwork) {
    // Everything over http(s) is aborted: whatever still works came from the extension package.
    await context.route(/^https?:\/\//, (route) => route.abort());
  }
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const extId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
  const send = async <T>(msg: Record<string, unknown>) =>
    page.evaluate(async (m) => (await chrome.runtime.sendMessage({ target: 'sw', ...m })) as { ok: boolean; value?: T; error?: string }, msg) as Promise<{
      ok: boolean;
      value?: T;
      error?: string;
    }>;
  return {
    context,
    extId,
    page,
    sw: async () => context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')),
    send,
    close: () => context.close(),
  };
}

export async function acceptConsentAndCamera(h: Harness): Promise<void> {
  const p = await h.context.newPage();
  await p.goto(`chrome-extension://${h.extId}/src/onboarding/consent/index.html`);
  for (const cb of await p.locator('input[type=checkbox]').all()) await cb.check();
  await p.getByRole('button', { name: /I agree/ }).click();
  await p.getByRole('button', { name: /Allow camera access/ }).click();
  await p.getByRole('button', { name: /^Allow camera$/ }).click();
  await p.getByText('Camera access granted').waitFor({ timeout: 15_000 });
  await p.close();
}

export interface DebugStats {
  stats: { ticks: number; lastTickAt: number | null; fractionWithinOneSecond: number; maxGapMs: number; maxConsecutiveMissed: number; detector: string; missingModels: string[]; intervalMs: number; lastFrameAt: number | null } | null;
  running: boolean;
  swStartedAt: number;
  log: string[];
}

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, stepMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!ok(last)) {
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(last).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, stepMs));
    last = await fn();
  }
  return last;
}
