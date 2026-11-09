/**
 * M6 acceptance against the real confirm-gate-mcp 0.8.0 container (deploy/test/compose.m6.yml).
 *
 * The backend pairs as the gate's device, proposes through the gate's /mcp endpoint, and on a human
 * Telegram tap submits signed evidence (GET /device/pending -> POST /device/evidence -> POST
 * /device/confirm). The upstream is a stdio test double that logs every call it actually executes,
 * so each scenario asserts on real executions:
 *   approve -> exactly 1; replayed taps -> still 1; wrong user / non-approver / other chat / group -> 0;
 *   explicit deny -> 0; no tap within the window -> 0 (and a late tap stays 0); gate down -> 0 + notice.
 * Writes bench/reports/m6-gate.json.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = join(__dirname, '..', '..', '..');
const compose = join(repo, 'deploy', 'test', 'compose.m6.yml');
const BACKEND = 'http://localhost:8188';
const TELEGRAM = 'http://localhost:18181';
const SECRET = 'whsec_test_not_real';
const OWNER = 111;
const VIEWER = 222;
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), gate: 'confirm-gate-mcp 0.8.0 (mcp 2.3.0)', scenarios: {} };
const scenarios = report['scenarios'] as Record<string, unknown>;

function dc(...args: string[]): string {
  return execFileSync('docker', ['compose', '-f', compose, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function healthy(): Promise<void> {
  await waitFor(async () => ((await fetch(`${BACKEND}/healthz`)).ok ? true : undefined), 120_000, 'backend health');
}

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const r = await fetch(`${BACKEND}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as T };
}

interface TgCall {
  method: string;
  at: number;
  fields: Record<string, string>;
}
async function tgCalls(): Promise<TgCall[]> {
  return (await (await fetch(`${TELEGRAM}/__calls`)).json()) as TgCall[];
}

function executions(): { tool: string; arguments: Record<string, string> }[] {
  const out = dc('exec', '-T', 'gate', 'sh', '-c', 'cat /data/executions.jsonl 2>/dev/null || true');
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { tool: string; arguments: Record<string, string> });
}

const update = (u: Record<string, unknown>) => post('/telegram/webhook', { update_id: Math.floor(Math.random() * 1e9), ...u }, { 'x-telegram-bot-api-secret-token': SECRET });
const tap = (data: string, from = OWNER, chat = from, type = 'private') =>
  update({ callback_query: { id: randomUUID(), from: { id: from }, data, message: { message_id: 1, chat: { id: chat, type } } } });

let device = '';
let eventId = '';

async function propose(entity = 'light.porch'): Promise<{ approvalId: string; status: number; json: unknown }> {
  const before = (await tgCalls()).length;
  const r = await post<{ status: string; approvalId: string; sentTo: number }>(
    '/api/actions/propose',
    { eventId, tool: 'ha_call_service', args: { service: 'light.turn_on', entity_id: entity } },
    { authorization: `Bearer ${device}` },
  );
  if (r.status === 200) {
    // The card the owner receives carries the approval id in its callback data.
    const card = await waitFor(async () => (await tgCalls()).slice(before).find((c) => c.method === 'sendMessage' && /Approval needed/.test(c.fields['text'] ?? '')), 15_000, 'approval card');
    const markup = JSON.parse(card.fields['reply_markup'] ?? '{}') as { inline_keyboard: { callback_data: string }[][] };
    const ok = markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('ok:'))!.callback_data.slice(3);
    expect(ok).toBe(r.json.approvalId);
    expect(card.fields['chat_id']).toBe(String(OWNER)); // only the approver gets the card
  }
  return { approvalId: r.json.approvalId, status: r.status, json: r.json };
}

beforeAll(async () => {
  dc('down', '-v', '--remove-orphans');
  dc('up', '-d', '--build');
  await healthy();
  // The gate prints a one-time pairing code on start; the operator gives it to the backend CLI.
  const code = await waitFor(async () => /pairing code (\d{6})/.exec(dc('logs', 'gate'))?.[1], 60_000, 'gate pairing code');
  const paired = dc('exec', '-T', 'backend', 'node', '--disable-warning=ExperimentalWarning', 'dist/cli.js', 'gate-pair', code);
  report['gatePairing'] = paired.trim();
  expect(paired).toMatch(/Paired with the gate as/);
  dc('restart', 'backend');
  await healthy();

  const out = dc('exec', '-T', 'backend', 'node', '--disable-warning=ExperimentalWarning', 'dist/cli.js', 'pair-device');
  const devCode = /code: ([A-Z2-9]{8})/.exec(out)![1];
  device = (await post<{ deviceToken: string }>('/api/pair/device', { code: devCode, name: 'm6' })).json.deviceToken;
  const auth = { authorization: `Bearer ${device}` };
  for (const [contactId, roles, user] of [
    ['owner', ['viewer', 'approver'], OWNER],
    ['contactA', ['viewer'], VIEWER],
  ] as const) {
    const inv = await post<{ telegramLink: string }>('/api/contacts', { contactId, roles, email: null, channels: ['telegram'] }, auth);
    const start = new URL(inv.json.telegramLink).searchParams.get('start');
    await update({ message: { message_id: 1, from: { id: user }, chat: { id: user, type: 'private' }, text: `/start ${start}` } });
  }
  eventId = randomUUID();
  const ev = await post('/api/events', {
    eventId,
    rule: 'person-in-restricted-zone',
    ruleTitle: 'Person in restricted zone',
    severity: 'warning',
    confirmed: true,
    unconfirmedReason: null,
    confidence: 0.9,
    provider: 'local',
    reason: 'A person is standing at the back door.',
    timestamp: new Date().toISOString(),
    sourceLabel: 'M6 test camera',
    recipients: ['owner'],
    channels: ['telegram'],
    snapshotJpegB64: null,
    wantLiveView: false,
  }, auth);
  expect(ev.status).toBe(200);
});

afterAll(() => {
  report['finishedAt'] = new Date().toISOString();
  report['executionsLog'] = (() => {
    try {
      return executions();
    } catch {
      return 'unavailable';
    }
  })();
  const out = join(repo, 'bench', 'reports', 'm6-gate.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  if (process.env['KEEP_STACK'] !== '1') dc('down', '-v', '--remove-orphans');
});

describe('M6 against the real confirm-gate-mcp 0.8.0', () => {
  it('nothing executes on proposal; one approver tap executes exactly once; replayed taps do nothing', async () => {
    const p = await propose('light.porch');
    expect(p.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    const beforeTap = executions().length;
    expect(beforeTap).toBe(0);
    const t = await tap(`ok:${p.approvalId}`);
    expect(t.status).toBe(200);
    const after = await waitFor(async () => (executions().length >= 1 ? executions() : undefined), 30_000, 'execution');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ tool: 'ha_call_service', arguments: { service: 'light.turn_on', entity_id: 'light.porch' } });
    await Promise.all([tap(`ok:${p.approvalId}`), tap(`ok:${p.approvalId}`)]);
    await tap(`ok:${p.approvalId}`);
    await new Promise((r) => setTimeout(r, 2000));
    expect(executions()).toHaveLength(1);
    const edits = (await tgCalls()).filter((c) => c.method === 'editMessageText' && /Executed/.test(c.fields['text'] ?? ''));
    scenarios['approveOnce'] = { executionsBeforeTap: beforeTap, executionsAfterTap: 1, afterThreeReplays: executions().length, cardEditedToExecuted: edits.length > 0 };
    expect(edits.length).toBeGreaterThan(0);
  });

  it('wrong Telegram user, non-approver, other chat and group chat do nothing; an explicit deny does nothing', async () => {
    const base = executions().length;
    const p = await propose('light.garden');
    await tap(`ok:${p.approvalId}`, VIEWER); // paired contact without the approver role
    await tap(`ok:${p.approvalId}`, 999); // unknown Telegram user
    await tap(`ok:${p.approvalId}`, OWNER, 555); // approver, wrong chat
    await tap(`ok:${p.approvalId}`, OWNER, OWNER, 'group'); // approver, group chat
    await new Promise((r) => setTimeout(r, 2000));
    const afterWrong = executions().length - base;
    expect(afterWrong).toBe(0);
    await tap(`no:${p.approvalId}`);
    await tap(`ok:${p.approvalId}`); // a tap after the deny cannot revive it
    await new Promise((r) => setTimeout(r, 2000));
    const afterDeny = executions().length - base;
    scenarios['wrongUserAndDeny'] = { executionsAfterWrongTaps: afterWrong, executionsAfterDenyAndLateApprove: afterDeny };
    expect(afterDeny).toBe(0);
  });

  it('no tap within the approval window means deny; a late tap executes nothing', async () => {
    const base = executions().length;
    const p = await propose('light.hall');
    const started = Date.now();
    await waitFor(
      async () => ((await tgCalls()).some((c) => c.method === 'editMessageText' && /No answer in time/.test(c.fields['text'] ?? '')) ? true : undefined),
      90_000,
      'expiry edit',
    );
    const expiredAfterMs = Date.now() - started;
    await tap(`ok:${p.approvalId}`);
    await new Promise((r) => setTimeout(r, 2000));
    const executed = executions().length - base;
    scenarios['timeout'] = { policyWindowSeconds: 30, expiredAfterMs, executionsAfterLateTap: executed };
    expect(executed).toBe(0);
    expect(expiredAfterMs).toBeGreaterThanOrEqual(25_000);
  });

  it('gate down: the approval is denied, nothing executes, and the owner is told', async () => {
    const base = executions().length;
    const p = await propose('light.porch');
    dc('stop', 'gate');
    try {
      const before = (await tgCalls()).length;
      await tap(`ok:${p.approvalId}`);
      const notice = await waitFor(
        async () => (await tgCalls()).slice(before).find((c) => c.method === 'sendMessage' && /Approval gate unreachable/.test(c.fields['text'] ?? '')),
        30_000,
        'gate-unreachable notice',
      );
      scenarios['gateDown'] = { ownerNotified: notice.fields['chat_id'] === String(OWNER) };
    } finally {
      dc('start', 'gate');
    }
    await new Promise((r) => setTimeout(r, 3000));
    // The held card is still in the gate after restart, but nobody can confirm it without a fresh tap.
    const executed = executions().length - base;
    (scenarios['gateDown'] as Record<string, unknown>)['executions'] = executed;
    expect(executed).toBe(0);
  });
});
