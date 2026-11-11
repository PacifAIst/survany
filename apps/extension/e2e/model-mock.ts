// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A local, OpenAI-compatible model server for the end-to-end tests. It answers the three kinds of call
 * the extension makes, told apart by the system prompt the extension sends:
 *  - the C26 vision probe: it reads the random code back out of the 256 px PNG (the probe's own 5x7
 *    font, so this is exact), which is what a real vision model has to do to pass;
 *  - a confirm call (an image plus the scene question): answers with `confirm(...)`;
 *  - a Reasoner call (text only): answers with `reason(...)`.
 * Every request is recorded with whether it carried image bytes.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROBE_SYSTEM, REASONER_SYSTEM } from '@survey-anything/providers';
import { readProbeCode } from '../../../packages/providers/test/probe-reader';

export { readProbeCode };

export type CallKind = 'probe' | 'confirm' | 'reasoner' | 'other';

export interface MockCall {
  kind: CallKind;
  at: number;
  model: string;
  hasImage: boolean;
  user: string;
  /** The request path, e.g. /v1/chat/completions. */
  path: string;
  /** The image data URL, kept for confirm calls so tests can look at what the model saw. */
  image?: string;
}

export interface ModelMock {
  url: string;
  calls: MockCall[];
  close(): Promise<void>;
}

export interface MockAnswers {
  confirm: (user: string) => string;
  reason: (user: string) => string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: { type?: string; text?: string }) => (p.type === 'text' ? (p.text ?? '') : '')).join('\n');
  return '';
}

function imageOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const p of content as { type?: string; image_url?: { url?: string } }[]) {
    if (p.type === 'image_url' && p.image_url?.url) return p.image_url.url;
  }
  return null;
}

export async function startModelMock(answers: MockAnswers): Promise<ModelMock> {
  const calls: MockCall[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // The extension calls from a chrome-extension:// origin; a local server must allow it (C10).
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', '*');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      let body: { model?: string; messages?: { role: string; content: unknown }[] } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
      } catch {
        res.statusCode = 400;
        res.end('{"error":"bad json"}');
        return;
      }
      const system = textOf(body.messages?.find((m) => m.role === 'system')?.content);
      const userMsg = body.messages?.find((m) => m.role === 'user')?.content;
      const user = textOf(userMsg);
      const image = imageOf(userMsg);
      const kind: CallKind = system === PROBE_SYSTEM ? 'probe' : system === REASONER_SYSTEM ? 'reasoner' : image ? 'confirm' : 'other';
      calls.push({ kind, at: Date.now(), model: body.model ?? '', hasImage: image !== null, user, path: req.url ?? '', ...(kind === 'confirm' && image ? { image } : {}) });
      let text = '';
      try {
        if (kind === 'probe') text = JSON.stringify({ code: readProbeCode(Buffer.from(image!.split(',')[1] ?? '', 'base64')) });
        else if (kind === 'confirm') text = answers.confirm(user);
        else if (kind === 'reasoner') text = answers.reason(user);
        else text = '{}';
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: kind === 'confirm' ? 400 : 120, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
