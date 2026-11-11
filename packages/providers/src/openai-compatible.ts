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
  model?: unknown;
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: unknown;
}

/**
 * The API base for an OpenAI-compatible server. Local servers (LM Studio, Ollama, vLLM, llama.cpp) serve
 * the API under /v1; a base URL typed without any path ("http://127.0.0.1:1234") gets /v1 added, because
 * LM Studio answers an unknown path with HTTP 200 and an error message, which would look like a reply.
 */
export function openAiBase(id: string, baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (id !== 'local') return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.pathname === '' || u.pathname === '/') return `${trimmed}/v1`;
  } catch {
    // leave invalid URLs to the caller's validation
  }
  return trimmed;
}

/**
 * The text of a chat completion, or a clear error when the server answered without one (some servers
 * reply 200 with {"error": ...} to a wrong path or model). Never an empty string passed off as an answer.
 */
export function completionText(json: unknown, providerId: string): { text: string; usage: { inputTokens: number; outputTokens: number }; model: string | null } {
  const c = (json ?? {}) as ChatCompletion;
  if (!Array.isArray(c.choices) || c.choices.length === 0) {
    const err = typeof c.error === 'string' ? c.error : c.error && typeof c.error === 'object' && 'message' in c.error ? String((c.error as { message: unknown }).message) : null;
    throw new ProviderError(
      'parse',
      `${providerId}: the server answered without a chat completion${err ? `: "${err.slice(0, 200)}"` : ''}. Check the base URL (local servers use .../v1) and the model id.`,
      null,
      providerId,
      null,
      JSON.stringify(json ?? null).slice(0, 500),
    );
  }
  return {
    text: contentText(c.choices[0]?.message?.content),
    usage: { inputTokens: c.usage?.prompt_tokens ?? 0, outputTokens: c.usage?.completion_tokens ?? 0 },
    model: typeof c.model === 'string' && c.model ? c.model : null,
  };
}

/** GET {base}/models on an OpenAI-compatible server: the model ids it serves, to help pick the exact one. */
export async function listModels(cfg: { id: string; baseUrl: string; apiKey: string | null; fetchFn: (url: string, init: RequestInit) => Promise<Response> }): Promise<string[]> {
  const res = await cfg.fetchFn(`${openAiBase(cfg.id, cfg.baseUrl)}/models`, {
    method: 'GET',
    headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const json = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
  return (json?.data ?? []).map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean).slice(0, 200);
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
    return `${openAiBase(this.cfg.id, this.cfg.baseUrl)}/chat/completions`;
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
        return completionText(json, this.cfg.id);
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
