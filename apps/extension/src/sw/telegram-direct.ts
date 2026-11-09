/**
 * T0 direct Telegram (§4.2): extension only, no backend. No inline buttons, because nothing
 * could receive the callback; acknowledge and live view need T1/T2. Private chats only (D12).
 */
import { type AlertText, base64ToBytes } from '@survey-anything/shared';
import type { FrameKind, GuardContext } from './guarded-fetch';
import { RetryableError } from './outbox';

export type GuardedFetch = (url: string, init: RequestInit, ctx: GuardContext) => Promise<Response>;

const API = 'https://api.telegram.org';
const CAPTION_MAX = 1024;

interface TgResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  result?: unknown;
}

async function call(gf: GuardedFetch, token: string, method: string, body: BodyInit, frames: FrameKind, json: boolean): Promise<TgResponse> {
  let res: Response;
  try {
    res = await gf(`${API}/bot${token}/${method}`, { method: 'POST', body, ...(json ? { headers: { 'content-type': 'application/json' } } : {}) }, { purpose: 'telegram-direct', frames });
  } catch (e) {
    throw new RetryableError(`telegram ${method}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const data = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as TgResponse;
  if (!data.ok) {
    const code = data.error_code ?? res.status;
    // 429 honours retry_after (S16); 5xx and network errors are retried; 4xx are permanent.
    if (code === 429 || code >= 500) throw new RetryableError(`telegram ${method}: ${data.description ?? code}`, data.parameters?.retry_after ?? null);
    throw new Error(`telegram ${method}: ${data.description ?? code}`);
  }
  return data;
}

export async function telegramSendAlert(gf: GuardedFetch, token: string, chatId: string, text: AlertText, photoJpegB64: string | null): Promise<void> {
  const caption = text.telegramHtml.length > CAPTION_MAX ? text.telegramHtml.slice(0, CAPTION_MAX - 1) + '…' : text.telegramHtml;
  if (photoJpegB64) {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('caption', caption);
    form.set('parse_mode', 'HTML');
    const bytes = base64ToBytes(photoJpegB64);
    form.set('photo', new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'image/jpeg' }), 'snapshot.jpg');
    await call(gf, token, 'sendPhoto', form, 'alert-media', false);
    return;
  }
  await call(gf, token, 'sendMessage', JSON.stringify({ chat_id: chatId, text: text.telegramHtml, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }), 'none', true);
}

export async function telegramSendText(gf: GuardedFetch, token: string, chatId: string, html: string): Promise<void> {
  await call(gf, token, 'sendMessage', JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }), 'none', true);
}

/** Options page helper: the chat IDs of private chats that recently messaged the bot. */
export async function telegramRecentPrivateChats(gf: GuardedFetch, token: string): Promise<{ chatId: string; name: string }[]> {
  const data = await call(gf, token, 'getUpdates', JSON.stringify({ limit: 50, allowed_updates: ['message'] }), 'none', true);
  const out = new Map<string, string>();
  for (const u of (data.result as { message?: { chat?: { id?: number; type?: string; first_name?: string; username?: string } } }[]) ?? []) {
    const chat = u.message?.chat;
    if (chat?.type === 'private' && typeof chat.id === 'number') out.set(String(chat.id), chat.username ? `@${chat.username}` : (chat.first_name ?? String(chat.id)));
  }
  return [...out].map(([chatId, name]) => ({ chatId, name }));
}
