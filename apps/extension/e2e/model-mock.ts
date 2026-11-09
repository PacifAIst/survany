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
import { inflateSync } from 'node:zlib';
import { PROBE_ALPHABET, PROBE_SIZE, PROBE_SYSTEM, REASONER_SYSTEM, renderProbeImage } from '@survey-anything/providers';

export type CallKind = 'probe' | 'confirm' | 'reasoner' | 'other';

export interface MockCall {
  kind: CallKind;
  at: number;
  model: string;
  hasImage: boolean;
  user: string;
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

/** Decodes an 8-bit grayscale PNG with filter 0 rows (what encodeGrayPng writes) into raw pixels. */
function decodeGray(png: Uint8Array): { width: number; height: number; px: Uint8Array } {
  const b = Buffer.from(png);
  let off = 8;
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width + 1)] !== 0) throw new Error('unexpected PNG filter');
    px.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, px };
}

let refCache: { c: string; img: Uint8Array }[] | null = null;

/** Reads the code out of the extension's probe PNG by comparing each glyph cell with the probe font. */
export function readProbeCode(png: Uint8Array): string {
  const { width, height, px } = decodeGray(png);
  if (width !== PROBE_SIZE || height !== PROBE_SIZE) throw new Error(`unexpected probe size ${width}x${height}`);
  const len = 6;
  refCache ??= [...PROBE_ALPHABET].map((c) => ({ c, img: decodeGray(renderProbeImage(c.repeat(len))).px }));
  const refs = refCache;
  const glyphW = 30;
  const gap = 6;
  const x0 = Math.floor((PROBE_SIZE - (len * glyphW + (len - 1) * gap)) / 2);
  const y0 = Math.floor((PROBE_SIZE - 42) / 2);
  let code = '';
  for (let i = 0; i < len; i++) {
    const xs = x0 + i * (glyphW + gap);
    const match = refs.find(({ img }) => {
      for (let y = y0; y < y0 + 42; y++) {
        for (let x = xs; x < xs + glyphW; x++) if (img[y * PROBE_SIZE + x] !== px[y * PROBE_SIZE + x]) return false;
      }
      return true;
    });
    if (!match) throw new Error(`probe glyph ${i} matches no character`);
    code += match.c;
  }
  return code;
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
      calls.push({ kind, at: Date.now(), model: body.model ?? '', hasImage: image !== null, user });
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
