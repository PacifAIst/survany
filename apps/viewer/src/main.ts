/**
 * Live viewer: Telegram Mini App (initData) or email (PIN). Renders the link's metadata first,
 * with no backend call, so a first view during a backend outage still shows what happened.
 */
import Hls from 'hls.js';
import OvenPlayer from 'ovenplayer';
import { SOURCE_URL } from '@survey-anything/shared';
import { type Grant, loadViewerConfig, post } from './api';
import { buildSources, candidateType, capturePeerConnections, type LadderSource, type PlayerAdapter, runLadder } from './ladder';
import { readLink, renderMeta, sessionId } from './meta';

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData?: string; ready?: () => void; expand?: () => void } };
    Hls?: typeof Hls;
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const pcs = capturePeerConnections(window);
// OvenPlayer looks for a global Hls; it is bundled locally (no CDN, SG-27 CSP).
window.Hls = Hls;

function status(text: string, kind: 'info' | 'error' = 'info'): void {
  const el = $('status');
  el.textContent = text;
  el.className = kind === 'error' ? 'error' : '';
}

async function ownerLine(): Promise<void> {
  const cfg = await loadViewerConfig();
  const el = $('owner');
  el.textContent = cfg.ownerContact ? `Contact the owner${cfg.ownerName ? ` (${cfg.ownerName})` : ''}: ${cfg.ownerContact}` : 'Contact the owner directly.';
}

function inTelegram(): boolean {
  return location.hash.includes('tgWebAppData=');
}

async function loadTelegramScript(): Promise<void> {
  await new Promise<void>((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-web-app.js';
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.append(s);
  });
}

/**
 * LL-HLS: after admission, OME's playlists point at the internal stream name, so every LL-HLS request
 * carries this session's play token as `sa=`; Caddy's forward_auth checks it against the stream (SG-10).
 */
export function withPlayToken(url: string, playToken: string): string {
  const u = new URL(url, location.href);
  u.searchParams.set('sa', playToken);
  return u.href;
}

function makePlayer(playToken: string): PlayerAdapter {
  let player: { remove(): void; on(ev: string, cb: (d?: unknown) => void): void } | null = null;
  return {
    play(src: LadderSource, signal: AbortSignal): Promise<boolean> {
      return new Promise((resolve) => {
        player?.remove();
        const el = document.createElement('div');
        el.id = 'player-el';
        $('player').replaceChildren(el);
        player = OvenPlayer.create('player-el', {
          autoStart: true,
          mute: true,
          autoFallback: true,
          webrtcConfig: { timeoutMaxRetry: 0 },
          hlsConfig: {
            enableWorker: false,
            lowLatencyMode: true,
            // hls.js opens the request before calling this; re-opening with the new URL is its documented way to change it.
            xhrSetup: (xhr: XMLHttpRequest, url: string) => xhr.open('GET', withPlayToken(url, playToken), true),
          },
          sources: [{ type: src.kind === 'webrtc' ? 'webrtc' : 'llhls', file: src.url, label: src.kind }],
        }) as unknown as { remove(): void; on(ev: string, cb: (d?: unknown) => void): void };
        player.on('stateChanged', (d) => {
          if ((d as { newstate?: string } | undefined)?.newstate === 'playing') resolve(true);
        });
        player.on('error', () => resolve(false));
        signal.addEventListener('abort', () => resolve(false), { once: true });
      });
    },
    stop(): void {
      player?.remove();
      player = null;
    },
  };
}

async function start(): Promise<void> {
  $('source').setAttribute('href', SOURCE_URL);
  const { token, meta } = readLink(location.search);
  const metaRoot = $('meta');
  renderMeta(metaRoot, meta, 'unverified');
  if (!token) {
    status('This link is incomplete.', 'error');
    return;
  }
  const sid = sessionId(sessionStorage, token);
  let grant: Awaited<ReturnType<typeof post<Grant>>>;
  if (inTelegram()) {
    await loadTelegramScript();
    window.Telegram?.WebApp?.ready?.();
    window.Telegram?.WebApp?.expand?.();
    const initData = window.Telegram?.WebApp?.initData ?? '';
    status('Checking your Telegram identity…');
    grant = await post<Grant>('/api/viewer/telegram', { token, sessionId: sid, initData });
  } else {
    $('pin-form').hidden = false;
    status('Enter your PIN to open the live view.');
    grant = await new Promise((resolve) => {
      $('pin-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const pin = ($('pin') as HTMLInputElement).value.trim();
        status('Checking…');
        void post<Grant>('/api/viewer/email', { token, sessionId: sid, pin }).then((r) => {
          if (r.kind === 'rejected' && (r.status === 400 || r.reason === 'wrong PIN')) {
            status(r.reason, 'error');
            return;
          }
          $('pin-form').hidden = true;
          resolve(r);
        });
      });
    });
  }
  if (grant.kind === 'unavailable') {
    // §10: the static render is the complete experience. No spinner, no retry loop.
    status('The server is unavailable right now. Live view cannot open.', 'error');
    await ownerLine();
    return;
  }
  if (grant.kind === 'rejected') {
    renderMeta(metaRoot, {}, 'rejected');
    status(`This link cannot be used: ${grant.reason}.`, 'error');
    await ownerLine();
    return;
  }
  const g = grant.value;
  renderMeta(metaRoot, g.meta ? { ...g.meta } : meta, 'verified');
  status(g.live ? 'Connecting…' : 'Waiting for the stream to start…');
  const outcome = await runLadder(buildSources(g.sources.webrtc, g.sources.llhls), makePlayer(g.playToken), { live: g.live, liveForMs: g.liveForMs });
  if (outcome.ok) {
    status(`Live (${outcome.source.kind === 'webrtc' ? 'WebRTC' : 'LL-HLS'}). The link stops working at ${new Date(g.expiresAt).toLocaleTimeString()}.`);
    if (outcome.source.kind === 'webrtc') {
      const ct = await candidateType(pcs);
      void post('/api/viewer/report', { playToken: g.playToken, candidateType: ct, failed: false });
    }
    return;
  }
  // Every source failed: ask the backend to send this contact the recorded clip, once.
  void post('/api/viewer/report', { playToken: g.playToken, candidateType: await candidateType(pcs), failed: true });
  status('Live view unavailable — contact the owner. A recorded clip will be sent to you.', 'error');
  await ownerLine();
}

if ('serviceWorker' in navigator) {
  // Shell-only cache, keyed without the query string (§10); never caches API responses.
  void navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => undefined);
}

void start();
