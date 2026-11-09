/**
 * Telegram Bot API client (S13). Private chats only (D12): web_app buttons are rejected in groups.
 */

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly retryAfterSec: number | null,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.code === 429 || this.code >= 500 || this.code === 0;
  }
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
  url?: string;
}

export type Keyboard = { inline_keyboard: InlineButton[][] };

interface TgEnvelope {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramApi {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async call<T = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData ? { body } : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new TelegramError(`telegram ${method}: ${e instanceof Error ? e.message : String(e)}`, 0, null);
    }
    const env = (await res.json().catch(() => ({ ok: false, error_code: res.status, description: `HTTP ${res.status}` }))) as TgEnvelope;
    if (!env.ok) throw new TelegramError(`telegram ${method}: ${env.description ?? 'error'}`, env.error_code ?? res.status, env.parameters?.retry_after ?? null);
    return env.result as T;
  }

  async sendPhoto(chatId: string, photo: Buffer, captionHtml: string, keyboard?: Keyboard): Promise<number> {
    const f = new FormData();
    f.set('chat_id', chatId);
    f.set('caption', captionHtml.slice(0, 1024));
    f.set('parse_mode', 'HTML');
    if (keyboard) f.set('reply_markup', JSON.stringify(keyboard));
    f.set('photo', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'snapshot.jpg');
    const r = await this.call<{ message_id: number }>('sendPhoto', f);
    return r.message_id;
  }

  async sendMessage(chatId: string, html: string, keyboard?: Keyboard): Promise<number> {
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: html.slice(0, 4096),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    return r.message_id;
  }

  /** C11: MPEG4 plays inline as video; anything else goes as a document. 50 MB cap. */
  async sendClip(chatId: string, clip: Buffer, mime: string, captionHtml: string): Promise<number> {
    if (clip.length > 50 * 1024 * 1024) throw new TelegramError('clip exceeds 50 MB', 413, null);
    const f = new FormData();
    f.set('chat_id', chatId);
    f.set('caption', captionHtml.slice(0, 1024));
    f.set('parse_mode', 'HTML');
    const isMp4 = mime.startsWith('video/mp4');
    f.set(isMp4 ? 'video' : 'document', new Blob([new Uint8Array(clip)], { type: mime }), isMp4 ? 'clip.mp4' : 'clip.webm');
    const r = await this.call<{ message_id: number }>(isMp4 ? 'sendVideo' : 'sendDocument', f);
    return r.message_id;
  }

  async answerCallbackQuery(id: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, text: text.slice(0, 200) });
  }

  async editReplyMarkup(chatId: string, messageId: number, keyboard: Keyboard): Promise<void> {
    await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: keyboard });
  }

  /** Without `keyboard`, Telegram removes the message's inline buttons; pass it to keep them. */
  async editMessageText(chatId: string, messageId: number, html: string, keyboard?: Keyboard): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: html.slice(0, 4096), parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
  }

  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call('setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
  }
}
