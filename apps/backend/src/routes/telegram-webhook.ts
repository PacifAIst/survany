/**
 * Telegram webhook: contact pairing (/start), /stop, acknowledge, approve and deny.
 * SECURITY-GATE SG-07: every update must carry X-Telegram-Bot-Api-Secret-Token matching our secret, compared in constant time.
 * SECURITY-GATE SG-04: approvals and acks are checked against callback_query.from.id and only accepted from private chats.
 */
import { decodeCallback, escapeTelegramHtml } from '@survey-anything/shared';
import type { FastifyInstance } from 'fastify';
import { getContact, getEvent, notify } from '../alerts/dispatcher';
import type { Senders } from '../alerts/outbox';
import { appendAudit } from '../actions/audit';
import { decideApproval } from '../actions/approvals';
import type { AppCtx } from '../context';
import { safeEqual, tokenHash } from '../security/hmac';
import { RateLimiter } from '../security/rate-limit';
import { pinSetupLink } from './pairing';
import { stopEventStreams } from './events';

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: string;
}
interface TgUpdate {
  update_id: number;
  message?: { message_id: number; from?: TgUser; chat: TgChat; text?: string };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: TgChat } };
}

const userLimiters = new WeakMap<AppCtx, RateLimiter>();

function perUser(ctx: AppCtx): RateLimiter {
  const l = userLimiters.get(ctx) ?? new RateLimiter(30, 60_000, ctx.now);
  userLimiters.set(ctx, l);
  return l;
}

function contactByTelegramUser(ctx: AppCtx, userId: number): { id: string; roles: string[] } | null {
  const r = ctx.db.prepare('SELECT id, roles FROM contacts WHERE telegram_user_id = ?').get(String(userId)) as { id: string; roles: string } | undefined;
  return r ? { id: r.id, roles: JSON.parse(r.roles) as string[] } : null;
}

export function registerTelegramWebhook(app: FastifyInstance, ctx: AppCtx, senders: Senders): void {
  app.post('/telegram/webhook', async (req, reply) => {
    const secret = ctx.env.TELEGRAM_WEBHOOK_SECRET;
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (!secret || typeof got !== 'string' || !safeEqual(got, secret)) return reply.code(401).send({ error: 'bad secret token' });
    const u = req.body as TgUpdate;
    try {
      if (u.message) await onMessage(ctx, senders, u.message);
      else if (u.callback_query) await onCallback(ctx, senders, u.callback_query);
    } catch (e) {
      ctx.log.error({ err: String(e) }, 'telegram update failed');
    }
    // Always 200 so Telegram does not retry a poisoned update forever.
    return { ok: true };
  });
}

async function reply(ctx: AppCtx, chatId: number, html: string): Promise<void> {
  await ctx.telegram?.sendMessage(String(chatId), html).catch((e: unknown) => ctx.log.warn({ err: String(e) }, 'telegram reply failed'));
}

async function onMessage(ctx: AppCtx, senders: Senders, m: NonNullable<TgUpdate['message']>): Promise<void> {
  if (!m.from || !m.text) return;
  if (m.chat.type !== 'private') {
    // D12: no group alerting. Say so once and ignore.
    await reply(ctx, m.chat.id, 'Survey Anything works only in a private chat with the bot.');
    return;
  }
  if (!perUser(ctx).take(String(m.from.id))) return;
  const text = m.text.trim();
  const start = /^\/start(?:\s+([A-Za-z0-9_-]{22}))?$/.exec(text);
  if (start) {
    const code = start[1];
    if (!code) {
      await reply(ctx, m.chat.id, 'Hi. Ask the owner of the Survey Anything setup for your personal pairing link.');
      return;
    }
    const now = ctx.now();
    const inv = ctx.db.prepare("SELECT contact_id FROM contact_invites WHERE token_hash = ? AND kind = 'telegram' AND used_at IS NULL AND expires_at > ?").get(tokenHash(code), now) as
      | { contact_id: string }
      | undefined;
    if (!inv) {
      await reply(ctx, m.chat.id, 'This pairing link is invalid or was already used.');
      return;
    }
    const taken = contactByTelegramUser(ctx, m.from.id);
    if (taken && taken.id !== inv.contact_id) {
      await reply(ctx, m.chat.id, `This Telegram account is already paired as "${escapeTelegramHtml(taken.id)}".`);
      return;
    }
    ctx.db.prepare('UPDATE contact_invites SET used_at = ? WHERE token_hash = ?').run(now, tokenHash(code));
    ctx.db.prepare('UPDATE contacts SET telegram_user_id = ?, telegram_chat_id = ?, paired_at = ? WHERE id = ?').run(String(m.from.id), String(m.chat.id), now, inv.contact_id);
    appendAudit(ctx.db, 'contact.telegram-paired', { contactId: inv.contact_id }, now);
    const c = getContact(ctx, inv.contact_id);
    const pinLine = c && !c.pin_hash ? `\nChoose your PIN (used for email links): ${pinSetupLink(ctx, inv.contact_id)}` : '';
    await reply(ctx, m.chat.id, `✅ Paired as <b>${escapeTelegramHtml(inv.contact_id)}</b>. You will receive alerts here.${escapeTelegramHtml(pinLine)}`);
    if (inv.contact_id !== 'owner') await notify(ctx, senders, ['owner'], `paired:${inv.contact_id}:${now}`, 'Contact paired', `"${inv.contact_id}" paired their Telegram account.`);
    return;
  }
  if (text === '/stop') {
    const who = contactByTelegramUser(ctx, m.from.id);
    if (!who) return;
    // Owner stops everything; a contact stops streams of events they were alerted about.
    const events = ctx.db.prepare("SELECT DISTINCT s.event_id AS id, e.recipients FROM streams s JOIN events e ON e.id = s.event_id WHERE s.ended_at IS NULL AND s.expires_at > ?").all(ctx.now()) as {
      id: string;
      recipients: string;
    }[];
    let n = 0;
    for (const e of events) {
      if (who.id === 'owner' || (JSON.parse(e.recipients) as string[]).includes(who.id)) n += await stopEventStreams(ctx, e.id);
    }
    appendAudit(ctx.db, 'stream.stop-command', { by: who.id, streams: n });
    await reply(ctx, m.chat.id, n > 0 ? `⏹ Stopped ${n} live stream(s).` : 'No live stream to stop.');
    return;
  }
  await reply(ctx, m.chat.id, 'Commands: /stop ends live view. Alerts arrive here automatically.');
}

async function onCallback(ctx: AppCtx, senders: Senders, q: NonNullable<TgUpdate['callback_query']>): Promise<void> {
  const answer = (text: string) => ctx.telegram?.answerCallbackQuery(q.id, text).catch(() => undefined);
  if (!perUser(ctx).take(String(q.from.id))) return void (await answer('Slow down.'));
  if (q.message?.chat.type !== 'private') return void (await answer('Only private chats are supported.'));
  const data = decodeCallback(q.data);
  if (!data) return void (await answer('Unknown button.'));
  const who = contactByTelegramUser(ctx, q.from.id);
  if (!who) return void (await answer('You are not a paired contact.'));

  if (data.kind === 'ack') {
    const ev = getEvent(ctx, data.eventId);
    const recipients = ev ? (JSON.parse(ev.recipients) as string[]) : [];
    if (!ev || (!recipients.includes(who.id) && who.id !== 'owner')) return void (await answer('Not your alert.'));
    const now = ctx.now();
    const r = ctx.db.prepare("UPDATE events SET acked_at = ?, acked_by = ?, ack_channel = 'telegram' WHERE id = ? AND acked_at IS NULL").run(now, who.id, ev.id);
    appendAudit(ctx.db, 'event.ack', { eventId: ev.id, by: who.id, channel: 'telegram', first: r.changes === 1 }, now);
    await answer(r.changes === 1 ? 'Acknowledged. Thank you.' : `Already acknowledged by ${ev.acked_by ?? 'someone'}.`);
    if (q.message && ctx.telegram) {
      await ctx.telegram.editReplyMarkup(String(q.message.chat.id), q.message.message_id, { inline_keyboard: [] }).catch(() => undefined);
    }
    if (r.changes === 1) {
      const others = recipients.filter((x) => x !== who.id);
      if (others.length) await notify(ctx, senders, others, `ack:${ev.id}`, 'Alert acknowledged', `${who.id} acknowledged "${ev.rule_title}" (${ev.id}).`);
    }
    return;
  }
  // approve / deny (M6)
  const result = await decideApproval(ctx, senders, data.id, data.kind === 'approve' ? 'approve' : 'deny', {
    contactId: who.id,
    roles: who.roles,
    telegramUserId: String(q.from.id),
    chatId: String(q.message.chat.id),
  });
  await answer(result.message);
}
