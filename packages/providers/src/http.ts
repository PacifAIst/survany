import { PROVIDER_TIMEOUT_MAX_MS } from '@survey-anything/shared';
import { kindForStatus, ProviderError } from './errors';

/** Injected transport. In the extension this is guardedFetch (SG-14); in the backend proxy it is the SSRF-guarded fetch (SG-19). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface JsonResponse {
  status: number;
  body: unknown;
}

export async function postJson(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  providerId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const ms = Math.min(Math.max(timeoutMs, 1000), PROVIDER_TIMEOUT_MAX_MS);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  const onOuterAbort = (): void => ctrl.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch (e) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
    if (timedOut) throw new ProviderError('timeout', `${providerId}: no response within ${ms} ms`, null, providerId);
    if (e instanceof ProviderError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/blocked by guardedFetch/i.test(msg)) throw new ProviderError('blocked', msg, null, providerId);
    throw new ProviderError('network', `${providerId}: ${msg}`, null, providerId);
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    clearTimeout(timer);
    throw new ProviderError(timedOut ? 'timeout' : 'network', `${providerId}: body read failed`, res.status, providerId);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after'));
    throw new ProviderError(
      kindForStatus(res.status),
      `${providerId}: HTTP ${res.status}`,
      res.status,
      providerId,
      Number.isFinite(ra) && ra > 0 ? ra : null,
      text.slice(0, 500),
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError('parse', `${providerId}: response is not JSON`, res.status, providerId);
  }
}
