// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** Pure helpers for the Options page, unit-tested without a browser. */
import { assertNoEmbeddedSecrets, parseConfig, type Config } from '@survey-anything/shared';
import type { LocalDetect } from '../sw/messages';

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

/** One alert channel and the one-time "not redundant" acknowledgement not given yet (§6.2). */
export function needsNonRedundantAck(draft: Draft): boolean {
  const ch = getPath(draft, 'alerts.channels');
  return Array.isArray(ch) && ch.length === 1 && getPath(draft, 'alerts.nonRedundantAck') !== true;
}

export type ImportResult = { ok: true; config: Config; raw: Draft } | { ok: false; errors: string[]; needsAck?: Draft };

/**
 * Import re-runs validation (§6.2) and never accepts embedded keys (SG-21). A single-channel file that
 * is valid except for the missing acknowledgement comes back as `needsAck`, so the page can ask for it
 * once instead of showing a schema error.
 */
export function importConfigJson(text: string): ImportResult {
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
  if (r.ok) return { ok: true, config: r.config, raw: raw as Draft };
  if (raw && typeof raw === 'object' && needsNonRedundantAck(raw as Draft)) {
    const acked = setPath(raw as Draft, 'alerts.nonRedundantAck', true);
    if (parseConfig(acked).ok) return { ok: false, errors: r.errors, needsAck: acked };
  }
  return { ok: false, errors: r.errors };
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

/** "Use as template": the recipe as pretty JSON with an id and title that cannot collide with an existing rule. */
export function recipeTemplate(r: { id: string; title: string } & Record<string, unknown>, takenIds: readonly string[]): string {
  const base = `${r.id}-custom`.slice(0, 44);
  let id = base;
  for (let i = 2; takenIds.includes(id); i++) id = `${base}-${i}`;
  return JSON.stringify({ ...r, id, title: `${r.title} (custom)`.slice(0, 80) }, null, 2);
}

/**
 * Validates a recipe typed or pasted into the editor with the same rules as a file import (SG-18), and
 * refuses a built-in id so a custom copy can never silently replace a built-in rule.
 */
export function checkNewRecipe<R extends { id: string }>(
  text: string,
  builtinIds: readonly string[],
  parse: (t: string) => R,
): { ok: true; recipe: R } | { ok: false; errors: string[] } {
  if (!text.trim()) return { ok: false, errors: ['paste or type a recipe first'] };
  let recipe: R;
  try {
    recipe = parse(text);
  } catch (e) {
    const problems = (e as { problems?: unknown }).problems;
    return { ok: false, errors: Array.isArray(problems) ? problems.map(String) : [e instanceof Error ? e.message : String(e)] };
  }
  if (builtinIds.includes(recipe.id)) return { ok: false, errors: [`id "${recipe.id}" is a built-in rule: choose another id (for example "${recipe.id}-custom")`] };
  return { ok: true, recipe };
}

/**
 * Chooses the Model for the local card from what the server reports (LM Studio says which models can see
 * and which are loaded). Prefers the current model when it fits, then a loaded vision model.
 */
export function pickLocalModel(d: LocalDetect, current: string | null): { model: string | null; ok: boolean; message: string } {
  if (!d.reachable) {
    return {
      model: null,
      ok: false,
      message: `${d.error ?? 'nothing answered'}. LM Studio: Developer tab → Start server (address http://127.0.0.1:1234). Ollama: address http://127.0.0.1:11434.`,
    };
  }
  if (d.server === 'lmstudio') {
    const vision = d.models.filter((m) => m.vision === true);
    const loaded = vision.filter((m) => m.loaded === true);
    const pool = loaded.length > 0 ? loaded : vision;
    const pick = pool.find((m) => m.id === current) ?? pool[0];
    if (!pick) {
      const others = d.models.map((m) => m.id).slice(0, 8);
      return {
        model: null,
        ok: false,
        message: `LM Studio is running but has no model that can see images${others.length ? ` (it has: ${others.join(', ')})` : ''}. In LM Studio, download a vision model (for example search "qwen3-vl"), load it, then press LM Studio again.`,
      };
    }
    const more = vision.filter((m) => m.id !== pick.id).map((m) => m.id);
    return {
      model: pick.id,
      ok: true,
      message: `Model set to ${pick.id}: it can see images${pick.loaded ? ' and is loaded in LM Studio' : ', but is not loaded yet: load it in LM Studio (or turn on just-in-time loading)'}.${more.length ? ` Other vision models: ${more.join(', ')}.` : ''} Now press Test connection, then Save.`,
    };
  }
  const ids = d.models.map((m) => m.id);
  if (current && ids.includes(current)) return { model: current, ok: true, message: `This server has ${current}. Now press Test connection, then Save.` };
  if (ids.length === 0) return { model: null, ok: false, message: 'The server answered but lists no models: load a model that can see images.' };
  return { model: null, ok: false, message: `This server has: ${ids.slice(0, 20).join(', ')}. Put the id of the one that can see images in Model.` };
}
