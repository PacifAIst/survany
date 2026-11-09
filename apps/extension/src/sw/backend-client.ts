/** Device-token authenticated client for the T1+ backend (SG-16 is enforced server-side). */
import {
  type ActionProposal,
  type Capabilities,
  CapabilitiesSchema,
  type ContactInviteRequest,
  type ContactStatus,
  type DetectionResult,
  type EventResponse,
  EventResponseSchema,
  type EventSubmission,
  type Heartbeat,
  type Notice,
  PairDeviceResponseSchema,
  type ProxyAnalyzeRequest,
} from '@survey-anything/shared';
import type { z } from 'zod';
import type { FrameKind } from './guarded-fetch';
import type { ClipPayload } from './messages';
import { RetryableError } from './outbox';
import type { GuardedFetch } from './telegram-direct';

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export class BackendClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly gf: GuardedFetch,
  ) {}

  private async request(path: string, init: RequestInit, frames: FrameKind): Promise<Response> {
    let res: Response;
    try {
      res = await this.gf(
        new URL(path, this.base).href,
        { ...init, headers: { authorization: `Bearer ${this.token}`, ...(init.headers as Record<string, string> | undefined) } },
        { purpose: 'backend', frames },
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'EgressBlockedError') throw e;
      throw new RetryableError(`backend unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      throw new RetryableError(`backend HTTP ${res.status}`, Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    if (!res.ok) throw new BackendError(`backend HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, res.status);
    return res;
  }

  private async json<S extends z.ZodTypeAny>(path: string, body: unknown, schema: S, frames: FrameKind = 'none', method = 'POST'): Promise<z.infer<S>> {
    const res = await this.request(
      path,
      method === 'GET' ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      frames,
    );
    return schema.parse(await res.json()) as z.infer<S>;
  }

  static async pair(gf: GuardedFetch, base: string, code: string, name: string): Promise<z.infer<typeof PairDeviceResponseSchema>> {
    const res = await gf(new URL('/api/pair/device', base).href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) }, { purpose: 'backend', frames: 'none' });
    if (!res.ok) throw new BackendError(`pairing failed: HTTP ${res.status}`, res.status);
    return PairDeviceResponseSchema.parse(await res.json());
  }

  postEvent(sub: EventSubmission): Promise<EventResponse> {
    return this.json('/api/events', sub, EventResponseSchema, sub.snapshotJpegB64 ? 'alert-media' : 'none');
  }

  async uploadClip(eventId: string, clip: ClipPayload): Promise<void> {
    const bytes = Uint8Array.from(atob(clip.b64), (c) => c.charCodeAt(0));
    await this.request(`/api/events/${eventId}/clip`, { method: 'POST', headers: { 'content-type': clip.mime }, body: bytes }, 'alert-media');
  }

  async stopStream(eventId: string): Promise<void> {
    await this.request(`/api/events/${eventId}/stop`, { method: 'POST' }, 'none');
  }

  async heartbeat(hb: Heartbeat): Promise<void> {
    await this.request('/api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hb) }, 'none');
  }

  async notice(n: Notice): Promise<void> {
    await this.request('/api/notices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(n) }, 'none');
  }

  capabilities(): Promise<Capabilities> {
    return this.json('/api/capabilities', null, CapabilitiesSchema, 'none', 'GET');
  }

  async probeToken(): Promise<{ whipUrl: string; iceServers: RTCIceServer[] }> {
    const res = await this.request('/api/stream/probe', { method: 'POST' }, 'none');
    return (await res.json()) as { whipUrl: string; iceServers: RTCIceServer[] };
  }

  async reportProbe(candidateType: string): Promise<void> {
    await this.request('/api/stream/probe-result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidateType }) }, 'none');
  }

  async contacts(): Promise<ContactStatus[]> {
    const res = await this.request('/api/contacts', { method: 'GET' }, 'none');
    return (await res.json()) as ContactStatus[];
  }

  async inviteContact(req: ContactInviteRequest): Promise<{ telegramLink: string | null; pinSetupLink: string }> {
    const res = await this.request('/api/contacts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }, 'none');
    return (await res.json()) as { telegramLink: string | null; pinSetupLink: string };
  }

  async testContact(contactId: string): Promise<Record<string, { ok: boolean; error: string | null }>> {
    const res = await this.request(`/api/contacts/${encodeURIComponent(contactId)}/test`, { method: 'POST' }, 'none');
    return (await res.json()) as Record<string, { ok: boolean; error: string | null }>;
  }

  async proxyAnalyze(req: ProxyAnalyzeRequest): Promise<{ result: DetectionResult; usage: { inputTokens: number; outputTokens: number } }> {
    const res = await this.request('/api/proxy/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }, 'provider-frame');
    return (await res.json()) as { result: DetectionResult; usage: { inputTokens: number; outputTokens: number } };
  }

  async proposeAction(p: ActionProposal): Promise<{ status: string }> {
    const res = await this.request('/api/actions/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }, 'none');
    return (await res.json()) as { status: string };
  }
}
