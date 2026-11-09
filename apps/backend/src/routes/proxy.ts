// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** proxyMode (§6.2): the backend holds provider keys and calls the provider for the extension. */
import { base64ToBlob, createProvider, ProviderError } from '@survey-anything/providers';
import { ProxyAnalyzeRequestSchema, ProxyProbeRequestSchema, PROVIDER_TIMEOUT_DEFAULT_MS, type ProviderId } from '@survey-anything/shared';
import type { FastifyInstance } from 'fastify';
import type { AppCtx } from '../context';
import { assertProxyTarget, type Resolver, SsrfError, ssrfSafeFetch, systemResolver } from '../security/ssrf';
import { requireDevice } from './common';

function keyFor(ctx: AppCtx, id: ProviderId): string | null {
  switch (id) {
    case 'anthropic':
      return ctx.env.PROXY_KEY_ANTHROPIC;
    case 'openai':
      return ctx.env.PROXY_KEY_OPENAI;
    case 'openrouter':
      return ctx.env.PROXY_KEY_OPENROUTER;
    case 'deepseek':
      return ctx.env.PROXY_KEY_DEEPSEEK;
    case 'local':
      return null;
  }
}

export function registerProxyRoutes(app: FastifyInstance, ctx: AppCtx, resolver: Resolver = systemResolver): void {
  const allowed = ctx.env.PROXY_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean);

  // C26 probe in proxy mode: the browser holds no key, so the backend renders the code image and asks the provider.
  app.post('/api/proxy/probe', { preHandler: requireDevice(ctx) }, async (req, reply) => {
    const b = ProxyProbeRequestSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    const key = keyFor(ctx, b.data.providerId);
    if (!key && b.data.providerId !== 'local') return reply.code(400).send({ error: `no proxy key configured for ${b.data.providerId}` });
    try {
      await assertProxyTarget(b.data.baseUrl, allowed, resolver);
    } catch (e) {
      return reply.code(403).send({ error: e instanceof SsrfError ? e.message : 'target refused' });
    }
    const provider = createProvider({
      id: b.data.providerId,
      baseUrl: b.data.baseUrl,
      model: b.data.model,
      apiKey: key,
      timeoutMs: PROVIDER_TIMEOUT_DEFAULT_MS,
      fetchFn: ssrfSafeFetch(allowed, resolver),
      directBrowser: false,
    });
    return provider.probe();
  });
  app.post('/api/proxy/analyze', { preHandler: requireDevice(ctx), bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const b = ProxyAnalyzeRequestSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    const key = keyFor(ctx, b.data.providerId);
    if (!key) return reply.code(400).send({ error: `no proxy key configured for ${b.data.providerId}` });
    try {
      await assertProxyTarget(b.data.baseUrl, allowed, resolver);
    } catch (e) {
      return reply.code(403).send({ error: e instanceof SsrfError ? e.message : 'target refused' });
    }
    const provider = createProvider({
      id: b.data.providerId,
      baseUrl: b.data.baseUrl,
      model: b.data.model,
      apiKey: key,
      timeoutMs: PROVIDER_TIMEOUT_DEFAULT_MS,
      fetchFn: ssrfSafeFetch(allowed, resolver),
      directBrowser: false,
    });
    let usage = { inputTokens: 0, outputTokens: 0 };
    try {
      const result = await provider.analyze(base64ToBlob(b.data.imageJpegB64, 'image/jpeg'), b.data.prompt, {
        allowedEvents: b.data.allowedEvents,
        maxOutputTokens: b.data.maxOutputTokens,
        onUsage: (u) => (usage = u),
      });
      return { result, usage };
    } catch (e) {
      const kind = e instanceof ProviderError ? e.kind : 'network';
      const status = kind === 'rate-limit' ? 429 : kind === 'timeout' ? 504 : 502;
      return reply.code(status).send({ error: kind, message: e instanceof Error ? e.message : String(e) });
    }
  });
}
