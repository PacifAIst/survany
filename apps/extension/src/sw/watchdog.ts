// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Watchdog (C1, §10). chrome.alarms only checks that the Worker loop is alive; it never drives it.
 * Packaged extensions get alarms at most every 30 s, so the period is exactly 0.5 min.
 */
import { processOutbox } from './outbox';
import { buildScanSetup, enabledRecipes, offscreenStatus, recoverSource } from './scan-controller';
import { sendBackendEvent, sendDirectEmail, sendDirectTelegram, uploadClipFromOutbox, type DirectSendPayload } from './dispatch';
import { sendToOffscreen } from './offscreen-host';
import { backendClient } from './runtime';
import * as store from './storage';
import type { EventSubmission, Notice } from '@survey-anything/shared';

export const WATCHDOG_ALARM = 'watchdog';
export const WATCHDOG_PERIOD_MINUTES = 0.5;

export async function ensureWatchdogAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(WATCHDOG_ALARM);
  if (!existing) await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES });
}

export async function drainOutbox(): Promise<void> {
  const r = await processOutbox({
    'backend-event': (p) => sendBackendEvent(p as EventSubmission),
    'backend-clip': (p) => uploadClipFromOutbox(p),
    'backend-notice': async (p) => {
      const b = await backendClient();
      if (!b) throw new Error('backend not paired');
      await b.notice(p as Notice);
    },
    telegram: (p) => sendDirectTelegram(p as DirectSendPayload),
    email: (p) => sendDirectEmail(p as DirectSendPayload),
  });
  if (r.pending > 0) {
    // §10 "All configured channels fail": keep retrying and show a red badge.
    await chrome.action.setBadgeBackgroundColor({ color: '#c0161b' });
    await chrome.action.setBadgeText({ text: '!' });
  } else if (r.sent.length > 0) {
    const armed = await store.get('armed');
    const streaming = await store.get('streaming');
    if (!streaming) await chrome.action.setBadgeText({ text: armed.armed ? 'ON' : '' });
  }
}

export async function runWatchdog(): Promise<void> {
  await drainOutbox().catch((e: unknown) => store.appendLog(`outbox: ${e instanceof Error ? e.message : String(e)}`));
  const armed = await store.get('armed');
  if (!armed.armed) return;
  const status = await offscreenStatus();
  if (!status || !status.running) {
    await recoverSource(status ? 'capture stopped' : 'offscreen document lost');
    return;
  }
  const { config } = await store.loadConfig();
  const interval = config?.vision.scanIntervalMs ?? 5000;
  const last = status.stats?.lastTickAt ?? null;
  if (last !== null && Date.now() - last > 3 * interval + 10_000) {
    await store.appendLog(`watchdog: scan loop stalled for ${Date.now() - last} ms; restarting the timer`);
    if (config) {
      await sendToOffscreen({ target: 'offscreen', type: 'update', setup: buildScanSetup(config, await enabledRecipes(config)), clip: null }).catch(() => undefined);
    }
  }
}
