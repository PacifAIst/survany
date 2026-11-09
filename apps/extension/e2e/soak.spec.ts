/**
 * M1 soak: ≥95% of ticks within ±1 s of the 5 s target and no more than 1 consecutive missed tick
 * over 30 minutes, with every page hidden behind another tab. Run with SOAK_MINUTES=30.
 * Writes bench/reports/m1-soak.json as the evidence.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { acceptConsentAndCamera, type DebugStats, launch, waitFor } from './harness';

const minutes = Number(process.env['SOAK_MINUTES'] ?? '0');

test.skip(minutes <= 0, 'set SOAK_MINUTES to run the soak');
test.setTimeout((minutes + 6) * 60_000);

test(`M1 soak: ${minutes} min with hidden pages`, async () => {
  const h = await launch();
  try {
    await acceptConsentAndCamera(h);
    const watched = await h.context.newPage();
    await watched.goto('data:text/html,<title>Watched</title><h1>watched page</h1>');
    expect((await h.send({ type: 'arm', source: { kind: 'camera', label: 'Fake camera' } })).ok).toBe(true);
    // Bring an unrelated page to the front so every extension page and the watched page are hidden.
    const cover = await h.context.newPage();
    await cover.goto('data:text/html,<title>Cover</title><h1>cover</h1>');
    await cover.bringToFront();
    const samples: { atMin: number; ticks: number; fraction: number; maxGapMs: number; maxMissed: number }[] = [];
    const started = Date.now();
    while (Date.now() - started < minutes * 60_000) {
      await new Promise((r) => setTimeout(r, 60_000));
      const s = (await h.send<DebugStats>({ type: 'debug-stats' })).value?.stats;
      if (s) samples.push({ atMin: Math.round((Date.now() - started) / 60_000), ticks: s.ticks, fraction: s.fractionWithinOneSecond, maxGapMs: s.maxGapMs, maxMissed: s.maxConsecutiveMissed });
    }
    const final = await waitFor(() => h.send<DebugStats>({ type: 'debug-stats' }).then((r) => r.value!), (v) => v.stats !== null, 10_000);
    const st = final.stats!;
    const report = {
      milestone: 'M1',
      test: 'soak',
      minutes,
      chromium: h.context.browser()?.version() ?? 'persistent context',
      headless: process.env['HEADED'] !== '1',
      intervalMs: st.intervalMs,
      ticks: st.ticks,
      fractionWithinOneSecond: st.fractionWithinOneSecond,
      maxGapMs: st.maxGapMs,
      maxConsecutiveMissed: st.maxConsecutiveMissed,
      pass: st.fractionWithinOneSecond >= 0.95 && st.maxConsecutiveMissed <= 1,
      samples,
      finishedAt: new Date().toISOString(),
    };
    const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bench', 'reports', 'm1-soak.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    expect(st.fractionWithinOneSecond).toBeGreaterThanOrEqual(0.95);
    expect(st.maxConsecutiveMissed).toBeLessThanOrEqual(1);
    expect(st.ticks).toBeGreaterThanOrEqual(Math.floor((minutes * 60_000) / st.intervalMs) - 2);
  } finally {
    await h.close();
  }
});
