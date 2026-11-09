// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Heartbeat to the backend (C19): after 3 missed heartbeats the backend sends the dead-man alert.
 * 0.5 min is the shortest alarm period a packaged extension gets (C1).
 */
import { offscreenStatus } from './scan-controller';
import { backendClient } from './runtime';
import * as store from './storage';

export const HEARTBEAT_ALARM = 'heartbeat';
export const HEARTBEAT_PERIOD_MINUTES = 0.5;

export async function ensureHeartbeatAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
  if (!existing) await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });
}

export async function sendHeartbeat(): Promise<void> {
  const backend = await backendClient();
  if (!backend) return;
  const armed = await store.get('armed');
  const status = armed.armed ? await offscreenStatus() : null;
  const last = status?.stats?.lastTickAt ?? null;
  await backend.heartbeat({
    armed: armed.armed && (status?.running ?? false),
    sourceKind: armed.source?.kind ?? null,
    sourceLabel: (armed.source?.label ?? '').slice(0, 200),
    lastTickAt: last ? new Date(last).toISOString() : null,
  });
}
