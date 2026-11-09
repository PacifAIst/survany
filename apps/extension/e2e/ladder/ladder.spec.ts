// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PLAN §9 "UDP-blocked viewer" / §10 "Viewer cannot establish WebRTC", against the real OME, with the
 * viewer's network really firewalled (iptables in the viewer's container, deploy/test/compose.m5-ladder.yml).
 * Port 8090 on Caddy is the live host (443 in production).
 *
 *   1. nothing blocked                         -> WebRTC (UDP)
 *   2. UDP blocked                             -> WebRTC over TCP: ICE-TCP on 10000 or the TcpRelay on 3478
 *   3. + 10000/tcp blocked                     -> WebRTC through OME's TcpRelay on 3478
 *   4. + 3478/tcp blocked                      -> LL-HLS over the live host
 *   5. + the live host blocked                 -> "live view unavailable", the viewer reports once, and the
 *      backend sends that contact the clip exactly once on every configured channel (Telegram and email),
 *      idempotent on event_id + contact + channel + clip: a replayed report sends nothing more. No retry loop.
 * Writes bench/reports/m5-ladder.json.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, expect, type Page, test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const compose = join(repo, 'deploy', 'test', 'compose.m5-ladder.yml');
const BACKEND = 'http://localhost:18089';
const MAILPIT = 'http://localhost:18026';
const TELEGRAM = 'http://localhost:18183';
const SECRET = 'whsec_test_not_real';
const VIEWER_TG = 333;
const PIN = '246810';
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), ome: 'airensoft/ovenmediaengine:v0.21.0', browser: 'Google Chrome in a container (Playwright 1.64.1 run-server)', steps: {} };
const steps = evidence['steps'] as Record<string, unknown>;

function dc(...args: string[]): string {
  return execFileSync('docker', ['compose', '-f', compose, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function until<T>(fn: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function api<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const r = await fetch(`${BACKEND}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as T };
}

function sql<T>(query: string, ...params: string[]): T[] {
  const js = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/survey-anything.db');console.log(JSON.stringify(db.prepare(${JSON.stringify(query)}).all(...${JSON.stringify(params)})))`;
  return JSON.parse(dc('exec', '-T', 'backend', 'node', '--disable-warning=ExperimentalWarning', '-e', js).trim()) as T[];
}

/** Replaces the viewer container's outbound rules. Loopback (Docker's DNS) always stays open. */
function firewall(block: { udp?: boolean; tcp10000?: boolean; tcp3478?: boolean; liveHost?: boolean }): void {
  const rules = ['iptables -F OUTPUT', 'iptables -A OUTPUT -o lo -j ACCEPT'];
  if (block.udp) rules.push('iptables -A OUTPUT -p udp -j DROP');
  if (block.tcp10000) rules.push('iptables -A OUTPUT -p tcp --dport 10000 -j DROP');
  if (block.tcp3478) rules.push('iptables -A OUTPUT -p tcp --dport 3478 -j DROP');
  if (block.liveHost) rules.push('iptables -A OUTPUT -p tcp --dport 8090 -j DROP');
  dc('exec', '-T', 'viewer', 'sh', '-c', rules.join(' && '));
}

let device = '';
let publisherBrowser: Browser;
let viewerBrowser: Browser;
let publisherPage: Page | null = null;

/** Each test container runs Google Chrome as a Playwright browser server; its flags are set in compose. */
const remote = (port: number) => chromium.connect(`ws://localhost:${port}/pw`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(20 * 60_000);
  dc('down', '-v', '--remove-orphans');
  dc('up', '-d', '--build');
  await until(async () => ((await fetch(`${BACKEND}/healthz`)).ok ? true : undefined), 180_000, 'backend health');
  const code = /code: ([A-Z2-9]{8})/.exec(dc('exec', '-T', 'backend', 'node', '--disable-warning=ExperimentalWarning', 'dist/cli.js', 'pair-device'))![1]!;
  device = (await api<{ deviceToken: string }>('/api/pair/device', { code, name: 'ladder' })).json.deviceToken;
  const auth = { authorization: `Bearer ${device}` };
  // One viewer contact on both channels: Telegram (paired by /start) and email (with a PIN for the viewer page).
  const inv = await api<{ telegramLink: string; pinSetupLink: string }>('/api/contacts', { contactId: 'viewerA', roles: ['viewer'], email: 'viewer-a@ladder.test', channels: ['telegram', 'email'] }, auth);
  expect(inv.status).toBe(200);
  expect((await api('/api/pin/setup', { token: new URL(inv.json.pinSetupLink).searchParams.get('t'), pin: PIN })).status).toBe(200);
  await api('/telegram/webhook', { update_id: 1, message: { message_id: 1, from: { id: VIEWER_TG }, chat: { id: VIEWER_TG, type: 'private' }, text: `/start ${new URL(inv.json.telegramLink).searchParams.get('start')}` } }, { 'x-telegram-bot-api-secret-token': SECRET });
  await api('/api/contacts', { contactId: 'owner', roles: ['viewer', 'approver'], email: 'owner@ladder.test', channels: ['email'] }, auth);
  publisherBrowser = await until(() => remote(13101), 120_000, 'publisher browser server');
  viewerBrowser = await until(() => remote(13102), 120_000, 'viewer browser server');
});

test.afterAll(async () => {
  await publisherBrowser?.close().catch(() => undefined);
  await viewerBrowser?.close().catch(() => undefined);
  const out = join(repo, 'bench', 'reports', 'm5-ladder.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...evidence, finishedAt: new Date().toISOString() }, null, 2) + '\n');
  if (process.env['KEEP_STACK'] !== '1') dc('down', '-v', '--remove-orphans');
});

/** A new live event for viewerA on both channels, with the fake camera publishing over WHIP (H.264 preferred). */
async function liveEvent(): Promise<string> {
  const eventId = randomUUID();
  const r = await api<{ stream: { whipUrl: string } }>(
    '/api/events',
    { eventId, rule: 'fire', ruleTitle: 'Fire or smoke', severity: 'critical', confirmed: true, unconfirmedReason: null, confidence: 0.9, provider: 'local', reason: 'Flames near the stove', timestamp: new Date().toISOString(), sourceLabel: 'Ladder camera', recipients: ['viewerA'], channels: ['telegram', 'email'], snapshotJpegB64: null, wantLiveView: true, ackTimeoutSec: 300, streamTtlMinutes: 10 },
    { authorization: `Bearer ${device}` },
  );
  expect(r.status).toBe(200);
  await publisherPage?.close().catch(() => undefined);
  publisherPage = await publisherBrowser.newPage();
  await publisherPage.goto('http://backend:8080/healthz');
  const state = await publisherPage.evaluate(async (url) => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const pc = new RTCPeerConnection();
    const tr = pc.addTransceiver(stream.getVideoTracks()[0]!, { direction: 'sendonly' });
    const caps = RTCRtpSender.getCapabilities('video');
    const h264 = caps?.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264') ?? [];
    if (h264.length) tr.setCodecPreferences([...h264, ...(caps?.codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264') ?? [])]);
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((res) => {
      if (pc.iceGatheringState === 'complete') res();
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res());
      setTimeout(res, 3000);
    });
    const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription!.sdp });
    if (resp.status !== 201 && resp.status !== 200) return `refused ${resp.status}`;
    await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() });
    return new Promise<string>((res) => {
      const t = setTimeout(() => res(pc.connectionState), 20_000);
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected' || pc.connectionState === 'failed') {
          clearTimeout(t);
          res(pc.connectionState);
        }
      });
    });
  }, r.json.stream.whipUrl);
  expect(state).toBe('connected');
  // A clip for the §10 failure path (the extension uploads one for every alerted event).
  const clip = await fetch(`${BACKEND}/api/events/${eventId}/clip`, { method: 'POST', headers: { authorization: `Bearer ${device}`, 'content-type': 'video/webm' }, body: Buffer.from('ladder-test-clip-bytes') });
  expect(clip.status).toBe(200);
  return eventId;
}

async function emailLink(eventId: string): Promise<string> {
  return until(async () => {
    const list = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:viewer-a@ladder.test')}`)).json()) as { messages: { ID: string }[] };
    for (const m of list.messages ?? []) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as { HTML: string };
      const link = /http:\/\/caddy:8089\/v\/\?t=[^"]+/.exec(msg.HTML)?.[0]?.replace(/&amp;/g, '&');
      if (link?.includes(eventId)) return link;
    }
    return undefined;
  }, 30_000, 'viewer link email');
}

interface ViewResult {
  status: string;
  network: string[];
  reports: { candidateType: string; failed: boolean; playToken: string }[];
  signalingAttempts: number;
  video: { w: number; h: number } | null;
}

async function view(eventId: string): Promise<ViewResult> {
  const link = await emailLink(eventId);
  const page = await viewerBrowser.newPage();
  const reports: ViewResult['reports'] = [];
  let signalingAttempts = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/viewer/report') && r.method() === 'POST') reports.push(JSON.parse(r.postData() ?? '{}') as ViewResult['reports'][number]);
  });
  const network: string[] = [];
  const tok = (u: string) => u.replace(/[A-Za-z0-9_-]{43}/g, '<tok>');
  page.on('websocket', (ws) => {
    signalingAttempts++;
    network.push(`ws ${tok(ws.url())}`);
  });
  page.on('response', (r) => {
    if (/\.(m3u8|m4s|mp4|aac)|llhls|playlist|chunklist/.test(r.url()) || r.status() >= 400) network.push(`${r.status()} ${r.request().method()} ${tok(r.url())}`);
  });
  page.on('requestfailed', (r) => network.push(`failed ${tok(r.url())} ${r.failure()?.errorText ?? ''}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') network.push(`console ${m.type()}: ${m.text().slice(0, 200)}`);
  });
  await page.goto(link);
  await page.fill('#pin', PIN);
  await page.click('button[type=submit]');
  const status = await until(async () => {
    const t = (await page.locator('#status').textContent()) ?? '';
    return /Live \(|unavailable/.test(t) ? t : undefined;
  }, 90_000, 'viewer outcome');
  await page.waitForTimeout(3000); // the success report is sent after playback starts; give it a moment
  const video = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v && v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight } : null;
  });
  await page.close();
  return { status, reports, signalingAttempts, video, network };
}

test('1. nothing blocked: WebRTC over UDP', async () => {
  firewall({});
  const r = await view(await liveEvent());
  steps['1-open'] = { status: r.status, candidate: r.reports[0]?.candidateType ?? null, video: r.video };
  expect(r.status).toContain('Live (WebRTC)');
  expect(r.reports[0]?.candidateType).toBe('udp');
});

// §9: "connects within 10 s over ICE-TCP on 10000 or OME's TcpRelay on 3478, and getStats() shows that
// path". Within 10 s by construction: the viewer's own watchdog moves to LL-HLS after 10 s per source.
test('2. UDP blocked: WebRTC over TCP (ICE-TCP on 10000 or the TcpRelay on 3478)', async () => {
  firewall({ udp: true });
  const r = await view(await liveEvent());
  steps['2-udp-blocked'] = { status: r.status, candidate: r.reports[0]?.candidateType ?? null, video: r.video };
  expect(r.status).toContain('Live (WebRTC)');
  expect(['tcp', 'relay']).toContain(r.reports[0]?.candidateType);
});

test('3. UDP and 10000/tcp blocked: WebRTC through OME TcpRelay on 3478', async () => {
  firewall({ udp: true, tcp10000: true });
  const r = await view(await liveEvent());
  steps['3-udp-and-10000-blocked'] = { status: r.status, candidate: r.reports[0]?.candidateType ?? null, video: r.video };
  expect(r.status).toContain('Live (WebRTC)');
  expect(r.reports[0]?.candidateType).toBe('relay');
});

test('4. UDP, 10000/tcp and 3478/tcp blocked: LL-HLS over the live host', async () => {
  firewall({ udp: true, tcp10000: true, tcp3478: true });
  const r = await view(await liveEvent());
  steps['4-only-https'] = { status: r.status, video: r.video, reports: r.reports.map((x) => ({ candidateType: x.candidateType, failed: x.failed })), network: r.network };
  expect(r.status).toContain('Live (LL-HLS)');
  expect(r.video?.w ?? 0).toBeGreaterThan(0);
  // The chunklists live under the internal stream id (admission's new_url). Knowing it must not be enough:
  // the master playlist by stream id meets forward_auth, and a chunklist needs OME's per-session id.
  const streamId = r.network.map((l) => /\/app\/([0-9a-f-]{36})\//.exec(l)?.[1]).find(Boolean);
  expect(streamId).toBeTruthy();
  const get = (path: string) => dc('exec', '-T', 'viewer', 'node', '-e', `fetch('http://caddy:8090${path}').then(r=>console.log(r.status)).catch(()=>console.log(0))`).trim();
  const masterByStreamId = get(`/app/${streamId}/llhls.m3u8`);
  const forgedChunklist = get(`/app/${streamId}/chunklist_0_video_1234567890123456789_llhls.m3u8`);
  steps['4-only-https'] = { ...(steps['4-only-https'] as object), masterByStreamId, forgedChunklist };
  expect(masterByStreamId).toBe('403');
  expect(forgedChunklist).not.toBe('200');
});

test('5. the live host blocked too: the viewer reports once, and the clip goes once per channel; a replayed report sends nothing more', async () => {
  firewall({ udp: true, tcp10000: true, tcp3478: true, liveHost: true });
  const eventId = await liveEvent();
  type MailRow = { ID: string; Subject: string; Attachments: number };
  const mails = async () => ((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:viewer-a@ladder.test')}`)).json()) as { messages: MailRow[] }).messages ?? [];
  const before = { tg: ((await (await fetch(`${TELEGRAM}/__calls`)).json()) as unknown[]).length, mail: new Set((await mails()).map((m) => m.ID)) };
  const r = await view(eventId);
  expect(r.status).toContain('Live view unavailable');
  expect(r.reports).toHaveLength(1); // no retry loop
  expect(r.reports[0]?.failed).toBe(true);

  const clipRows = () => sql<{ key: string; channel: string; status: string }>("SELECT key, channel, status FROM outbox WHERE event_id = ? AND kind = 'clip' ORDER BY channel", eventId);
  await until(async () => (clipRows().every((x) => x.status === 'sent') && clipRows().length === 2 ? true : undefined), 30_000, 'clip sends');
  const tgClips = async () => ((await (await fetch(`${TELEGRAM}/__calls`)).json()) as { method: string; fields: Record<string, string> }[]).slice(before.tg).filter((c) => (c.method === 'sendDocument' || c.method === 'sendVideo') && c.fields['chat_id'] === String(VIEWER_TG));
  const mailClips = async () => (await mails()).filter((m) => !before.mail.has(m.ID) && m.Attachments > 0 && /recorded clip/i.test(m.Subject));
  expect(clipRows().map((x) => [x.key, x.status])).toEqual([
    [`${eventId}:viewerA:email:clip`, 'sent'],
    [`${eventId}:viewerA:telegram:clip`, 'sent'],
  ]);
  await until(async () => ((await mailClips()).length === 1 ? true : undefined), 20_000, 'clip email');
  expect(await tgClips()).toHaveLength(1);

  // Replay the viewer's report: idempotent on event_id + contact + channel + clip.
  const replay = await api('/api/viewer/report', { playToken: r.reports[0]!.playToken, candidateType: 'none', failed: true });
  expect(replay.status).toBe(200);
  await new Promise((res) => setTimeout(res, 5000));
  expect(clipRows()).toHaveLength(2);
  expect(await tgClips()).toHaveLength(1);
  expect(await mailClips()).toHaveLength(1);
  steps['5-all-blocked'] = {
    status: r.status,
    viewerReports: r.reports.length,
    signalingAttempts: r.signalingAttempts,
    outbox: clipRows().map((x) => x.key.replace(eventId, '<event>')),
    telegramClips: (await tgClips()).length,
    emailClips: (await mailClips()).length,
    afterReplayedReport: { telegramClips: (await tgClips()).length, emailClips: (await mailClips()).length },
  };
});
