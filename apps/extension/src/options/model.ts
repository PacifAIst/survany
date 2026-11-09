/** Pure helpers for the Options page, unit-tested without a browser. */
import { assertNoEmbeddedSecrets, parseConfig, type Config } from '@survey-anything/shared';

export type Draft = Record<string, unknown>;

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export function setPath<T extends Draft>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const clone: Draft = structuredClone(obj);
  let cur: Draft = clone;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (!next || typeof next !== 'object') cur[k] = {};
    cur = cur[k] as Draft;
  }
  const last = keys[keys.length - 1];
  if (last !== undefined) cur[last] = value;
  return clone as T;
}

/**
 * Toggling a channel: removing one so a single channel remains requires the one-time
 * "alerts will not be redundant" acknowledgement (§6.2). Removing the last is refused (min(1)).
 */
export function toggleChannel(draft: Draft, channel: 'telegram' | 'email', on: boolean, acknowledged: boolean): { draft: Draft; needsAck: boolean; refused: string | null } {
  const channels = new Set((getPath(draft, 'alerts.channels') as string[] | undefined) ?? []);
  if (on) channels.add(channel);
  else channels.delete(channel);
  if (channels.size === 0) return { draft, needsAck: false, refused: 'At least one alert channel is required.' };
  const list = (['telegram', 'email'] as const).filter((c) => channels.has(c));
  if (list.length === 1 && !acknowledged && getPath(draft, 'alerts.nonRedundantAck') !== true) return { draft, needsAck: true, refused: null };
  let next = setPath(draft, 'alerts.channels', list);
  if (list.length === 1) next = setPath(next, 'alerts.nonRedundantAck', true);
  return { draft: next, needsAck: false, refused: null };
}

/** Import re-runs validation (§6.2) and never accepts embedded keys (SG-21). */
export function importConfigJson(text: string): { ok: true; config: Config; raw: Draft } | { ok: false; errors: string[] } {
  try {
    assertNoEmbeddedSecrets(text);
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['not valid JSON'] };
  }
  const r = parseConfig(raw);
  return r.ok ? { ok: true, config: r.config, raw: raw as Draft } : { ok: false, errors: r.errors };
}

export function moveInList<T>(list: T[], index: number, delta: number): T[] {
  const j = index + delta;
  if (j < 0 || j >= list.length) return list;
  const copy = [...list];
  const [item] = copy.splice(index, 1);
  if (item !== undefined) copy.splice(j, 0, item);
  return copy;
}

export function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}
