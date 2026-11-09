/**
 * Anthropic Messages API (§6.1, C24). Verified 2026-11-09 against S32:
 * anthropic-version 2026-10-21 returns 400 for temperature, top_p or top_k, so none are ever sent.
 */
import { ANTHROPIC_VERSION } from '@survey-anything/shared';
import { BaseAdapter, type ChatImageRequest, type ChatImageResponse } from './adapter';
import { postJson } from './http';

interface MessagesResponse {
  content?: { type?: string; text?: unknown }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicAdapter extends BaseAdapter {
  async chatImage(req: ChatImageRequest): Promise<ChatImageResponse> {
    const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION };
    if (this.cfg.apiKey) headers['x-api-key'] = this.cfg.apiKey;
    if (this.cfg.directBrowser) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    const body = {
      model: this.cfg.model,
      max_tokens: req.maxOutputTokens,
      system: req.system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: req.mime, data: req.imageB64 } },
            { type: 'text', text: req.user },
          ],
        },
      ],
    };
    const json = (await postJson(
      this.cfg.fetchFn,
      `${this.cfg.baseUrl.replace(/\/+$/, '')}/v1/messages`,
      headers,
      body,
      this.cfg.timeoutMs,
      this.cfg.id,
      req.signal,
    )) as MessagesResponse;
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    return { text, usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 } };
  }
}

/** S31: cost is ceil(w/28) * ceil(h/28) visual tokens. */
export function anthropicImageTokens(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}
