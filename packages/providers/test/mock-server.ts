// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type Handler = (req: Recorded, res: ServerResponse) => void | Promise<void>;

export interface MockServer {
  url: string;
  requests: Recorded[];
  setHandler(h: Handler): void;
  close(): Promise<void>;
}

export async function startMock(initial: Handler): Promise<MockServer> {
  let handler = initial;
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // keep raw
      }
      const rec: Recorded = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body };
      requests.push(rec);
      void Promise.resolve(handler(rec, res)).catch((e: unknown) => {
        res.statusCode = 599;
        res.end(String(e));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler: (h) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function openAiReply(content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }): unknown {
  return { choices: [{ message: { role: 'assistant', content } }], usage };
}

export function anthropicReply(text: string): unknown {
  return { content: [{ type: 'text', text }], usage: { input_tokens: 90, output_tokens: 15 } };
}
