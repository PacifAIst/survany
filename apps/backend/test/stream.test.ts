// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M5 backend acceptance (without a real OME, see deploy/ for the Docker tests):
 * SG-09 initData, SG-10 stream tokens, SG-11 admission + forward_auth, SG-12 email PIN flow,
 * §10 stream-start budget and viewer-failure clip, PIN lockout and re-pair (§9).
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processDue } from '../src/alerts/outbox';
import { enforceStreamStartBudget } from '../src/watchdog';
import { addContact, BOT_TOKEN, clock, eventBody, makeApp, OME_SECRET, signInitData, startFakeSmtp, startFakeTelegram, waitUntil } from './helpers';
import { validateInitData } from '../src/routes/viewer';
import { createStream, mintToken } from '../src/stream/tokens';

type Tg = Awaited<ReturnType<typeof startFakeTelegram>>;
type Smtp = Awaited<ReturnType<typeof startFakeSmtp>>;
let tg: Tg;
let smtp: Smtp;
beforeEach(async () => {
  tg = await startFakeTelegram();
  smtp = await startFakeSmtp();
});
afterEach(async () => {
  await tg.close();
  await smtp.close();
});

function sign(body: string): string {
  return createHmac('sha1', OME_SECRET).update(body).digest('base64url');
}

async function admission(app: Awaited<ReturnType<typeof makeApp>>['app'], request: Record<string, unknown>, sig?: string) {
  const body = JSON.stringify({ client: { address: '203.0.113.5', port: 5000 }, request: { time: new Date().toISOString(), ...request } });
  return app.inject({ method: 'POST', url: '/ome/admission', headers: { 'content-type': 'application/json', 'x-ome-signature': sig ?? sign(body) }, payload: body });
}

/** Creates a live-view event and returns the viewer links that were actually sent. */
async function liveEvent(c?: ReturnType<typeof clock>) {
  const t = await makeApp({ tg: tg.url, smtp: smtp.url, ...(c ? { clock: c } : {}) });
  addContact(t.ctx.db, 'owner', { roles: ['viewer', 'approver'], tgUser: 111, email: 'owner@example.org', pin: '424242' });
  addContact(t.ctx.db, 'contactA', { tgUser: 222, email: 'a@example.org', pin: '135790' });
  addContact(t.ctx.db, 'contactB', { tgUser: 333, email: 'b@example.org', pin: '246810' });
  const body = eventBody({ recipients: ['contactA'], wantLiveView: true });
  const res = await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: body });
  const out = res.json() as { stream: { whipUrl: string; expiresAt: string; iceServers: { urls: string }[] } };
  await waitUntil(() => tg.calls.some((x) => x.method === 'sendPhoto') && smtp.mails.length === 1);
  const markup = JSON.parse(tg.calls.find((x) => x.method === 'sendPhoto')!.fields['reply_markup']!) as { inline_keyboard: { text: string; web_app?: { url: string }; callback_data?: string }[][] };
  const tgUrl = markup.inline_keyboard.flat().find((b) => b.web_app)!.web_app!.url;
  const unfolded = smtp.mails[0]!.raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  const emailUrl = /https:\/\/alerts\.example\.org\/v\/\?t=[A-Za-z0-9_-]{43}[^"\s<]*/.exec(unfolded)![0].replace(/&amp;/g, '&');
  const ackUrl = /https:\/\/alerts\.example\.org\/v\/ack\.html\?t=[A-Za-z0-9_-]{43}[^"\s<]*/.exec(unfolded)![0].replace(/&amp;/g, '&');
  return { t, body, out, tgUrl, emailUrl, ackUrl, markup };
}

const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;
const initData = (userId: number, authDate = Math.floor(Date.now() / 1000)) => signInitData({ auth_date: String(authDate), query_id: 'AAH', user: JSON.stringify({ id: userId, first_name: 'A' }) });

describe('alert links and metadata (§4.3, SG-27)', () => {
  it('Telegram gets a web_app View Live button and an ack callback; links carry only validated metadata', async () => {
    const { out, tgUrl, emailUrl, markup, body } = await liveEvent();
    expect(out.stream.whipUrl).toMatch(/^https:\/\/live\.example\.org\/app\/[A-Za-z0-9_-]{43}\?direction=whip&transport=all$/);
    expect(out.stream.iceServers[0]!.urls).toBe('turn:live.example.org:3478?transport=tcp');
    expect(markup.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean)).toEqual([`ack:${body.eventId}`]);
    for (const u of [tgUrl, emailUrl]) {
      const p = new URL(u).searchParams;
      expect([...p.keys()].sort()).toEqual(['event_id', 'rule', 'severity', 't', 'timestamp']);
      expect(p.get('event_id')).toBe(body.eventId);
      expect(u).not.toContain('Flames'); // free text never goes in a URL
    }
    expect(tokenOf(tgUrl)).not.toBe(tokenOf(emailUrl)); // one token per recipient per channel
  });

  it('SG-12: email carries view and acknowledge links but never an approval', async () => {
    const { t } = await liveEvent();
    expect(smtp.mails[0]!.raw).not.toMatch(/\b(ok|no):[A-Za-z0-9_-]{22}\b|\/api\/actions/);
    void t;
  });
});

describe('SG-10 stream tokens', () => {
  it('are stored only as hashes, live at most 10 minutes and bind to the first session', async () => {
    const { t, emailUrl } = await liveEvent();
    const plain = tokenOf(emailUrl);
    const dump = JSON.stringify(t.ctx.db.prepare('SELECT * FROM stream_tokens').all());
    expect(dump).not.toContain(plain);
    const s = t.ctx.db.prepare('SELECT created_at, expires_at FROM streams').get() as { created_at: number; expires_at: number };
    expect(s.expires_at - s.created_at).toBeLessThanOrEqual(10 * 60_000);

    const sessA = 'sessionAAAAAAAAAAAAAAAA';
    const ok = await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token: plain, sessionId: sessA, pin: '135790' } });
    expect(ok.statusCode).toBe(200);
    const grant = ok.json() as { sources: { webrtc: string; llhls: string }; playToken: string; meta: { eventId: string } };
    expect(grant.sources.webrtc).toMatch(/^wss:\/\/live\.example\.org\/app\/[A-Za-z0-9_-]{43}\?transport=all$/);
    expect(grant.sources.llhls).toMatch(/\/app\/[A-Za-z0-9_-]{43}\/llhls\.m3u8$/);
    // The bound session can reconnect.
    const again = await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token: plain, sessionId: sessA, pin: '135790' } });
    expect(again.statusCode).toBe(200);
    // A forwarded link, even with the right PIN, is refused for any other session.
    const other = await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token: plain, sessionId: 'sessionBBBBBBBBBBBBBBBB', pin: '135790' } });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ reason: 'link already used by another session' });
  });

  it('expire with the stream TTL', async () => {
    const c = clock();
    const { t, emailUrl } = await liveEvent(c);
    c.advance(10 * 60_000 + 1);
    const r = await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token: tokenOf(emailUrl), sessionId: 'sessionAAAAAAAAAAAAAAAA', pin: '135790' } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ reason: 'expired' });
  });
});

describe('SG-12 and mail scanners', () => {
  it('GET is inert; POST without a well-formed PIN is not counted; wrong PIN fails', async () => {
    const { t, emailUrl } = await liveEvent();
    expect((await t.app.inject({ method: 'GET', url: '/api/viewer/email' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: new URL(emailUrl).pathname + new URL(emailUrl).search })).statusCode).toBe(404); // served by Caddy as static files, never by the API
    const token = tokenOf(emailUrl);
    for (let i = 0; i < 10; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token, sessionId: 'scannerSSSSSSSSSSSSSSSSS', pin: '' } });
      expect(r.statusCode).toBe(400);
    }
    const wrong = await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token, sessionId: 'scannerSSSSSSSSSSSSSSSSS', pin: '000000' } });
    expect(wrong.statusCode).toBe(403);
    // The token was not consumed by any of that: the real contact still gets in.
    const ok = await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token, sessionId: 'realAAAAAAAAAAAAAAAAAAA', pin: '135790' } });
    expect(ok.statusCode).toBe(200);
  });

  it('5 wrong PINs lock the contact (per contact, exponential), the owner is told after 3', async () => {
    const { t, emailUrl } = await liveEvent();
    const token = tokenOf(emailUrl);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token, sessionId: 'atkAAAAAAAAAAAAAAAAAAAA', pin: `11111${i}` } })).statusCode);
    expect(codes).toEqual([403, 403, 403, 403, 403, 423]);
    const right = await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token, sessionId: 'realAAAAAAAAAAAAAAAAAAA', pin: '135790' } });
    expect(right.statusCode).toBe(423);
    await waitUntil(() => tg.calls.some((x) => /Repeated wrong PINs/.test(x.fields['text'] ?? '')));
  });

  it('email acknowledge needs the PIN', async () => {
    const { t, ackUrl, body } = await liveEvent();
    const token = tokenOf(ackUrl);
    expect((await t.app.inject({ method: 'POST', url: '/api/ack/email', payload: { token, pin: 'abc' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/ack/email', payload: { token, pin: '999999' } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/ack/email', payload: { token, pin: '135790' } })).json()).toMatchObject({ acknowledged: true, first: true });
    expect((t.ctx.db.prepare('SELECT ack_channel FROM events WHERE id = ?').get(body.eventId) as { ack_channel: string }).ack_channel).toBe('email');
  });
});

describe('SG-09 Telegram initData', () => {
  it('validates signature, freshness and identity', async () => {
    const { t, tgUrl } = await liveEvent();
    const token = tokenOf(tgUrl);
    const post = (data: string, session = 'tgsessAAAAAAAAAAAAAAAAA') => t.app.inject({ method: 'POST', url: '/api/viewer/telegram', payload: { token, sessionId: session, initData: data } });
    expect((await post(initData(333))).json()).toMatchObject({ reason: 'this link belongs to someone else' }); // second identity
    expect((await post(initData(222, Math.floor(Date.now() / 1000) - 7200))).json()).toMatchObject({ reason: 'stale initData' });
    expect((await post(initData(222).replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`))).json()).toMatchObject({ reason: 'bad signature' });
    expect((await post(signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 222 }) }, '999:other-bot-token'))).json()).toMatchObject({ reason: 'bad signature' });
    const ok = await post(initData(222));
    expect(ok.statusCode).toBe(200);
    // The Telegram link cannot be used through the email flow and vice versa.
    expect((await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token, sessionId: 'tgsessAAAAAAAAAAAAAAAAA', pin: '135790' } })).statusCode).toBe(403);
  });

  it('matches the documented algorithm', () => {
    const d = initData(5);
    expect(validateInitData(d, BOT_TOKEN, 3600, Date.now())).toMatchObject({ ok: true, userId: '5' });
  });
});

describe('SG-11 OME admission and forward_auth', () => {
  it('verifies the signature; unknown means deny', async () => {
    const { t, out } = await liveEvent();
    const url = out.stream.whipUrl;
    expect((await admission(t.app, { direction: 'incoming', protocol: 'webrtc', status: 'opening', url }, 'bogus')).statusCode).toBe(401);
    expect((await admission(t.app, { direction: 'incoming', protocol: 'webrtc', status: 'opening', url: url.replace(/app\/[^?]+/, 'app/' + 'x'.repeat(43)) })).json()).toMatchObject({ allowed: false });
    expect((await admission(t.app, { direction: 'incoming', protocol: 'rtmp', status: 'opening', url })).json()).toMatchObject({ allowed: false });
  });

  it('accepts the protocol casing the real OME v0.21.0 sends ("WebRTC", "LLHLS")', async () => {
    const { t, out } = await liveEvent();
    expect((await admission(t.app, { direction: 'incoming', protocol: 'WebRTC', status: 'opening', url: out.stream.whipUrl })).json()).toMatchObject({ allowed: true });
  });

  it('publisher: allowed, new_url keeps the query (transport=all), lifetime is the remaining TTL', async () => {
    const { t, out } = await liveEvent();
    const r = (await admission(t.app, { direction: 'incoming', protocol: 'webrtc', status: 'opening', url: out.stream.whipUrl })).json() as { allowed: boolean; new_url: string; lifetime: number };
    expect(r.allowed).toBe(true);
    const nu = new URL(r.new_url);
    const streamId = (t.ctx.db.prepare('SELECT id FROM streams').get() as { id: string }).id;
    expect(nu.pathname).toBe(`/app/${streamId}`);
    expect(nu.searchParams.get('transport')).toBe('all');
    expect(nu.searchParams.get('direction')).toBe('whip');
    expect(r.lifetime).toBeGreaterThan(9 * 60_000);
    expect(r.lifetime).toBeLessThanOrEqual(10 * 60_000);
    // A publisher token cannot play, a viewer token cannot publish.
    expect((await admission(t.app, { direction: 'outgoing', protocol: 'webrtc', status: 'opening', url: out.stream.whipUrl })).json()).toMatchObject({ allowed: false });
  });

  it('LL-HLS media under the stream id needs this stream\'s play token (forward_auth); the master by stream id never passes', async () => {
    const { t, emailUrl } = await liveEvent();
    const g = (await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token: tokenOf(emailUrl), sessionId: 'sessLLHLSAAAAAAAAAAAAAAA', pin: '135790' } })).json() as { playToken: string };
    const r = (await admission(t.app, { direction: 'outgoing', protocol: 'llhls', status: 'opening', url: `https://live.example.org/app/${g.playToken}/llhls.m3u8` })).json() as { new_url: string };
    const streamId = /\/app\/([0-9a-f-]{36})\//.exec(r.new_url)![1]!;
    const fa = (uri: string) => t.app.inject({ method: 'GET', url: '/ome/forward-auth', headers: { 'x-forwarded-uri': uri, 'x-sa-forward-auth': 'fwd_secret' } });
    const chunk = `/app/${streamId}/chunklist_0_video_8622854708945751029_llhls.m3u8?_HLS_msn=2&_HLS_part=6`;
    expect((await fa(`${chunk}&sa=${g.playToken}`)).statusCode).toBe(200);
    expect((await fa(`/app/${streamId}/part_0_2_6_video_8622854708945751029_llhls.m4s?sa=${g.playToken}`)).statusCode).toBe(200);
    // Knowing the stream id is not enough.
    expect((await fa(chunk)).statusCode).toBe(403);
    expect((await fa(`${chunk}&sa=${'A'.repeat(43)}`)).statusCode).toBe(403);
    expect((await fa(`/app/${streamId}/llhls.m3u8?sa=${g.playToken}`)).statusCode).toBe(403);
    // Another stream's live play token does not open this one.
    const otherStream = createStream(t.ctx.db, t.deviceId, null, 5);
    const otherPlay = mintToken(t.ctx.db, otherStream, 'play');
    expect((await fa(`/app/${otherStream.id}/chunklist_0_video_1_llhls.m3u8?sa=${otherPlay}`)).statusCode).toBe(200);
    expect((await fa(`${chunk}&sa=${otherPlay}`)).statusCode).toBe(403);
    // A play token stops working when its stream ends.
    t.ctx.db.prepare('UPDATE streams SET ended_at = ?').run(Date.now());
    expect((await fa(`${chunk}&sa=${g.playToken}`)).statusCode).toBe(403);
  });

  it('viewer: only a bound play token for an alerted contact is admitted, over WebRTC or LL-HLS', async () => {
    const { t, emailUrl } = await liveEvent();
    const g = (await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token: tokenOf(emailUrl), sessionId: 'sessAAAAAAAAAAAAAAAAAAAA', pin: '135790' } })).json() as {
      sources: { webrtc: string; llhls: string };
    };
    const webrtc = g.sources.webrtc.replace('wss://', 'https://');
    const r = (await admission(t.app, { direction: 'outgoing', protocol: 'webrtc', status: 'opening', url: webrtc })).json() as { allowed: boolean; new_url: string };
    expect(r.allowed).toBe(true);
    expect(new URL(r.new_url).searchParams.get('transport')).toBe('all');
    expect(((await admission(t.app, { direction: 'outgoing', protocol: 'llhls', status: 'opening', url: g.sources.llhls })).json() as { allowed: boolean; new_url: string }).new_url).toMatch(/\/app\/[0-9a-f-]{36}\/llhls\.m3u8$/);
    // The raw viewer link token is never admitted directly.
    expect((await admission(t.app, { direction: 'outgoing', protocol: 'webrtc', status: 'opening', url: `https://live.example.org/app/${tokenOf(emailUrl)}` })).json()).toMatchObject({ allowed: false });
    // Allowlist: remove the contact from the event's recipients and the same token is refused.
    t.ctx.db.prepare("UPDATE events SET recipients = '[\"contactB\"]'").run();
    expect((await admission(t.app, { direction: 'outgoing', protocol: 'webrtc', status: 'opening', url: webrtc })).json()).toMatchObject({ allowed: false });
  });

  it('forward_auth refuses untokened or unknown signaling and requires the shared secret', async () => {
    const { t, out } = await liveEvent();
    const path = new URL(out.stream.whipUrl).pathname + new URL(out.stream.whipUrl).search;
    const fa = (uri: string, secret = 'fwd_secret') => t.app.inject({ method: 'GET', url: '/ome/forward-auth', headers: { 'x-forwarded-uri': uri, 'x-sa-forward-auth': secret } });
    expect((await fa(path)).statusCode).toBe(200);
    expect((await fa('/app/stream?direction=whip')).statusCode).toBe(403);
    expect((await fa('/app/')).statusCode).toBe(403);
    expect((await fa(path, 'wrong')).statusCode).toBe(403);
    expect((await fa('/app/%2e%2e/x')).statusCode).toBe(403);
  });
});

describe('§10 clip fallbacks', () => {
  it('stream not live within 5 s: the clip goes to every recipient on every channel once uploaded', async () => {
    const c = clock();
    const { t, body } = await liveEvent(c);
    c.advance(5_001);
    expect(await enforceStreamStartBudget(t.ctx, t.senders)).toBe(1);
    expect(await enforceStreamStartBudget(t.ctx, t.senders)).toBe(0);
    await waitUntil(() => (t.ctx.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'clip' AND status = 'pending'").get() as { n: number }).n === 2);
    const up = await t.app.inject({ method: 'POST', url: `/api/events/${body.eventId}/clip`, headers: { ...t.auth, 'content-type': 'video/webm' }, payload: Buffer.from('webm-bytes') });
    expect(up.statusCode).toBe(200);
    await waitUntil(() => tg.calls.some((x) => x.method === 'sendDocument') && smtp.mails.length === 2);
    await processDue(t.ctx, t.senders);
    expect(tg.calls.filter((x) => x.method === 'sendDocument')).toHaveLength(1);
    expect(smtp.mails[1]!.raw).toMatch(/clip\.webm/);
  });

  it('a live stream within 5 s sends no clip', async () => {
    const c = clock();
    const { t, out } = await liveEvent(c);
    await admission(t.app, { direction: 'incoming', protocol: 'webrtc', status: 'opening', url: out.stream.whipUrl });
    c.advance(6_000);
    expect(await enforceStreamStartBudget(t.ctx, t.senders)).toBe(0);
  });

  it('viewer ladder exhausted: that contact gets the clip once per channel (idempotent)', async () => {
    const { t, emailUrl, body } = await liveEvent();
    await t.app.inject({ method: 'POST', url: `/api/events/${body.eventId}/clip`, headers: { ...t.auth, 'content-type': 'video/mp4' }, payload: Buffer.from('mp4-bytes') });
    const g = (await t.app.inject({ method: 'POST', url: '/api/viewer/email', payload: { token: tokenOf(emailUrl), sessionId: 'sessAAAAAAAAAAAAAAAAAAAA', pin: '135790' } })).json() as { playToken: string };
    for (let i = 0; i < 3; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/viewer/report', payload: { playToken: g.playToken, candidateType: 'none', failed: true } });
      expect(r.statusCode).toBe(200);
    }
    await waitUntil(() => tg.calls.some((x) => x.method === 'sendVideo') && smtp.mails.length === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(tg.calls.filter((x) => x.method === 'sendVideo')).toHaveLength(1);
    expect(smtp.mails).toHaveLength(2);
    const reports = t.ctx.db.prepare('SELECT candidate_type FROM probe_reports').all() as { candidate_type: string }[];
    expect(reports.every((r) => r.candidate_type === 'none')).toBe(true);
    expect(JSON.stringify(reports)).not.toMatch(/\d+\.\d+\.\d+\.\d+/); // never an IP address
  });
});

describe('PIN re-pair (§9)', () => {
  it('no route changes a PIN in place; re-pair resets it and notifies the contact and the owner on every channel', async () => {
    const t = await makeApp({ tg: tg.url, smtp: smtp.url });
    addContact(t.ctx.db, 'owner', { tgUser: 111, email: 'owner@example.org', pin: '424242' });
    addContact(t.ctx.db, 'contactA', { tgUser: 222, email: 'a@example.org', pin: '135790' });
    const inv = (await t.app.inject({ method: 'POST', url: '/api/contacts', headers: t.auth, payload: { contactId: 'contactA', roles: ['viewer'], email: 'a@example.org', channels: ['telegram', 'email'] } })).json() as {
      pinSetupLink: string;
      telegramLink: string;
    };
    await waitUntil(() => tg.calls.filter((x) => /re-paired/.test(x.fields['text'] ?? '')).length === 2 && smtp.mails.filter((m) => /re-paired/.test(m.raw)).length === 2);
    const c = t.ctx.db.prepare('SELECT pin_hash, telegram_chat_id FROM contacts WHERE id = ?').get('contactA') as { pin_hash: string | null; telegram_chat_id: string | null };
    expect(c).toEqual({ pin_hash: null, telegram_chat_id: null });
    expect(inv.telegramLink).toMatch(/^https:\/\/t\.me\/survey_test_bot\?start=[A-Za-z0-9_-]{22}$/);
    const tok = new URL(inv.pinSetupLink).searchParams.get('t')!;
    expect((await t.app.inject({ method: 'POST', url: '/api/pin/setup', payload: { token: tok, pin: '12345' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/pin/setup', payload: { token: tok, pin: '1234567' } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/pin/setup', payload: { token: tok, pin: '7654321' } })).statusCode).toBe(403); // one-time link
    const routes = t.app.printRoutes();
    expect(routes).not.toMatch(/pin\/(change|update|reset)/);
  });
});
