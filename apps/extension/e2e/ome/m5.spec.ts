// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M5 acceptance against the real, pinned OvenMediaEngine (deploy/test/compose.m5.yml):
 *  - publish over WHIP (through Caddy forward_auth) then view in a real browser (SG-11, SG-12)
 *  - untokened publish refused by OME itself and by forward_auth
 *  - webhook down (backend stopped) and hung: OME denies publish and play
 *  - forward_auth refuses ingest while the backend is stopped (fails closed, S46)
 *  - REST port unreachable from the host; reachable only in-network with the AccessToken (SG-20)
 *  - TcpRelay 3478 reachable from outside the compose network
 * Writes bench/reports/m5-ome.json as evidence.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page, test } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const compose = join(repo, 'deploy', 'test', 'compose.m5.yml');
const BACKEND = 'http://localhost:8088';
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), omeImage: 'airensoft/ovenmediaengine:v0.21.0@sha256:172da912...' };

function dc(...args: string[]): string {
  return execFileSync('docker', ['compose', '-f', compose, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitHttp(url: string, ms = 90_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function tcpOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host, timeout: 2000 }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function api<T>(path: string, body: unknown, token?: string): Promise<{ status: number; json: T }> {
  const r = await fetch(`${BACKEND}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as T };
}

/** Publishes the fake camera from a browser page over WHIP and waits for "connected". */
async function whipPublish(page: Page, url: string, waitConnected = true): Promise<{ status: number; state: string }> {
  return page.evaluate(
    async ({ url, waitConnected }) => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:3478?transport=tcp', username: 'ome', credential: 'airen' }], iceTransportPolicy: 'all' });
      const tr = pc.addTransceiver(stream.getVideoTracks()[0]!, { direction: 'sendonly' });
      const caps = RTCRtpSender.getCapabilities('video');
      const h264 = caps?.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264') ?? [];
      if (h264.length) tr.setCodecPreferences([...h264, ...(caps?.codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/h264') ?? [])]);
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((r) => {
        if (pc.iceGatheringState === 'complete') r();
        pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r());
        setTimeout(r, 3000);
      });
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription!.sdp });
      if (res.status !== 201 && res.status !== 200) return { status: res.status, state: 'refused' };
      await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      if (!waitConnected) return { status: res.status, state: pc.connectionState };
      const state = await new Promise<string>((r) => {
        const t = setTimeout(() => r(pc.connectionState), 20_000);
        pc.addEventListener('connectionstatechange', () => {
          if (pc.connectionState === 'connected' || pc.connectionState === 'failed') {
            clearTimeout(t);
            r(pc.connectionState);
          }
        });
      });
      (window as unknown as { __pc: RTCPeerConnection }).__pc = pc;
      return { status: res.status, state };
    },
    { url, waitConnected },
  );
}

/** A canned SDP offer is enough to tell "admitted" (SDP-level answer or 4xx about SDP) from "refused by admission". */
async function rawWhip(url: string): Promise<number> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: 'v=0\r\n', signal: AbortSignal.timeout(15_000) });
    return r.status;
  } catch {
    return 0;
  }
}

test.describe.configure({ mode: 'serial' });

let deviceToken = '';
let browserApp: Awaited<ReturnType<typeof chromium.launch>>;
let browser: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>;

test.beforeAll(async () => {
  dc('down', '-v', '--remove-orphans');
  dc('up', '-d', '--build');
  await waitHttp(`${BACKEND}/healthz`);
  await waitHttp('http://localhost:8089/v/');
  const out = dc('exec', '-T', 'backend', 'node', '--disable-warning=ExperimentalWarning', 'dist/cli.js', 'pair-device');
  const code = /code: ([A-Z2-9]{8})/.exec(out)?.[1];
  if (!code) throw new Error(`no pairing code in: ${out}`);
  const pair = await api<{ deviceToken: string }>('/api/pair/device', { code, name: 'm5' });
  deviceToken = pair.json.deviceToken;
  // A contact with an email and a PIN, via the real invite and PIN-setup routes.
  const inv = await api<{ pinSetupLink: string }>('/api/contacts', { contactId: 'contactA', roles: ['viewer'], email: 'a@m5.test', channels: ['email'] }, deviceToken);
  const pinTok = new URL(inv.json.pinSetupLink).searchParams.get('t');
  expect((await api('/api/pin/setup', { token: pinTok, pin: '135790' })).status).toBe(200);
  await api('/api/contacts', { contactId: 'owner', roles: ['viewer', 'approver'], email: 'owner@m5.test', channels: ['email'] }, deviceToken);
  browserApp = await chromium.launch({ channel: process.env['M5_CHANNEL'] ?? 'chrome', // real Chrome: decodes H.264 like users' browsers
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  browser = await browserApp.newContext({ permissions: ['camera'] });
});

test.afterAll(async () => {
  await browser?.close();
  await browserApp?.close();
  const out = join(repo, 'bench', 'reports', 'm5-ome.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...evidence, finishedAt: new Date().toISOString() }, null, 2) + '\n');
  if (process.env['KEEP_STACK'] !== '1') dc('down', '-v', '--remove-orphans');
});

async function liveEvent(ttlMinutes = 10): Promise<{ eventId: string; whipUrl: string }> {
  const eventId = crypto.randomUUID();
  const r = await api<{ stream: { whipUrl: string } }>(
    '/api/events',
    {
      eventId,
      rule: 'fire',
      ruleTitle: 'Fire or smoke',
      severity: 'critical',
      confirmed: true,
      unconfirmedReason: null,
      confidence: 0.9,
      provider: 'local',
      reason: 'Flames near the stove',
      timestamp: new Date().toISOString(),
      sourceLabel: 'M5 test camera',
      recipients: ['contactA'],
      channels: ['email'],
      snapshotJpegB64: null,
      wantLiveView: true,
      ackTimeoutSec: 300,
      streamTtlMinutes: ttlMinutes,
    },
    deviceToken,
  );
  expect(r.status).toBe(200);
  return { eventId, whipUrl: r.json.stream.whipUrl };
}

async function viewerLinkFor(eventId: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const list = (await (await fetch('http://localhost:8025/api/v1/search?query=' + encodeURIComponent(eventId.slice(0, 8)))).json()) as { messages: { ID: string }[] };
    for (const m of list.messages ?? []) {
      const msg = (await (await fetch(`http://localhost:8025/api/v1/message/${m.ID}`)).json()) as { HTML: string };
      const link = /http:\/\/localhost:8089\/v\/\?t=[^"]+/.exec(msg.HTML)?.[0];
      if (link && link.includes(eventId)) return link.replace(/&amp;/g, '&');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('no viewer link email');
}

test('publish over WHIP through forward_auth, then view in a real browser with the email PIN flow', async () => {
  const { eventId, whipUrl } = await liveEvent();
  expect(whipUrl).toMatch(/^http:\/\/127\.0\.0\.1:8090\/app\/[A-Za-z0-9_-]{43}\?direction=whip&transport=all$/);
  const pub = await browser.newPage();
  await pub.goto('http://localhost:8088/healthz'); // not a viewer page: those send Permissions-Policy camera=()
  const p = await whipPublish(pub, whipUrl);
  evidence['publish'] = p;
  expect(p.status).toBe(201);
  expect(p.state).toBe('connected');

  const link = await viewerLinkFor(eventId);
  const viewer = await browser.newPage();
  const consoleLines: string[] = [];
  viewer.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  viewer.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 300)));
  viewer.on('response', (r) => {
    if (r.status() >= 400) consoleLines.push(`http ${r.status()} ${r.request().method()} ${r.url().replace(/[A-Za-z0-9_-]{43}/g, '<tok>')}`);
  });
  viewer.on('requestfailed', (r) => consoleLines.push(`failed ${r.url().replace(/[A-Za-z0-9_-]{43}/g, '<tok>')} ${r.failure()?.errorText ?? ''}`));
  viewer.on('websocket', (ws) => {
    consoleLines.push(`ws open ${ws.url().replace(/[A-Za-z0-9_-]{43}/g, '<tok>')}`);
    ws.on('framereceived', (f) => consoleLines.push(`ws recv ${String(f.payload).slice(0, 160)}`));
    ws.on('framesent', (f) => consoleLines.push(`ws sent ${String(f.payload).slice(0, 120)}`));
    ws.on('close', () => consoleLines.push('ws close'));
  });
  evidence['viewerConsole'] = consoleLines;
  await viewer.goto(link);
  await expect(viewer.locator('.badge')).toHaveText('Unverified, from this link');
  await viewer.fill('#pin', '135790');
  await viewer.click('button[type=submit]');
  await expect(viewer.locator('.badge')).toHaveText('Verified by the server', { timeout: 15_000 });
  await expect(viewer.locator('#status')).toContainText('Live (', { timeout: 40_000 });
  const playing = await viewer.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { w: v.videoWidth, h: v.videoHeight, t: v.currentTime } : null;
  });
  evidence['view'] = { status: await viewer.locator('#status').textContent(), video: playing };
  expect(playing?.w ?? 0).toBeGreaterThan(0);
  // A second session using the same link is refused (single use, session-bound).
  const other = await browser.newPage();
  await other.goto(link);
  await other.fill('#pin', '135790');
  await other.click('button[type=submit]');
  await expect(other.locator('#status')).toContainText('another session', { timeout: 15_000 });
  await other.close();
  await viewer.close();
  await pub.close();
});

test('untokened or unknown publish is refused by OME admission and by forward_auth', async () => {
  const direct = await rawWhip('http://127.0.0.1:13333/app/stream1?direction=whip&transport=all');
  const directFake = await rawWhip(`http://127.0.0.1:13333/app/${'A'.repeat(43)}?direction=whip&transport=all`);
  const viaCaddy = await rawWhip('http://127.0.0.1:8090/app/stream1?direction=whip&transport=all');
  evidence['untokened'] = { direct, directFake, viaCaddy };
  expect([401, 403]).toContain(direct);
  expect([401, 403]).toContain(directFake);
  expect(viaCaddy).toBe(403);
  // A valid token is admitted (then rejects the dummy SDP itself), proving the denials above were admission.
  const { whipUrl } = await liveEvent();
  const admitted = await rawWhip(whipUrl.replace('127.0.0.1:8090', '127.0.0.1:13333'));
  evidence['admittedDummySdp'] = admitted;
  expect([401, 403]).not.toContain(admitted);
});

test('REST API unreachable from the host; in-network only with the AccessToken (SG-20); TcpRelay 3478 reachable', async () => {
  expect(await tcpOpen(8081)).toBe(false);
  const noToken = dc('exec', '-T', 'backend', 'node', '-e', "fetch('http://ome:8081/v1/vhosts').then(r=>console.log(r.status))").trim();
  const withToken = dc('exec', '-T', 'backend', 'node', '-e', "fetch('http://ome:8081/v1/vhosts',{headers:{authorization:'Basic '+Buffer.from(process.env.OME_API_TOKEN).toString('base64')}}).then(r=>console.log(r.status))").trim();
  const relay = await tcpOpen(3478);
  evidence['rest'] = { hostPort8081Open: false, inNetworkNoToken: noToken, inNetworkWithToken: withToken, tcpRelay3478Open: relay };
  expect(noToken).toBe('401');
  expect(withToken).toBe('200');
  expect(relay).toBe(true);
});

test('webhook down and hung: OME denies publish; forward_auth fails closed with the backend stopped', async () => {
  const { whipUrl } = await liveEvent();
  const direct = whipUrl.replace('127.0.0.1:8090', '127.0.0.1:13333');
  const hung = whipUrl.replace('127.0.0.1:8090', '127.0.0.1:13334');
  const t0 = Date.now();
  const hungStatus = await rawWhip(hung);
  const hungMs = Date.now() - t0;
  dc('stop', 'backend');
  try {
    const downDirect = await rawWhip(direct);
    const downCaddy = await rawWhip(whipUrl);
    const pub = await browser.newPage();
    await pub.goto('about:blank');
    evidence['webhookFailures'] = { hungStatus, hungMs, downDirect, downCaddy };
    expect([401, 403]).toContain(hungStatus);
    expect([401, 403]).toContain(downDirect);
    expect(downCaddy).toBeGreaterThanOrEqual(500); // forward_auth cannot reach the backend: Caddy refuses, never proxies
    await pub.close();
  } finally {
    dc('start', 'backend');
    await waitHttp(`${BACKEND}/healthz`);
  }
});

test('lifetime cuts the WebRTC publish at the stream TTL', async () => {
  test.setTimeout(4 * 60_000);
  const { whipUrl } = await liveEvent(1);
  const pub = await browser.newPage();
  await pub.goto('http://localhost:8088/healthz'); // not a viewer page: those send Permissions-Policy camera=()
  const p = await whipPublish(pub, whipUrl);
  expect(p.state).toBe('connected');
  const started = Date.now();
  const endState = await pub.evaluate(
    () =>
      new Promise<string>((r) => {
        const pc = (window as unknown as { __pc: RTCPeerConnection }).__pc;
        const t = setTimeout(() => r(`still ${pc.connectionState}`), 150_000);
        const check = (): void => {
          if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
            clearTimeout(t);
            r(pc.connectionState);
          }
        };
        pc.addEventListener('connectionstatechange', check);
        pc.addEventListener('iceconnectionstatechange', check);
      }),
  );
  const elapsed = Date.now() - started;
  evidence['lifetime'] = { ttlMinutes: 1, endState, cutAfterMs: elapsed };
  expect(endState).not.toMatch(/^still/);
  expect(elapsed).toBeLessThan(120_000);
  await pub.close();
});

test('doctor, inside the compose network: webhook signature verified, OME itself refuses an untokened publish, REST needs the token', async () => {
  const run = (...env: string[]) => {
    try {
      return { code: 0, out: execFileSync('docker', ['compose', '-f', compose, 'exec', '-T', ...env.flatMap((e) => ['-e', e]), 'backend', 'node', '--disable-warning=ExperimentalWarning', 'dist/cli.js', 'doctor'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: (e as { status?: number }).status ?? 1, out: String((e as { stdout?: string }).stdout ?? '') };
    }
  };
  const real = run();
  expect(real.out, real.out).not.toMatch(/FAIL/);
  expect(real.code).toBe(0);
  expect(real.out).toMatch(/ok {3}OME itself refuses an untokened WHIP publish \(no Caddy in front\): HTTP 401/);
  // The same check against the OME whose webhook hangs: it must still refuse (it denies on timeout).
  const hung = run('OME_INTERNAL_SIGNALING=http://ome-hung:3333');
  expect(hung.out).toMatch(/ok {3}OME itself refuses an untokened WHIP publish/);
  evidence['doctorInside'] = { output: real.out.trim().split('\n'), hungOme: hung.out.trim().split('\n').filter((l) => l.includes('OME itself')) };
});

/** Arms the real extension (camera) against this stack's backend; returns its debug log reader and the harness. */
async function armedExtension(extraArgs: string[]) {
  const { acceptConsentAndCamera, DIST_E2E, launch } = await import('../harness');
  const h = await launch({ dist: DIST_E2E, extraArgs });
  await acceptConsentAndCamera(h);
  const code = /code: ([A-Z2-9]{8})/.exec(dc('exec', '-T', 'backend', 'node', '--disable-warning=ExperimentalWarning', 'dist/cli.js', 'pair-device'))![1]!;
  const p = await h.context.newPage();
  await p.goto(`chrome-extension://${h.extId}/src/onboarding/pair-backend/index.html`);
  await p.getByLabel('Backend URL').fill(BACKEND);
  await p.getByLabel('Pairing code').fill(code);
  await p.getByRole('button', { name: 'Pair' }).click();
  await p.getByText(/Paired as .* live view: yes/).waitFor({ timeout: 20_000 });
  await p.close();
  const { EXAMPLE_CONFIG_JSON } = await import('@survey-anything/shared');
  const saved = await h.send<{ ok: boolean; errors: string[] }>({
    type: 'save-config',
    config: {
      ...structuredClone(EXAMPLE_CONFIG_JSON),
      provider: { id: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl', apiKeyRef: null },
      providerProfiles: {},
      failoverChain: ['local'],
      vision: { ...EXAMPLE_CONFIG_JSON.vision, enableVision: false },
      egress: { alertMedia: true, liveView: true },
      alerts: { ...EXAMPLE_CONFIG_JSON.alerts, channels: ['email'], nonRedundantAck: true },
      contacts: { owner: { roles: ['viewer', 'approver'] } },
      routing: { other: ['owner'] },
      rules: ['other'],
      backend: { url: BACKEND },
    },
  });
  expect(saved.value, JSON.stringify(saved)).toEqual({ ok: true, errors: [] });
  const armed = await h.send<{ armed: boolean }>({ type: 'arm', source: { kind: 'camera', label: 'M5 probe camera' } });
  expect(armed.ok, armed.error).toBe(true);
  expect(armed.value?.armed).toBe(true);
  const log = async () => ((await h.send<{ log: string[] }>({ type: 'debug-stats' })).value?.log ?? []).join('\n');
  const probe = await (async () => {
    for (let i = 0; i < 60; i++) {
      const m = /live-view probe: (\w+)|live-view probe skipped: (.*)/.exec(await log());
      if (m) return m[1] ?? `skipped: ${m[2]}`;
      await new Promise((r) => setTimeout(r, 500));
    }
    return 'timeout';
  })();
  const status = await h.send<{ armed: boolean; notices: string[] }>({ type: 'get-status' });
  return { h, probe, status: status.value! };
}

function publisherProbeReports(): string[] {
  const out = dc('exec', '-T', 'backend', 'node', '--disable-warning=ExperimentalWarning', '-e',
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/survey-anything.db');console.log(JSON.stringify(db.prepare(\"SELECT candidate_type FROM probe_reports WHERE side='publisher' ORDER BY at\").all().map(r=>r.candidate_type)))");
  return JSON.parse(out.trim()) as string[];
}

test('arm-time probe: a black-canvas WHIP publish under a 30 s probe token reports the candidate type; arm succeeds', async () => {
  test.setTimeout(3 * 60_000);
  const before = publisherProbeReports().length;
  const { h, probe, status } = await armedExtension([]);
  try {
    expect(['udp', 'tcp', 'relay']).toContain(probe);
    expect(status.armed).toBe(true);
    const reports = publisherProbeReports();
    expect(reports.length).toBe(before + 1);
    expect(reports.at(-1)).toBe(probe);
    evidence['armProbe'] = { normal: { candidateType: probe, armed: status.armed, warned: status.notices.some((n) => /UDP media is unavailable/.test(n)) } };
  } finally {
    await h.close();
  }
});

test('arm-time probe with UDP unavailable: arm still succeeds, and the user is warned that live view will need the TCP relay', async () => {
  test.setTimeout(3 * 60_000);
  // Chromium's WebRTC policy that refuses non-proxied UDP: the probe can only connect over TCP.
  const { h, probe, status } = await armedExtension(['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']);
  try {
    expect(status.armed).toBe(true);
    expect(probe).not.toBe('udp');
    expect(status.notices.join('\n')).toMatch(/UDP media is unavailable from this network \((tcp|relay|none)\); live view will use the TCP relay/);
    (evidence['armProbe'] as Record<string, unknown>)['udpBlocked'] = { candidateType: probe, armed: status.armed, warned: true };
  } finally {
    await h.close();
  }
});
