// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Static metadata render (§4.3 step 7, §10 "Viewer backend unreachable").
 * SECURITY-GATE SG-27: link metadata is validated field by field, rendered with textContent only, labelled "unverified" until the backend confirms the token, and removed if the token is rejected.
 */
import { parseViewerMeta, type ViewerMeta, VIEWER_QUERY_KEYS } from '@survey-anything/shared';

export type MetaState = 'unverified' | 'verified' | 'rejected';

export function readLink(search: string): { token: string | null; meta: Partial<ViewerMeta> } {
  const p = new URLSearchParams(search);
  const all = p.getAll(VIEWER_QUERY_KEYS.token);
  const token = all.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(all[0] ?? '') ? (all[0] as string) : null;
  return { token, meta: parseViewerMeta(p) };
}

const LABELS: [keyof ViewerMeta, string][] = [
  ['rule', 'Rule'],
  ['severity', 'Severity'],
  ['timestamp', 'Time (UTC)'],
  ['eventId', 'Event ID'],
];

/** Renders into `root` using DOM APIs and textContent only; nothing from the URL is parsed as markup. */
export function renderMeta(root: HTMLElement, meta: Partial<ViewerMeta> & { title?: string }, state: MetaState): void {
  root.replaceChildren();
  if (state === 'rejected') return;
  const doc = root.ownerDocument;
  const badge = doc.createElement('p');
  badge.className = state === 'verified' ? 'badge ok' : 'badge warn';
  badge.textContent = state === 'verified' ? 'Verified by the server' : 'Unverified, from this link';
  root.append(badge);
  if (meta.title) {
    const h = doc.createElement('h2');
    h.textContent = meta.title;
    root.append(h);
  }
  const dl = doc.createElement('dl');
  for (const [key, label] of LABELS) {
    const v = meta[key];
    if (v === undefined) continue;
    const dt = doc.createElement('dt');
    dt.textContent = label;
    const dd = doc.createElement('dd');
    dd.textContent = String(v);
    dl.append(dt, dd);
  }
  root.append(dl);
}

export function sessionId(storage: Pick<Storage, 'getItem' | 'setItem'> | null, token: string): string {
  const key = `sa-session-${token.slice(0, 12)}`;
  try {
    const existing = storage?.getItem(key);
    if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
  } catch {
    // storage blocked: a fresh id per load, so reconnects in this tab still work in memory
  }
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try {
    storage?.setItem(key, id);
  } catch {
    // ignore
  }
  return id;
}
