// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Offscreen document (§4.1): owns the MediaStream, frame grabbing, clip recorders and the WHIP
 * publisher. Only chrome.runtime is available here (S4); everything else goes through the SW.
 * On Firefox the same page runs as the pinned monitor tab (sw/offscreen-host.ts), so it also shows
 * what it is doing and can be closed by the person watching.
 */
import { allowWhipOrigin, fetchBundledAsset } from '../sw/guarded-fetch';
import type { ClipPayload, FromOffscreen, OffscreenStatus, SourceSpec, ToOffscreen } from '../sw/messages';
import type { ChecksumEntry } from '../worker/detector';
import type { MainToWorker, ScanSetup, TickStats, WorkerToMain } from '../worker/protocol';
import { ClipRecorders } from './clip-recorders';
import { openCameraSource } from './source-camera';
import { openDisplaySource } from './source-display';
import { openTabSource } from './source-tab';
import { blackProbeTrack, WhipPublisher } from './whip-publisher';

interface MediaStreamTrackProcessorCtor {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> };
}
interface ImageCaptureCtor {
  new (track: MediaStreamTrack): { grabFrame(): Promise<ImageBitmap> };
}

const g = globalThis as unknown as { MediaStreamTrackProcessor?: MediaStreamTrackProcessorCtor; ImageCapture?: ImageCaptureCtor };

let worker: Worker | null = null;
let stream: MediaStream | null = null;
let source: SourceSpec | null = null;
let clips: ClipRecorders | null = null;
let publisher: WhipPublisher | null = null;
let whipState: OffscreenStatus['whip'] = 'idle';
/** Fallback frame grabber when the worker cannot read the track itself (ImageCapture, or a <video> on Firefox). */
let grabFrame: (() => Promise<ImageBitmap>) | null = null;
let video: HTMLVideoElement | null = null;
let statsSeq = 0;
const statsWaiters = new Map<number, (s: TickStats) => void>();
let checksums: ChecksumEntry[] | null = null;

/** The visible state on Firefox's monitor tab (invisible in Chrome's offscreen document). */
function showState(text: string, watching: boolean): void {
  const el = document.getElementById('state');
  if (el) el.textContent = text;
  document.title = watching ? '● Watching · Survey Anything' : 'Survey Anything';
}

function toSw(msg: FromOffscreen): void {
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  toSw({ target: 'sw', type: 'log', level, msg });
}

async function loadChecksums(): Promise<ChecksumEntry[]> {
  if (checksums) return checksums;
  const base = chrome.runtime.getURL('/');
  try {
    const buf = await fetchBundledAsset(new URL('checksums.json', base).href, base);
    const parsed = JSON.parse(new TextDecoder().decode(buf)) as { files: ChecksumEntry[] };
    checksums = parsed.files;
  } catch (e) {
    log('warn', `checksums.json unavailable (${e instanceof Error ? e.message : String(e)}); detectors will not load`);
    checksums = [];
  }
  return checksums;
}

function onWorkerMessage(ev: MessageEvent<WorkerToMain>): void {
  const m = ev.data;
  switch (m.type) {
    case 'need-frame':
      void grabFallbackFrame();
      break;
    case 'candidate':
    case 'still-hot':
      toSw({ target: 'sw', type: m.type, rule: m.rule, confirmImageB64: m.confirmImageB64, snapshotB64: m.snapshotB64, framesPerCheck: m.framesPerCheck, gate: m.gate });
      break;
    case 'clear':
      toSw({ target: 'sw', type: 'clear', rule: m.rule });
      break;
    case 'source-health':
      toSw({ target: 'sw', type: 'source-health', state: m.state });
      break;
    case 'stats':
      statsWaiters.get(m.id)?.(m.stats);
      statsWaiters.delete(m.id);
      break;
    case 'log':
      log(m.level, `[worker] ${m.msg}`);
      break;
  }
}

async function grabFallbackFrame(): Promise<void> {
  const w = worker;
  if (!w) return;
  try {
    if (!grabFrame) throw new Error('no frame grabber');
    const bitmap = await grabFrame();
    const msg: MainToWorker = { type: 'frame', bitmap, capturedAt: Date.now() };
    w.postMessage(msg, [bitmap]);
  } catch {
    w.postMessage({ type: 'no-frame' } satisfies MainToWorker);
  }
}

function attachFrames(track: MediaStreamTrack): void {
  const w = worker;
  if (!w) return;
  // Prefer MediaStreamTrackProcessor; fall back to ImageCapture (M1).
  if (g.MediaStreamTrackProcessor) {
    try {
      const processor = new g.MediaStreamTrackProcessor({ track, maxBufferSize: 2 });
      w.postMessage({ type: 'frames', readable: processor.readable } satisfies MainToWorker, [processor.readable as unknown as Transferable]);
      log('info', 'frame source: MediaStreamTrackProcessor');
      return;
    } catch (e) {
      log('warn', `MediaStreamTrackProcessor unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (g.ImageCapture) {
    const ic = new g.ImageCapture(track);
    grabFrame = () => ic.grabFrame();
    log('info', 'frame source: ImageCapture fallback');
    return;
  }
  // Firefox has neither: play the stream in a muted <video> and copy its current frame on request.
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = new MediaStream([track]);
  void v.play().catch((e: unknown) => log('warn', `video element did not start: ${e instanceof Error ? e.message : String(e)}`));
  video = v;
  grabFrame = async () => {
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || v.videoWidth === 0) throw new Error('no frame yet');
    return createImageBitmap(v);
  };
  log('info', 'frame source: video element fallback');
}

/** Start, stop and close run one at a time: overlapping starts would stop each other's stream. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function start(src: SourceSpec, setup: ScanSetup, clip: { seconds: number; videoBitsPerSecond: number } | null): Promise<void> {
  await stop();
  source = src;
  if (src.kind === 'display') showState('Click the button to choose the window or screen to watch.', false);
  const pick = document.getElementById('pick') as HTMLButtonElement | null;
  const opened =
    src.kind === 'tab'
      ? await openTabSource(src.streamId)
      : src.kind === 'display'
        ? pick
          ? await openDisplaySource(pick)
          : await Promise.reject(new Error('this page cannot ask for a window or screen'))
        : await openCameraSource(src.deviceId);
  stream = opened;
  const track = opened.getVideoTracks()[0];
  if (!track) throw new Error('source produced no video track');
  track.addEventListener('ended', () => toSw({ target: 'sw', type: 'source-ended', reason: 'track ended' }));
  worker = new Worker(new URL('../worker/scan.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => log('error', `worker error: ${e.message}`);
  worker.postMessage({ type: 'init', assetBase: chrome.runtime.getURL('/'), checksums: await loadChecksums(), setup } satisfies MainToWorker);
  attachFrames(track);
  if (clip) {
    clips = new ClipRecorders(opened, clip);
    clips.start();
  }
  // Name the device, so a person can see when the wrong camera (for example a virtual one) is in use.
  if (src.kind === 'camera') log('info', `camera in use: ${track.label || 'unnamed device'}`);
  showState(`Watching: ${src.label}${src.kind === 'camera' && track.label ? ` (${track.label})` : ''}.`, true);
}

async function stop(): Promise<void> {
  await publisher?.stop().catch(() => undefined);
  publisher = null;
  whipState = 'idle';
  clips?.stop();
  clips = null;
  worker?.postMessage({ type: 'stop' } satisfies MainToWorker);
  worker?.terminate();
  worker = null;
  grabFrame = null;
  if (video) video.srcObject = null;
  video = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  source = null;
  showState('Not watching. You can close this tab.', false);
}

/** Firefox monitor tab: this page's own tab, or null in Chrome's offscreen document. */
async function ownTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = (chrome as { tabs?: typeof chrome.tabs }).tabs;
  if (!tabs?.getCurrent) return null;
  return (await tabs.getCurrent()) ?? null;
}

async function status(): Promise<OffscreenStatus> {
  let stats: TickStats | null = null;
  const w = worker;
  if (w) {
    const id = ++statsSeq;
    stats = await new Promise<TickStats | null>((resolve) => {
      const t = setTimeout(() => {
        statsWaiters.delete(id);
        resolve(null);
      }, 2000);
      statsWaiters.set(id, (s) => {
        clearTimeout(t);
        resolve(s);
      });
      w.postMessage({ type: 'stats', id } satisfies MainToWorker);
    });
  }
  return { running: stream !== null, source: source ? { kind: source.kind, label: source.label } : null, stats, whip: whipState };
}

async function whipStart(url: string, iceServers: RTCIceServer[]): Promise<void> {
  const track = stream?.getVideoTracks()[0];
  if (!track) throw new Error('not armed');
  await publisher?.stop();
  allowWhipOrigin(url);
  publisher = new WhipPublisher(track);
  whipState = 'connecting';
  toSw({ target: 'sw', type: 'whip-state', state: 'connecting', detail: '' });
  try {
    await publisher.start(url, iceServers, (s) => {
      if (s === 'connected') {
        whipState = 'live';
        toSw({ target: 'sw', type: 'whip-state', state: 'live', detail: publisher?.h264 ? 'h264' : 'vp8' });
      } else if (s === 'failed' || s === 'closed') {
        whipState = s === 'failed' ? 'failed' : 'idle';
        toSw({ target: 'sw', type: 'whip-state', state: s, detail: '' });
      }
    });
  } catch (e) {
    whipState = 'failed';
    toSw({ target: 'sw', type: 'whip-state', state: 'failed', detail: e instanceof Error ? e.message : String(e) });
  }
}

async function whipProbe(url: string, iceServers: RTCIceServer[]): Promise<{ candidateType: string }> {
  allowWhipOrigin(url);
  const probe = blackProbeTrack();
  const p = new WhipPublisher(probe.track);
  try {
    let connected = false;
    await p.start(url, iceServers, (s) => {
      if (s === 'connected') connected = true;
    });
    const deadline = Date.now() + 8000;
    while (!connected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    return { candidateType: connected ? await p.selectedCandidateType() : 'none' };
  } finally {
    await p.stop();
    probe.stop();
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as ToOffscreen;
  if (!msg || msg.target !== 'offscreen' || sender.id !== chrome.runtime.id) return false;
  const reply = (p: Promise<unknown>): true => {
    p.then(
      (v) => sendResponse({ ok: true, value: v }),
      (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  };
  switch (msg.type) {
    case 'start':
      return reply(serial(() => start(msg.source, msg.setup, msg.clip)));
    case 'update':
      worker?.postMessage({ type: 'update', setup: msg.setup } satisfies MainToWorker);
      sendResponse({ ok: true, value: null });
      return false;
    case 'stop':
      return reply(serial(() => stop()));
    case 'status':
      return reply(status());
    case 'get-clip':
      return reply(clips ? clips.latestClip() : Promise.resolve<ClipPayload | null>(null));
    case 'whip-start':
      return reply(whipStart(msg.url, msg.iceServers));
    case 'whip-stop':
      return reply(
        (async () => {
          await publisher?.stop();
          publisher = null;
          whipState = 'idle';
        })(),
      );
    case 'whip-probe':
      return reply(whipProbe(msg.url, msg.iceServers));
    case 'focus':
      return reply(
        (async () => {
          const t = await ownTab();
          if (t?.id !== undefined) await chrome.tabs.update(t.id, { active: true });
          if (t?.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
        })(),
      );
    case 'close':
      return reply(
        serial(async () => {
          await stop();
          const t = await ownTab();
          if (t?.id !== undefined) await chrome.tabs.remove(t.id);
        }),
      );
  }
});

void ownTab()
  .catch(() => null)
  .then((t) => toSw({ target: 'sw', type: 'offscreen-ready', ...(t?.id !== undefined ? { tabId: t.id } : {}) }));
