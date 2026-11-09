// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * openai, openrouter, deepseek and local (Ollama, LM Studio, vLLM, llama.cpp) all speak
 * POST {baseUrl}/chat/completions with image_url data URLs (§6.1).
 */
import { BaseAdapter, type ChatImageRequest, type ChatImageResponse } from './adapter';
import { ProviderError } from './errors';
import { postJson } from './http';

interface ChatCompletion {
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p && typeof (p as { text: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('');
  }
  return '';
}

export class OpenAICompatibleAdapter extends BaseAdapter {
  protected endpoint(): string {
    return `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.cfg.apiKey) h['authorization'] = `Bearer ${this.cfg.apiKey}`;
    if (this.cfg.id === 'openrouter') h['x-title'] = 'Survey Anything';
    return h;
  }

  async chatImage(req: ChatImageRequest): Promise<ChatImageResponse> {
    let tokenParam: 'max_completion_tokens' | 'max_tokens' = 'max_completion_tokens';
    let structured = req.structured;
    // C25: reasoning models need max_completion_tokens; some compatible servers only know max_tokens.
    // One retry per incompatibility, never a loop.
    for (let attempt = 0; attempt < 3; attempt++) {
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        messages: [
          { role: 'system', content: req.system },
          {
            role: 'user',
            content: [
              { type: 'text', text: req.user },
              { type: 'image_url', image_url: { url: `data:${req.mime};base64,${req.imageB64}` } },
            ],
          },
        ],
        [tokenParam]: req.maxOutputTokens,
        stream: false,
      };
      if (structured) body['response_format'] = { type: 'json_object' };
      try {
        const json = (await postJson(
          this.cfg.fetchFn,
          this.endpoint(),
          this.headers(),
          body,
          this.cfg.timeoutMs,
          this.cfg.id,
          req.signal,
        )) as ChatCompletion;
        const text = contentText(json.choices?.[0]?.message?.content);
        return {
          text,
          usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
        };
      } catch (e) {
        if (!(e instanceof ProviderError) || e.kind !== 'bad-request') throw e;
        const body400 = e.bodySnippet.toLowerCase();
        if (tokenParam === 'max_completion_tokens' && body400.includes('max_completion_tokens')) {
          tokenParam = 'max_tokens';
          continue;
        }
        if (structured && body400.includes('response_format')) {
          structured = false;
          continue;
        }
        throw e;
      }
    }
    throw new ProviderError('bad-request', `${this.cfg.id}: request rejected after compatibility retries`, 400, this.cfg.id);
  }
}
