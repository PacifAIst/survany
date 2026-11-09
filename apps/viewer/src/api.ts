// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** Backend calls from the viewer. One attempt each, never a retry loop (§10). */

export type ApiResult<T> = { kind: 'ok'; value: T } | { kind: 'rejected'; status: number; reason: string } | { kind: 'unavailable' };

export async function post<T>(path: string, body: unknown, timeoutMs = 8000): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: 'unavailable' };
  }
  if (res.status >= 500 || res.status === 404) return { kind: 'unavailable' };
  const data = (await res.json().catch(() => null)) as (T & { reason?: string }) | null;
  if (!res.ok || !data) return { kind: 'rejected', status: res.status, reason: data?.reason ?? `HTTP ${res.status}` };
  return { kind: 'ok', value: data };
}

export interface Grant {
  ok: true;
  meta: { eventId: string; rule: string; severity: 'info' | 'warning' | 'critical'; timestamp: string; title: string } | null;
  live: boolean;
  liveForMs: number | null;
  expiresAt: string;
  sources: { webrtc: string; llhls: string | null };
  playToken: string;
}

export interface ViewerConfig {
  ownerContact?: string;
  ownerName?: string;
}

export async function loadViewerConfig(): Promise<ViewerConfig> {
  try {
    const r = await fetch('viewer-config.json', { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) return {};
    const j = (await r.json()) as ViewerConfig;
    return { ...(typeof j.ownerContact === 'string' ? { ownerContact: j.ownerContact.slice(0, 120) } : {}), ...(typeof j.ownerName === 'string' ? { ownerName: j.ownerName.slice(0, 60) } : {}) };
  } catch {
    return {};
  }
}
