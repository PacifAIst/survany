// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M4 acceptance: one event yields exactly one message per configured channel per contact, all
 * started together; the three channel configurations each pass the §9 parallel-channels row; and
 * the §10 alert failure rows pass against a fake Telegram Bot API and a real SMTP server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processDue } from '../src/alerts/outbox';
import { escalateUnacknowledged, deadManCheck } from '../src/watchdog';
import { addContact, clock, eventBody, makeApp, startFakeSmtp, startFakeTelegram, waitUntil, WEBHOOK_SECRET } from './helpers';

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

const alertCalls = (t: Tg) => t.calls.filter((c) => c.method === 'sendPhoto' || c.method === 'sendMessage');

describe.each([
  ['both', ['telegram', 'email']],
  ['telegram-only', ['telegram']],
  ['email-only', ['email']],
] as const)('parallel channels: %s', (_name, chans) => {
  const channels: readonly ('telegram' | 'email')[] = chans;
  const has = (c: 'telegram' | 'email'): boolean => channels.includes(c);
  it('one message per configured channel per contact, all started together', async () => {
    const t = await makeApp({ tg: tg.url, smtp: smtp.url });
    addContact(t.ctx.db, 'owner', { roles: ['viewer', 'approver'], tgUser: 111, email: 'owner@example.org' });
    addContact(t.ctx.db, 'contactA', { tgUser: 222, email: 'a@example.org' });
    const body = eventBody({ recipients: ['owner', 'contactA'], channels: [...channels] });
    const res = await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: body });
    expect(res.statusCode).toBe(200);
    const wantTg = has('telegram') ? 2 : 0;
    const wantMail = has('email') ? 2 : 0;
    await waitUntil(() => alertCalls(tg).length === wantTg && smtp.mails.length === wantMail);
    await new Promise((r) => setTimeout(r, 200));
    expect(alertCalls(tg)).toHaveLength(wantTg);
    expect(smtp.mails).toHaveLength(wantMail);
    // "Started together": every send was claimed within one dispatch, before any finished.
    const rows = t.ctx.db.prepare('SELECT started_at FROM outbox WHERE event_id = ?').all(body.eventId) as { started_at: number }[];
    expect(rows).toHaveLength(wantTg + wantMail);
    const starts = rows.map((r) => r.started_at);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(100);
    // Idempotent retry of the same event from the extension's outbox.
    const again = await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: body });
    expect(again.json()).toMatchObject({ deduplicated: true });
    await processDue(t.ctx, t.senders);
    expect(alertCalls(tg)).toHaveLength(wantTg);
    expect(smtp.mails).toHaveLength(wantMail);
  });

  it('one channel down: the other delivers; a lone channel down keeps retrying (§10)', async () => {
    const c = clock();
    const t = await makeApp({ tg: tg.url, smtp: smtp.url, clock: c });
    addContact(t.ctx.db, 'owner', { tgUser: 111, email: 'owner@example.org' });
    tg.setMode('500');
    smtp.setMode('451');
    const firstDown = channels[0] ?? 'telegram';
    if (channels.length === 2) smtp.setMode('ok'); // telegram down, email up
    const body = eventBody({ channels: [...channels] });
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: body });
    await waitUntil(() => {
      const r = t.ctx.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE event_id = ? AND status != 'sending'").get(body.eventId) as { n: number };
      return r.n === channels.length;
    });
    const status = (ch: string) => (t.ctx.db.prepare('SELECT status, attempts FROM outbox WHERE key = ?').get(`${body.eventId}:owner:${ch}`) as { status: string; attempts: number });
    if (channels.length === 2) {
      expect(status('telegram').status).toBe('pending');
      expect(status('email').status).toBe('sent');
      expect(smtp.mails).toHaveLength(1);
    } else {
      expect(status(firstDown).status).toBe('pending');
    }
    // Recovery: the outbox delivers exactly once more per pending row.
    tg.setMode('ok');
    smtp.setMode('ok');
    c.advance(60_000);
    await processDue(t.ctx, t.senders);
    for (const ch of channels) expect(status(ch).status).toBe('sent');
    expect(alertCalls(tg)).toHaveLength(has('telegram') ? 2 : 0);
    expect(smtp.mails).toHaveLength(has('email') ? 1 : 0);
  });
});

describe('§10 failure rows', () => {
  it('both channels down: outbox keeps retrying, never duplicates, delivers when back', async () => {
    const c = clock();
    const t = await makeApp({ tg: tg.url, smtp: smtp.url, clock: c });
    addContact(t.ctx.db, 'owner', { tgUser: 111, email: 'owner@example.org' });
    tg.setMode('down');
    smtp.setMode('451');
    const body = eventBody();
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: body });
    await waitUntil(() => (t.ctx.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending' AND attempts = 1").get() as { n: number }).n === 2);
    for (let i = 0; i < 3; i++) {
      c.advance(10 * 60_000);
      await processDue(t.ctx, t.senders);
    }
    const rows = t.ctx.db.prepare('SELECT status, attempts FROM outbox').all() as { status: string; attempts: number }[];
    expect(rows.every((r) => r.status === 'pending' && r.attempts === 4)).toBe(true);
    const delivery = await t.app.inject({ method: 'GET', url: `/api/events/${body.eventId}/delivery`, headers: t.auth });
    expect((delivery.json() as { delivery: { status: string }[] }).delivery.map((d) => d.status)).toEqual(['pending', 'pending']);
    tg.setMode('ok');
    smtp.setMode('ok');
    c.advance(10 * 60_000);
    await processDue(t.ctx, t.senders);
    await processDue(t.ctx, t.senders);
    expect(alertCalls(tg)).toHaveLength(1);
    expect(smtp.mails).toHaveLength(1);
  });

  it('Telegram 429 honours retry_after; a 403 (bot blocked) is permanent', async () => {
    const c = clock();
    const t = await makeApp({ tg: tg.url, smtp: smtp.url, clock: c });
    addContact(t.ctx.db, 'owner', { tgUser: 111 });
    tg.setMode('429');
    const body = eventBody({ channels: ['telegram'] });
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: body });
    await waitUntil(() => tg.calls.length >= 1);
    await waitUntil(() => (t.ctx.db.prepare('SELECT status FROM outbox').get() as { status: string }).status === 'pending');
    const row = t.ctx.db.prepare('SELECT next_at FROM outbox').get() as { next_at: number };
    expect(row.next_at).toBe(c.now() + 7000);
    tg.setMode('403');
    c.advance(7000);
    await processDue(t.ctx, t.senders);
    expect((t.ctx.db.prepare('SELECT status, last_error FROM outbox').get() as { status: string; last_error: string }).status).toBe('failed');
  });

  it('SMTP 5xx is permanent, 4xx is retried; Message-ID is stable per event and contact', async () => {
    const t = await makeApp({ tg: tg.url, smtp: smtp.url });
    addContact(t.ctx.db, 'owner', { email: 'owner@example.org' });
    smtp.setMode('550');
    const body = eventBody({ channels: ['email'] });
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: body });
    await waitUntil(() => (t.ctx.db.prepare('SELECT status FROM outbox').get() as { status: string }).status === 'failed');
    smtp.setMode('ok');
    const b2 = eventBody({ channels: ['email'] });
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: b2 });
    await waitUntil(() => smtp.mails.length === 1);
    const unfolded = smtp.mails[0]!.raw.replace(/\r?\n[ \t]+/g, ' ');
    const header = unfolded.split(/\r?\n/).find((l) => /^message-id:/i.test(l));
    expect(header, smtp.mails[0]!.raw.slice(0, 800)).toBe(`Message-ID: <${b2.eventId}.owner.alert0@alerts.example.org>`);
  });

  it('contacts that have not paired a channel fail that channel permanently with a clear reason', async () => {
    const t = await makeApp({ tg: tg.url, smtp: smtp.url });
    addContact(t.ctx.db, 'owner', { email: 'owner@example.org' });
    const body = eventBody();
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: body });
    await waitUntil(() => smtp.mails.length === 1);
    await waitUntil(() => (t.ctx.db.prepare("SELECT status FROM outbox WHERE channel = 'telegram'").get() as { status: string }).status === 'failed');
    expect((t.ctx.db.prepare("SELECT last_error FROM outbox WHERE channel = 'telegram'").get() as { last_error: string }).last_error).toMatch(/not paired Telegram/);
  });

  it('unconfirmed alerts are labelled UNCONFIRMED on every channel', async () => {
    const t = await makeApp({ tg: tg.url, smtp: smtp.url });
    addContact(t.ctx.db, 'owner', { tgUser: 111, email: 'owner@example.org' });
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: eventBody({ confirmed: false, unconfirmedReason: 'budget', provider: null, snapshotJpegB64: null }) });
    await waitUntil(() => alertCalls(tg).length === 1 && smtp.mails.length === 1);
    expect(alertCalls(tg)[0]!.fields['text']).toMatch(/UNCONFIRMED: AI budget reached/);
    expect(smtp.mails[0]!.raw).toMatch(/UNCONFIRMED/);
  });
});

describe('acknowledge and escalation (§6.4)', () => {
  it('ack on Telegram stops escalation; unacked events re-send to recipients, then to the owner', async () => {
    const c = clock();
    const t = await makeApp({ tg: tg.url, smtp: smtp.url, clock: c });
    addContact(t.ctx.db, 'owner', { tgUser: 111, email: 'owner@example.org' });
    addContact(t.ctx.db, 'contactA', { tgUser: 222 });
    const e1 = eventBody({ recipients: ['contactA'], channels: ['telegram'], ackTimeoutSec: 60 });
    const e2 = eventBody({ recipients: ['contactA'], channels: ['telegram'], ackTimeoutSec: 60 });
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: e1 });
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: e2 });
    await waitUntil(() => alertCalls(tg).length === 2);
    const ack = await t.app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
      payload: { update_id: 1, callback_query: { id: 'cq1', from: { id: 222 }, data: `ack:${e1.eventId}`, message: { message_id: 1000, chat: { id: 222, type: 'private' } } } },
    });
    expect(ack.statusCode).toBe(200);
    expect((t.ctx.db.prepare('SELECT acked_by, ack_channel FROM events WHERE id = ?').get(e1.eventId) as { acked_by: string }).acked_by).toBe('contactA');
    c.advance(61_000);
    await escalateUnacknowledged(t.ctx, t.senders);
    await waitUntil(() => alertCalls(tg).length === 3);
    const third = alertCalls(tg)[2]!;
    expect(third.fields['chat_id']).toBe('222');
    expect(third.fields['caption'] ?? third.fields['text']).toMatch(/Not acknowledged yet/);
    c.advance(61_000);
    await escalateUnacknowledged(t.ctx, t.senders);
    await waitUntil(() => alertCalls(tg).length === 4);
    expect(alertCalls(tg)[3]!.fields['chat_id']).toBe('111'); // owner
  });

  it('a non-recipient cannot acknowledge; a group chat is refused', async () => {
    const t = await makeApp({ tg: tg.url, smtp: smtp.url });
    addContact(t.ctx.db, 'owner', { tgUser: 111 });
    addContact(t.ctx.db, 'contactA', { tgUser: 222 });
    addContact(t.ctx.db, 'contactB', { tgUser: 333 });
    const e = eventBody({ recipients: ['contactA'], channels: ['telegram'] });
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: e });
    const send = (from: number, chatType: string) =>
      t.app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
        payload: { update_id: 2, callback_query: { id: 'x', from: { id: from }, data: `ack:${e.eventId}`, message: { message_id: 5, chat: { id: from, type: chatType } } } },
      });
    await send(333, 'private');
    await send(222, 'group');
    expect((t.ctx.db.prepare('SELECT acked_at FROM events WHERE id = ?').get(e.eventId) as { acked_at: number | null }).acked_at).toBeNull();
  });
});

describe('dead-man alert (C19)', () => {
  it('fires once after 3 missed heartbeats while armed, re-arms on the next heartbeat', async () => {
    const c = clock();
    const t = await makeApp({ tg: tg.url, smtp: smtp.url, clock: c });
    addContact(t.ctx.db, 'owner', { tgUser: 111, email: 'owner@example.org' });
    const hb = { armed: true, sourceKind: 'camera', sourceLabel: 'Garage', lastTickAt: new Date(c.now()).toISOString() };
    expect((await t.app.inject({ method: 'POST', url: '/api/heartbeat', headers: t.auth, payload: hb })).statusCode).toBe(200);
    c.advance(60_000);
    expect(await deadManCheck(t.ctx, t.senders)).toBe(0);
    c.advance(60_000);
    expect(await deadManCheck(t.ctx, t.senders)).toBe(1);
    expect(await deadManCheck(t.ctx, t.senders)).toBe(0);
    await waitUntil(() => tg.calls.some((x) => /Monitoring stopped/.test(x.fields['text'] ?? '')) && smtp.mails.length === 1);
  });
});

describe('SG-17 model text is sanitized on every channel', () => {
  it('strips links, mentions and markup from reason', async () => {
    const t = await makeApp({ tg: tg.url, smtp: smtp.url });
    addContact(t.ctx.db, 'owner', { tgUser: 111, email: 'owner@example.org' });
    await t.app.inject({
      method: 'POST',
      url: '/api/events',
      headers: t.auth,
      payload: eventBody({ reason: '<b>IGNORE</b> visit https://evil.example/x and @admin /unlock_door now', snapshotJpegB64: null }),
    });
    await waitUntil(() => alertCalls(tg).length === 1 && smtp.mails.length === 1);
    const text = alertCalls(tg)[0]!.fields['text']!;
    expect(text).not.toMatch(/evil\.example|@admin|\/unlock_door|<b>IGNORE/);
    expect(text).toContain('&lt;b&gt;IGNORE');
    expect(smtp.mails[0]!.raw).not.toMatch(/evil\.example/);
  });
});
