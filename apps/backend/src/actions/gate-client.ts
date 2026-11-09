// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Gate client. The backend is confirm-gate-mcp's paired device; only deterministic backend code
 * talks to the gate, never the model.
 * SECURITY-GATE SG-05: any gate error, timeout or unexpected answer is a denial, and the caller notifies a human.
 */
import { randomBytes } from 'node:crypto';
import { canonicalJson, signedHeaders } from './signer';

export class GateUnavailableError extends Error {}

export interface ProposeResult {
  pendingId: string;
  stage: string;
  preview: unknown;
}

export interface ConfirmResult {
  status: 'done' | 'needs_final_yes' | 'cancelled' | 'refused' | 'failed';
  receipt: unknown;
  reason: string | null;
  /** For needs_final_yes: the gate opens a new card set for the separate final yes (gate.py confirm). */
  nextPendingId: string | null;
}

export interface GateClient {
  propose(tool: string, args: Record<string, unknown>): Promise<ProposeResult>;
  /** Taps "yes" for exactly the action the human saw. The gate's card must still hold `tool` with `expectedArgs`. */
  approve(pendingId: string, tool: string, expectedArgs: Record<string, unknown>): Promise<ConfirmResult>;
  deny(pendingId: string): Promise<void>;
}

export interface GateDevice {
  deviceId: string;
  key: string;
}

/** A card set as GET /device/pending returns it (confirm-gate-mcp 0.8.0, gate.py public_view + nonce). */
interface PendingCard {
  pending_id: string;
  nonce: string;
  stage?: string;
  options?: { n: number; action: string; args: Record<string, unknown>; text?: string; risk?: string }[];
}

export class ConfirmGateClient implements GateClient {
  private rpcId = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly agentToken: string,
    private readonly device: GateDevice,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly nowSec: () => number = () => Date.now() / 1000,
    private readonly timeoutMs = 5000,
  ) {}

  private async http(method: 'GET' | 'POST', path: string, body: unknown, signed: boolean, extra: Record<string, string> = {}): Promise<unknown> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (signed) Object.assign(headers, signedHeaders(this.device.deviceId, this.device.key, method, path, raw, this.nowSec()));
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: raw }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new GateUnavailableError(`gate unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new GateUnavailableError(`gate ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GateUnavailableError(`gate ${path}: response is not JSON`);
    }
  }

  /** Calls the gated upstream tool through the gate's MCP endpoint; the gate holds it as pending. */
  async propose(tool: string, args: Record<string, unknown>): Promise<ProposeResult> {
    const rpc = (await this.http(
      'POST',
      '/mcp',
      { jsonrpc: '2.0', id: ++this.rpcId, method: 'tools/call', params: { name: tool, arguments: args } },
      false,
      { authorization: `Bearer ${this.agentToken}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    )) as { result?: { content?: { type: string; text?: string }[]; structuredContent?: unknown }; error?: { message?: string } };
    if (rpc.error) throw new GateUnavailableError(`gate refused the proposal: ${rpc.error.message ?? 'error'}`);
    let payload: unknown = rpc.result?.structuredContent;
    if (!payload) {
      const text = rpc.result?.content?.find((c) => c.type === 'text')?.text ?? '';
      try {
        payload = JSON.parse(text);
      } catch {
        throw new GateUnavailableError('gate proposal answer is not JSON');
      }
    }
    const p = payload as { status?: string; pending_id?: string; stage?: string; preview?: unknown };
    if (p.status !== 'pending_user_confirmation' || typeof p.pending_id !== 'string') {
      // A gate that executed without holding the call would defeat SG-01: treat as failure.
      throw new GateUnavailableError(`gate did not hold the call (status ${String(p.status)})`);
    }
    return { pendingId: p.pending_id, stage: p.stage ?? 'choose', preview: p.preview ?? null };
  }

  private async card(pendingId: string): Promise<PendingCard> {
    // The gate accepts each signature once and signs the path with its query, so a random query
    // value keeps two reads within the same second from looking like a replay.
    const r = (await this.http('GET', `/device/pending?r=${randomBytes(8).toString('hex')}`, undefined, true)) as { pending?: PendingCard[] };
    const card = r.pending?.find((c) => c.pending_id === pendingId);
    if (!card) throw new GateUnavailableError('pending card not found at the gate (expired or already decided)');
    return card;
  }

  async approve(pendingId: string, tool: string, expectedArgs: Record<string, unknown>): Promise<ConfirmResult> {
    const card = await this.card(pendingId);
    // Re-check at confirm time (§6.5): the gate must hold exactly one option, and it must be the very
    // action and arguments the human approved. Anything else is refused and the card set withdrawn.
    const options = card.options ?? [];
    const only = options.length === 1 ? options[0] : undefined;
    if (!only || only.action !== tool || canonicalJson(only.args ?? {}) !== canonicalJson(expectedArgs)) {
      await this.deny(pendingId).catch(() => undefined);
      return { status: 'refused', receipt: null, reason: 'the action held by the gate differs from the approved card', nextPendingId: null };
    }
    // A "choose" card takes the option number; the separate high-risk "final" card takes yes (gate.py submit_tap).
    const tap = card.stage === 'final' ? { answer: 'yes' } : { option: only.n };
    const ev = (await this.http('POST', '/device/evidence', { pending_id: pendingId, nonce: card.nonce, kind: 'tap', ...tap, input: 'touch' }, true)) as {
      evidence_ref?: string;
      decision?: string;
    };
    if (!ev.evidence_ref) throw new GateUnavailableError('gate returned no evidence reference');
    const c = (await this.http('POST', '/device/confirm', { pending_id: pendingId, evidence_ref: ev.evidence_ref }, true)) as {
      status?: ConfirmResult['status'];
      pending_id?: string;
      receipt?: unknown;
      result?: unknown;
      reason?: string;
      error?: string;
    };
    const status = c.status ?? 'failed';
    return {
      status,
      receipt: c.receipt ?? c.result ?? null,
      reason: c.reason ?? c.error ?? null,
      nextPendingId: status === 'needs_final_yes' && typeof c.pending_id === 'string' ? c.pending_id : null,
    };
  }

  async deny(pendingId: string): Promise<void> {
    const card = await this.card(pendingId);
    await this.http('POST', '/device/evidence', { pending_id: pendingId, nonce: card.nonce, kind: 'tap', answer: 'no', input: 'touch' }, true);
  }

  /** One-time: the operator shows the gate's pairing code to the backend CLI, never to the agent. */
  static async pair(baseUrl: string, code: string, name: string, fetchFn: typeof fetch = fetch): Promise<GateDevice & { userId: string }> {
    const res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/device/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`gate pairing failed: HTTP ${res.status}`);
    const j = (await res.json()) as { device_id: string; user_id: string; key: string };
    return { deviceId: j.device_id, key: j.key, userId: j.user_id };
  }
}
