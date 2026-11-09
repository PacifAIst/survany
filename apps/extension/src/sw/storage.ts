// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * chrome.storage access. The service worker keeps no state in memory (§4.1): everything that
 * must survive a restart lives here. Secrets are a separate key that export never reads.
 * SECURITY-GATE SG-21: storage access is restricted to trusted extension contexts; secrets live under their own key.
 */
import type { Recipe } from '@survey-anything/recipes';
import { type Config, defaultConfigInput, parseConfig } from '@survey-anything/shared';
import type { RulePersist } from './rule-state';
import type { BudgetState } from './budget';
import type { OutboxItem } from './outbox';

export interface ArmedState {
  armed: boolean;
  source: { kind: 'tab'; tabId: number; label: string } | { kind: 'camera'; label: string } | null;
  armedAt: number | null;
}

export interface StreamingState {
  eventId: string;
  recipients: string[];
  since: number;
}

export interface DeviceState {
  deviceId: string;
  tokenRef: string;
  backendUrl: string;
  capabilities: {
    telegram: boolean;
    email: boolean;
    liveView: boolean;
    actions: boolean;
    proxy: boolean;
    publicBaseUrl: string;
    sourceUrl: string;
  };
}

export interface StoreShape {
  config: unknown;
  secrets: Record<string, string>;
  armed: ArmedState;
  rules: Record<string, RulePersist>;
  budget: BudgetState;
  outbox: OutboxItem[];
  consentAt: number | null;
  cameraGranted: boolean;
  device: DeviceState | null;
  streaming: StreamingState | null;
  noticesSentAt: Record<string, number>;
  importedRecipes: Recipe[];
  recentNotices: string[];
  log: string[];
}

const DEFAULTS: { [K in keyof StoreShape]: () => StoreShape[K] } = {
  config: () => defaultConfigInput(),
  secrets: () => ({}),
  armed: () => ({ armed: false, source: null, armedAt: null }),
  rules: () => ({}),
  budget: () => ({ day: '', dayCalls: 0, dayTokens: 0, minute: [], noticeDay: null, freeDayCalls: 0 }),
  outbox: () => [],
  consentAt: () => null,
  cameraGranted: () => false,
  device: () => null,
  streaming: () => null,
  noticesSentAt: () => ({}),
  importedRecipes: () => [],
  recentNotices: () => [],
  log: () => [],
};

export async function get<K extends keyof StoreShape>(key: K): Promise<StoreShape[K]> {
  const r = await chrome.storage.local.get(key);
  return (r[key] as StoreShape[K] | undefined) ?? DEFAULTS[key]();
}

export async function set<K extends keyof StoreShape>(key: K, value: StoreShape[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

const keyLocks = new Map<string, Promise<unknown>>();

/**
 * Read-modify-write, serialized per key. Without this, two messages handled concurrently (two
 * rules firing together, two log lines) would each read the old value and one write would be lost.
 * The service worker is the only writer of these keys, so an in-instance lock is sufficient.
 */
export function update<K extends keyof StoreShape>(key: K, fn: (v: StoreShape[K]) => StoreShape[K]): Promise<StoreShape[K]> {
  const prev = keyLocks.get(key) ?? Promise.resolve();
  const run = prev.then(async () => {
    const next = fn(await get(key));
    await set(key, next);
    return next;
  });
  keyLocks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

export async function loadConfig(): Promise<{ config: Config | null; errors: string[] }> {
  const raw = await get('config');
  const r = parseConfig(raw);
  return r.ok ? { config: r.config, errors: [] } : { config: null, errors: r.errors };
}

export async function secret(ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  return (await get('secrets'))[ref] ?? null;
}

export async function restrictStorageAccess(): Promise<void> {
  await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => undefined);
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function appendLog(line: string): Promise<void> {
  await update('log', (l) => [...l.slice(-199), `${new Date().toISOString()} ${line}`]);
}
