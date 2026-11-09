/**
 * The only module in the extension allowed to call fetch (ESLint enforces this, SG-14).
 *
 * SECURITY-GATE SG-14: allowCloudProviders:false is enforced here, at the network boundary, for every provider call.
 * SECURITY-GATE SG-15: a request that carries frame bytes needs its explicit egress flag, and frame bytes in a request not declared as carrying them are blocked.
 */
import { type Config, isLocalUrl, looksLikeJpegBase64 } from '@survey-anything/shared';

export type FetchPurpose =
  | 'provider' // vision or reasoner model call
  | 'probe' // Test Connection (synthetic image, never captured pixels)
  | 'backend' // T1+ backend API
  | 'telegram-direct' // T0 Telegram Bot API
  | 'email-direct'; // T0 HTTP mail API

export type FrameKind = 'none' | 'alert-media' | 'provider-frame';

export interface GuardContext {
  purpose: FetchPurpose;
  /** What image bytes this request is declared to carry. */
  frames: FrameKind;
}

export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(`blocked by guardedFetch: ${message}`);
    this.name = 'EgressBlockedError';
  }
}

export type PolicyConfig = Pick<Config, 'allowCloudProviders' | 'egress' | 'proxyMode' | 'backend'>;

const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function bodyCarriesImage(body: BodyInit | null | undefined): boolean {
  if (body === null || body === undefined) return false;
  if (typeof body === 'string') {
    if (body.includes('/9j/') || body.includes('iVBORw0KGgo')) return true; // JPEG or PNG base64
    return false;
  }
  if (body instanceof Blob) return body.type.startsWith('image/') || body.type.startsWith('video/');
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return JPEG_MAGIC.every((b, i) => bytes[i] === b);
  }
  if (body instanceof FormData) {
    for (const [, v] of body.entries()) if (typeof v !== 'string' || looksLikeJpegBase64(v)) return true;
  }
  return false;
}

/** Pure policy decision, exported for tests. Returns null when allowed, otherwise the reason. */
export function egressDecision(url: string, init: RequestInit, ctx: GuardContext, cfg: PolicyConfig): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid URL';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return `scheme ${parsed.protocol} not allowed`;
  const local = isLocalUrl(url);

  if (ctx.purpose === 'provider' && !cfg.allowCloudProviders && !local) {
    return `allowCloudProviders is false and ${parsed.hostname} is not a loopback or RFC 1918 host`;
  }
  if (ctx.purpose === 'provider' && cfg.proxyMode && !(cfg.backend.url && url.startsWith(cfg.backend.url))) {
    return 'proxyMode is on: provider calls must go through the backend';
  }

  const carries = bodyCarriesImage(init.body);
  if (carries && ctx.frames === 'none') return 'request body contains image bytes but was not declared as carrying frames';
  if (ctx.frames === 'alert-media' && !cfg.egress.alertMedia) return 'egress.alertMedia is off: alert snapshots and clips may not leave the machine';
  if (ctx.frames === 'provider-frame' && ctx.purpose !== 'provider' && !(ctx.purpose === 'backend' && cfg.proxyMode)) {
    return 'provider frames may only go to a provider or the proxy backend';
  }
  if (ctx.frames === 'provider-frame' && ctx.purpose === 'backend' && !cfg.allowCloudProviders && !local) {
    return 'allowCloudProviders is false: frames may only reach a loopback proxy backend';
  }
  return null;
}

/**
 * Network boundary for the service worker. `loadPolicy` reads the current config each call,
 * so a toggle takes effect immediately and a service worker restart cannot lose it.
 */
export function createGuardedFetch(loadPolicy: () => Promise<PolicyConfig>) {
  return async function guardedFetch(url: string, init: RequestInit, ctx: GuardContext): Promise<Response> {
    const cfg = await loadPolicy();
    const reason = egressDecision(url, init, ctx, cfg);
    if (reason) throw new EgressBlockedError(reason);
    return fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });
  };
}

const whipOrigins = new Set<string>();

/** Called by the offscreen document only after the service worker passed the SG-13/SG-15 checks for this stream. */
export function allowWhipOrigin(url: string): void {
  whipOrigins.add(new URL(url).origin);
}

/** WHIP signaling: SDP text only, to an origin the service worker approved. Media itself flows over WebRTC. */
export async function whipRequest(url: string, method: 'POST' | 'DELETE', sdp: string): Promise<{ status: number; body: string; location: string | null }> {
  const u = new URL(url);
  if (!whipOrigins.has(u.origin)) throw new EgressBlockedError(`WHIP origin ${u.origin} was not approved by the service worker`);
  if (u.protocol !== 'https:' && !isLocalUrl(u.href)) throw new EgressBlockedError('WHIP requires https outside the local network');
  if (method === 'POST' && !sdp.startsWith('v=0')) throw new EgressBlockedError('WHIP body must be an SDP offer');
  const res = await fetch(u.href, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/sdp' } : {},
    ...(method === 'POST' ? { body: sdp } : {}),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  return { status: res.status, body: await res.text(), location: res.headers.get('location') };
}

/**
 * Reads a file bundled inside the extension package (models, WASM, checksums). Refuses any
 * URL outside the extension's own origin, so it can never become a network path (SG-26).
 */
export async function fetchBundledAsset(url: string, extensionBase: string): Promise<ArrayBuffer> {
  const u = new URL(url);
  const base = new URL(extensionBase);
  // Compare scheme and host explicitly: URL.origin is the opaque string "null" for non-special schemes
  // in some runtimes, which would make every chrome-extension:// origin look equal.
  if (base.protocol !== 'chrome-extension:' || u.protocol !== base.protocol || u.host !== base.host || u.host === '') {
    throw new EgressBlockedError(`asset ${url} is not inside the extension package`);
  }
  const res = await fetch(u.href);
  if (!res.ok) throw new Error(`bundled asset missing: ${u.pathname} (HTTP ${res.status})`);
  return res.arrayBuffer();
}
