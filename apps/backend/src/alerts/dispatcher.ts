/**
 * Parallel redundant dispatch (§4.3 step 5, §10). Every configured channel for every recipient is
 * enqueued in one transaction, then all sends start together. No channel waits for another.
 */
import { readFileSync } from 'node:fs';
import { buildViewerQuery, type Channel, encodeCallback, escapeTelegramHtml, type Severity } from '@survey-anything/shared';
import { type AppCtx, publicHost } from '../context';
import { token256, tokenHash } from '../security/hmac';
import { mintToken, type StreamRow } from '../stream/tokens';
import { messageIdFor, type MailAttachment } from './email';
import { enqueueMany, kick, type OutboxPayload, type OutboxRow, type OutboxRowInput, PermanentSendError, type Senders } from './outbox';
import { alertTextFor, emailBody, type EventRow } from './templates';
import type { Keyboard } from './telegram';

export interface ContactRow {
  id: string;
  roles: string;
  channels: string;
  telegram_user_id: string | null;
  telegram_chat_id: string | null;
  email: string | null;
  pin_hash: string | null;
  created_at: number;
  paired_at: number | null;
  last_test_telegram: number | null;
  last_test_email: number | null;
}

export function getContact(ctx: AppCtx, id: string): ContactRow | undefined {
  return ctx.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
}

export function getEvent(ctx: AppCtx, id: string): EventRow | undefined {
  return ctx.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
}

function activeStream(ctx: AppCtx, eventId: string): StreamRow | undefined {
  return ctx.db.prepare('SELECT * FROM streams WHERE event_id = ? AND probe = 0 AND ended_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').get(eventId, ctx.now()) as
    | StreamRow
    | undefined;
}

/** A fresh viewer link per send; earlier unbound links for the same contact/channel are revoked. */
function viewerLink(ctx: AppCtx, ev: EventRow, stream: StreamRow, contactId: string, channel: Channel): { url: string; expiresAt: string } {
  ctx.db
    .prepare("UPDATE stream_tokens SET revoked = 1 WHERE stream_id = ? AND role = 'viewer' AND contact_id = ? AND channel = ? AND session_hash IS NULL")
    .run(stream.id, contactId, channel);
  const token = mintToken(ctx.db, stream, 'viewer', { contactId, channel, now: ctx.now() });
  const q = buildViewerQuery(token, { eventId: ev.id, rule: ev.rule, severity: ev.severity as Severity, timestamp: ev.ts });
  return { url: `${ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/v/?${q}`, expiresAt: new Date(stream.expires_at).toISOString() };
}

function ackLink(ctx: AppCtx, ev: EventRow, contactId: string): string {
  const token = token256();
  ctx.db.prepare('INSERT INTO ack_tokens(token_hash, event_id, contact_id, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), ev.id, contactId, ctx.now() + 24 * 3_600_000);
  const q = buildViewerQuery(token, { eventId: ev.id, rule: ev.rule, severity: ev.severity as Severity, timestamp: ev.ts });
  return `${ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/v/ack.html?${q}`;
}

function readMedia(path: string | null): Buffer | null {
  if (!path) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function roles(c: ContactRow): string[] {
  return JSON.parse(c.roles) as string[];
}

export function makeSenders(ctx: AppCtx): Senders {
  const telegram = async (row: OutboxRow, p: OutboxPayload): Promise<string | null> => {
    if (!ctx.telegram) throw new PermanentSendError('Telegram is not configured on the backend');
    const c = getContact(ctx, p.contactId);
    if (!c?.telegram_chat_id) throw new PermanentSendError(`contact ${p.contactId} has not paired Telegram`);
    const chat = c.telegram_chat_id;
    switch (row.kind) {
      case 'alert': {
        const ev = p.eventId ? getEvent(ctx, p.eventId) : undefined;
        if (!ev) throw new PermanentSendError('event not found');
        const stream = activeStream(ctx, ev.id);
        const link = stream && roles(c).includes('viewer') ? viewerLink(ctx, ev, stream, c.id, 'telegram') : null;
        const prefix = (p.stage ?? 0) > 0 ? '⏰ Not acknowledged yet:' : '';
        const t = alertTextFor(ev, link?.expiresAt ?? null, prefix);
        const keyboard: Keyboard = { inline_keyboard: [] };
        // D12: web_app buttons exist only in 1:1 chats; contacts pair only from private chats.
        if (link) keyboard.inline_keyboard.push([{ text: '▶️ View Live', web_app: { url: link.url } }]);
        keyboard.inline_keyboard.push([{ text: '✅ Acknowledge', callback_data: encodeCallback({ kind: 'ack', eventId: ev.id }) }]);
        const photo = readMedia(ev.snapshot_path);
        const id = photo ? await ctx.telegram.sendPhoto(chat, photo, t.telegramHtml, keyboard) : await ctx.telegram.sendMessage(chat, t.telegramHtml, keyboard);
        return String(id);
      }
      case 'clip': {
        const ev = p.eventId ? getEvent(ctx, p.eventId) : undefined;
        if (!ev) throw new PermanentSendError('event not found');
        const clip = readMedia(ev.clip_path);
        if (!clip || !ev.clip_mime) throw new Error('clip not uploaded yet');
        const t = alertTextFor(ev, null, '🎞️ Live view unavailable: recorded clip');
        return String(await ctx.telegram.sendClip(chat, clip, ev.clip_mime, t.telegramHtml));
      }
      case 'notice':
      case 'test': {
        const html = `<b>${escapeTelegramHtml(p.title ?? 'Survey Anything')}</b>\n${escapeTelegramHtml(p.text ?? '')}`;
        const id = await ctx.telegram.sendMessage(chat, html);
        if (row.kind === 'test') ctx.db.prepare('UPDATE contacts SET last_test_telegram = ? WHERE id = ?').run(ctx.now(), c.id);
        return String(id);
      }
    }
  };

  const email = async (row: OutboxRow, p: OutboxPayload): Promise<string | null> => {
    if (!ctx.mailer) throw new PermanentSendError('email is not configured on the backend');
    const c = getContact(ctx, p.contactId);
    if (!c?.email) throw new PermanentSendError(`contact ${p.contactId} has no email address`);
    const host = publicHost(ctx);
    switch (row.kind) {
      case 'alert': {
        const ev = p.eventId ? getEvent(ctx, p.eventId) : undefined;
        if (!ev) throw new PermanentSendError('event not found');
        const stream = activeStream(ctx, ev.id);
        const link = stream && roles(c).includes('viewer') ? viewerLink(ctx, ev, stream, c.id, 'email') : null;
        const prefix = (p.stage ?? 0) > 0 ? '⏰ Not acknowledged yet:' : '';
        const t = alertTextFor(ev, link?.expiresAt ?? null, prefix);
        const photo = readMedia(ev.snapshot_path);
        const body = emailBody(t, { viewUrl: link?.url ?? null, ackUrl: ackLink(ctx, ev, c.id), sourceUrl: ctx.env.SOURCE_URL }, photo !== null);
        const attachments: MailAttachment[] = photo ? [{ filename: 'snapshot.jpg', content: photo, contentType: 'image/jpeg', cid: 'snapshot' }] : [];
        return ctx.mailer.send({ to: c.email, subject: t.subject, text: body.text, html: body.html, messageId: messageIdFor(ev.id, c.id, `alert${p.stage ?? 0}`, host), attachments });
      }
      case 'clip': {
        const ev = p.eventId ? getEvent(ctx, p.eventId) : undefined;
        if (!ev) throw new PermanentSendError('event not found');
        const clip = readMedia(ev.clip_path);
        if (!clip || !ev.clip_mime) throw new Error('clip not uploaded yet');
        const t = alertTextFor(ev, null, 'Live view unavailable: recorded clip attached');
        const body = emailBody(t, { viewUrl: null, ackUrl: null, sourceUrl: ctx.env.SOURCE_URL }, false);
        const ext = ev.clip_mime.startsWith('video/mp4') ? 'mp4' : 'webm';
        return ctx.mailer.send({
          to: c.email,
          subject: t.subject,
          text: body.text,
          html: body.html,
          messageId: messageIdFor(ev.id, c.id, 'clip', host),
          attachments: [{ filename: `clip.${ext}`, content: clip, contentType: ev.clip_mime }],
        });
      }
      case 'notice':
      case 'test': {
        const title = p.title ?? 'Survey Anything';
        const text = p.text ?? '';
        const id = await ctx.mailer.send({
          to: c.email,
          subject: title,
          text,
          html: `<p><strong>${escapeTelegramHtml(title)}</strong></p><p>${escapeTelegramHtml(text)}</p>`,
          messageId: messageIdFor(row.key.replace(/[^A-Za-z0-9.-]/g, '-'), c.id, row.kind, host),
          attachments: [],
        });
        if (row.kind === 'test') ctx.db.prepare('UPDATE contacts SET last_test_email = ? WHERE id = ?').run(ctx.now(), c.id);
        return id;
      }
    }
  };

  return { telegram, email };
}

export function alertRows(ev: EventRow, recipients: string[], channels: Channel[], stage: number, kind: 'alert' | 'clip' = 'alert'): OutboxRowInput[] {
  const rows: OutboxRowInput[] = [];
  for (const contactId of recipients) {
    for (const channel of channels) {
      const suffix = kind === 'clip' ? ':clip' : stage > 0 ? `:esc${stage}` : '';
      rows.push({ key: `${ev.id}:${contactId}:${channel}${suffix}`, eventId: ev.id, contactId, channel, kind, payload: { eventId: ev.id, contactId, stage } });
    }
  }
  return rows;
}

export function dispatchEvent(ctx: AppCtx, senders: Senders, ev: EventRow, stage = 0, recipients?: string[]): Promise<unknown> {
  const rows = alertRows(ev, recipients ?? (JSON.parse(ev.recipients) as string[]), JSON.parse(ev.channels) as Channel[], stage);
  const keys = enqueueMany(ctx, rows);
  return kick(ctx, senders, keys);
}

export function dispatchClip(ctx: AppCtx, senders: Senders, ev: EventRow, recipients?: string[]): Promise<unknown> {
  const rows = alertRows(ev, recipients ?? (JSON.parse(ev.recipients) as string[]), JSON.parse(ev.channels) as Channel[], 0, 'clip');
  return kick(ctx, senders, enqueueMany(ctx, rows));
}

/** Operational notice to contacts on every channel they can receive (dead-man, re-pair, PIN abuse, budget). */
export function notify(ctx: AppCtx, senders: Senders, contactIds: string[], key: string, title: string, text: string): Promise<unknown> {
  const rows: OutboxRowInput[] = [];
  for (const id of new Set(contactIds)) {
    const c = getContact(ctx, id);
    if (!c) continue;
    if (c.telegram_chat_id && ctx.telegram) rows.push({ key: `${key}:${id}:telegram`, eventId: null, contactId: id, channel: 'telegram', kind: 'notice', payload: { contactId: id, title, text } });
    if (c.email && ctx.mailer) rows.push({ key: `${key}:${id}:email`, eventId: null, contactId: id, channel: 'email', kind: 'notice', payload: { contactId: id, title, text } });
  }
  return kick(ctx, senders, enqueueMany(ctx, rows));
}
