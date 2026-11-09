import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, verifyAuditChain } from '../src/actions/audit';
import { openDb } from '../src/db/migrate';
import { createPairingCode } from '../src/routes/pairing';
import { assertProxyTarget, SsrfError } from '../src/security/ssrf';
import { checkPin, hashPin } from '../src/security/pin';
import { applyRetention } from '../src/watchdog';
import { addContact, clock, eventBody, makeApp, startFakeTelegram, waitUntil, WEBHOOK_SECRET } from './helpers';

let tg: Awaited<ReturnType<typeof startFakeTelegram>>;
beforeEach(async () => {
  tg = await startFakeTelegram();
});
afterEach(async () => {
  await tg.close();
});

describe('SG-16 device pairing and device tokens', () => {
  it('codes are single use and expire; every API call needs the device token', async () => {
    const c = clock();
    const t = await makeApp({ tg: tg.url, clock: c });
    const code = createPairingCode(t.ctx);
    expect((await t.app.inject({ method: 'POST', url: '/api/pair/device', payload: { code, name: 'x' } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/pair/device', payload: { code, name: 'x' } })).statusCode).toBe(403);
    const late = createPairingCode(t.ctx);
    c.advance(10 * 60_000 + 1);
    expect((await t.app.inject({ method: 'POST', url: '/api/pair/device', payload: { code: late, name: 'x' } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/events', payload: eventBody() })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/events', headers: { authorization: `Bearer ${'A'.repeat(43)}` }, payload: eventBody() })).statusCode).toBe(401);
    // Tokens are stored hashed.
    expect(JSON.stringify(t.ctx.db.prepare('SELECT * FROM devices').all())).not.toContain(t.deviceToken);
  });

  it('rate-limits pairing attempts per address', async () => {
    const t = await makeApp({ tg: tg.url });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await t.app.inject({ method: 'POST', url: '/api/pair/device', payload: { code: 'ZZZZZZZZ', name: 'x' } })).statusCode);
    // makeApp already used one attempt for the test device.
    expect(codes.slice(0, 4)).toEqual([403, 403, 403, 403]);
    expect(codes.slice(4)).toEqual([429, 429]);
  });
});

describe('SG-07 Telegram webhook secret', () => {
  it('rejects updates without the exact secret token', async () => {
    const t = await makeApp({ tg: tg.url });
    const u = { update_id: 1, message: { message_id: 1, from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/stop' } };
    expect((await t.app.inject({ method: 'POST', url: '/telegram/webhook', payload: u })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'nope' }, payload: u })).statusCode).toBe(401);
  });

  it('contact pairing via /start works only in a private chat and only once', async () => {
    const t = await makeApp({ tg: tg.url });
    const inv = (await t.app.inject({ method: 'POST', url: '/api/contacts', headers: t.auth, payload: { contactId: 'owner', roles: ['viewer', 'approver'], email: null, channels: ['telegram'] } })).json() as { telegramLink: string };
    const code = new URL(inv.telegramLink).searchParams.get('start')!;
    const send = (chatType: string, from = 77) =>
      t.app.inject({
        method: 'POST',
        url: '/telegram/webhook',
        headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
        payload: { update_id: 2, message: { message_id: 1, from: { id: from }, chat: { id: from, type: chatType }, text: `/start ${code}` } },
      });
    await send('group');
    expect((t.ctx.db.prepare('SELECT telegram_user_id FROM contacts').get() as { telegram_user_id: string | null }).telegram_user_id).toBeNull();
    await send('private');
    expect((t.ctx.db.prepare('SELECT telegram_user_id FROM contacts').get() as { telegram_user_id: string }).telegram_user_id).toBe('77');
    await send('private', 88);
    expect((t.ctx.db.prepare('SELECT telegram_user_id FROM contacts').get() as { telegram_user_id: string }).telegram_user_id).toBe('77');
    await waitUntil(() => tg.calls.some((c) => /Paired as/.test(c.fields['text'] ?? '')));
  });
});

describe('SG-19 proxy SSRF guard', () => {
  const allow = ['api.openai.com'];
  it('allows only allowlisted https hosts that resolve publicly', async () => {
    await expect(assertProxyTarget('https://api.openai.com/v1', allow, async () => ['104.18.1.1'])).resolves.toBeInstanceOf(URL);
    for (const [url, addrs] of [
      ['http://api.openai.com/v1', ['104.18.1.1']],
      ['https://evil.example/v1', ['1.1.1.1']],
      ['https://api.openai.com:8443/v1', ['104.18.1.1']],
      ['https://user:pw@api.openai.com/v1', ['104.18.1.1']],
      ['https://api.openai.com/v1', ['10.0.0.5']],
      ['https://api.openai.com/v1', ['169.254.169.254']],
      ['https://api.openai.com/v1', ['::1']],
    ] as const) {
      await expect(assertProxyTarget(url, allow, async () => [...addrs])).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it('the proxy route refuses a private resolution with 403', async () => {
    const t = await makeApp({ tg: tg.url, env: { PROXY_KEY_OPENAI: 'sk-test-proxy-key-0000000000' }, resolver: async () => ['192.168.0.10'] });
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/proxy/analyze',
      headers: t.auth,
      payload: { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm', imageJpegB64: '/9j/', prompt: 'q', allowedEvents: ['fire'], maxOutputTokens: 100 },
    });
    expect(r.statusCode).toBe(403);
  });

  it('the proxy probe route needs a device, a configured key and a public target (SG-19 applies)', async () => {
    const t = await makeApp({ tg: tg.url, env: { PROXY_KEY_OPENAI: 'sk-test-proxy-key-0000000000' }, resolver: async () => ['10.0.0.7'] });
    const body = { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm' };
    expect((await t.app.inject({ method: 'POST', url: '/api/proxy/probe', payload: body })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/api/proxy/probe', headers: t.auth, payload: body })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: '/api/proxy/probe', headers: t.auth, payload: { ...body, providerId: 'anthropic' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/proxy/probe', headers: t.auth, payload: { ...body, extra: 1 } })).statusCode).toBe(400);
  });
});

describe('SG-22 retention and audit chain', () => {
  it('snapshots are deleted after the retention window', async () => {
    const c = clock();
    const t = await makeApp({ tg: tg.url, clock: c });
    addContact(t.ctx.db, 'owner', { tgUser: 1 });
    const body = eventBody({ channels: ['telegram'] });
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: body });
    const path = (t.ctx.db.prepare('SELECT snapshot_path FROM events').get() as { snapshot_path: string }).snapshot_path;
    expect(existsSync(path)).toBe(true);
    c.advance(23 * 3_600_000);
    expect(applyRetention(t.ctx)).toBe(0);
    c.advance(2 * 3_600_000);
    expect(applyRetention(t.ctx)).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('retention 0 deletes media as soon as no link or send needs it', async () => {
    const t = await makeApp({ tg: tg.url, env: { MEDIA_RETENTION_HOURS: '0' } });
    addContact(t.ctx.db, 'owner', { tgUser: 1 });
    await t.app.inject({ method: 'POST', url: '/api/events', headers: t.auth, payload: eventBody({ channels: ['telegram'] }) });
    await waitUntil(() => tg.calls.length >= 1);
    await waitUntil(() => applyRetention(t.ctx) === 1);
  });

  it('the audit hash chain detects edits and deletions', () => {
    const db = openDb(':memory:');
    appendAudit(db, 'a', { x: 1 });
    appendAudit(db, 'b', { x: 2 });
    appendAudit(db, 'c', { x: 3 });
    expect(verifyAuditChain(db)).toEqual({ ok: true, rows: 3, brokenAt: null });
    db.prepare("UPDATE audit SET data = '{\"x\":9}' WHERE seq = 2").run();
    expect(verifyAuditChain(db).brokenAt).toBe(2);
    const db2 = openDb(':memory:');
    appendAudit(db2, 'a', {});
    appendAudit(db2, 'b', {});
    appendAudit(db2, 'c', {});
    db2.prepare('DELETE FROM audit WHERE seq = 2').run();
    expect(verifyAuditChain(db2).ok).toBe(false);
  });
});

describe('SG-25 source offer', () => {
  it('every response links to the source and /source redirects there', async () => {
    const t = await makeApp({ tg: tg.url });
    const r = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(r.headers['x-source-code']).toBe('https://github.com/PacifAIst/survany');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    const s = await t.app.inject({ method: 'GET', url: '/source' });
    expect(s.statusCode).toBe(302);
    expect(s.headers.location).toBe('https://github.com/PacifAIst/survany');
  });
});

describe('PIN storage', () => {
  it('scrypt hashes with per-contact salt; malformed submissions never count', () => {
    const db = openDb(':memory:');
    const h1 = hashPin('123456');
    const h2 = hashPin('123456');
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^scrypt\$16384\$8\$1\$/);
    db.prepare("INSERT INTO contacts(id, roles, channels, pin_hash, created_at) VALUES ('c', '[]', '[]', ?, 0)").run(h1);
    for (let i = 0; i < 20; i++) expect(checkPin(db, 'c', 'abcdef').result).toBe('malformed');
    expect(checkPin(db, 'c', '123456').result).toBe('ok');
  });
});
