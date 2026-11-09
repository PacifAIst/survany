// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Viewer source ladder (M5): WebRTC, then LL-HLS over 443. OvenPlayer's own timer stays unarmed
 * (timeoutMaxRetry 0), so this page runs its own 10 s watchdog per source. No retry loop.
 */
import { STREAM_START_BUDGET_MS, VIEWER_SOURCE_WATCHDOG_MS } from '@survey-anything/shared';

export interface LadderSource {
  kind: 'webrtc' | 'llhls';
  url: string;
}

export interface PlayerAdapter {
  /** Starts the source; resolves true once frames are playing, false on error. */
  play(src: LadderSource, signal: AbortSignal): Promise<boolean>;
  stop(): void;
}

export type LadderOutcome = { ok: true; source: LadderSource } | { ok: false; tried: LadderSource['kind'][] };

export function buildSources(webrtc: string, llhls: string | null): LadderSource[] {
  const s: LadderSource[] = [{ kind: 'webrtc', url: webrtc }];
  if (llhls) s.push({ kind: 'llhls', url: llhls });
  return s;
}

export async function runLadder(
  sources: LadderSource[],
  player: PlayerAdapter,
  opts: { live: boolean; liveForMs?: number | null; sleep?: (ms: number) => Promise<void>; watchdogMs?: number; startBudgetMs?: number } = { live: true },
): Promise<LadderOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A viewer that arrives before the stream is playable waits out the rest of the start budget, so an
  // early tap is not a failure. "Live" means ingest was admitted; OME needs a keyframe before playback.
  const budget = opts.startBudgetMs ?? STREAM_START_BUDGET_MS;
  const wait = opts.live ? Math.max(0, budget - (opts.liveForMs ?? budget)) : budget;
  if (wait > 0) await sleep(wait);
  const tried: LadderSource['kind'][] = [];
  for (const src of sources) {
    tried.push(src.kind);
    const ctrl = new AbortController();
    const timer = new Promise<boolean>((resolve) => {
      void sleep(opts.watchdogMs ?? VIEWER_SOURCE_WATCHDOG_MS).then(() => resolve(false));
    });
    const ok = await Promise.race([player.play(src, ctrl.signal).catch(() => false), timer]);
    if (ok) return { ok: true, source: src };
    ctrl.abort();
    player.stop();
  }
  return { ok: false, tried };
}

/** Captures the page's RTCPeerConnections so the selected candidate type can be reported (never an IP). */
export function capturePeerConnections(win: { RTCPeerConnection?: typeof RTCPeerConnection }): RTCPeerConnection[] {
  const seen: RTCPeerConnection[] = [];
  const Orig = win.RTCPeerConnection;
  if (!Orig) return seen;
  const Wrapped = function (this: unknown, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new Orig(...args);
    seen.push(pc);
    return pc;
  } as unknown as typeof RTCPeerConnection;
  Wrapped.prototype = Orig.prototype;
  Object.defineProperty(Wrapped, 'generateCertificate', { value: Orig.generateCertificate.bind(Orig) });
  win.RTCPeerConnection = Wrapped;
  return seen;
}

export async function candidateType(pcs: RTCPeerConnection[]): Promise<'udp' | 'tcp' | 'relay' | 'none'> {
  for (const pc of pcs) {
    const stats = await pc.getStats().catch(() => null);
    if (!stats) continue;
    let localId: string | null = null;
    stats.forEach((r: { type?: string; state?: string; nominated?: boolean; localCandidateId?: string }) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated && r.localCandidateId) localId = r.localCandidateId;
    });
    if (!localId) continue;
    const c = stats.get(localId) as { candidateType?: string; protocol?: string } | undefined;
    if (c?.candidateType === 'relay') return 'relay';
    if (c) return c.protocol === 'tcp' ? 'tcp' : 'udp';
  }
  return 'none';
}
