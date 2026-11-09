import type { ToSw } from '../sw/messages';

type Outgoing = ToSw extends infer T ? (T extends { target: 'sw' } ? Omit<T, 'target'> : never) : never;

/** Sends a message to the service worker and unwraps its {ok, value|error} reply. */
export async function sw<T>(msg: Outgoing): Promise<T> {
  const r = (await chrome.runtime.sendMessage({ target: 'sw', ...msg })) as { ok: boolean; value?: T; error?: string } | undefined;
  if (!r) throw new Error('the extension service worker did not answer');
  if (!r.ok) throw new Error(r.error ?? 'error');
  return r.value as T;
}

export function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

/** Host permissions are optional (C9) and must be requested from a user gesture on a visible page. */
export async function requestHost(url: string): Promise<boolean> {
  const origins = [originPattern(url)];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}
