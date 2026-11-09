/**
 * Telegram callback data codec (§6.5).
 * SECURITY-GATE SG-08: every callback_data string is asserted to be at most 64 bytes, and decoding is strict.
 */
import { CALLBACK_MAX_BYTES } from './defaults';
import { ID22_RE, UUID_RE } from './ids';

export type CallbackData =
  | { kind: 'ack'; eventId: string }
  | { kind: 'approve'; id: string }
  | { kind: 'deny'; id: string };

export class CallbackCodecError extends Error {}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function encodeCallback(d: CallbackData): string {
  let s: string;
  switch (d.kind) {
    case 'ack':
      if (!UUID_RE.test(d.eventId)) throw new CallbackCodecError('ack requires a UUIDv4 event id');
      s = `ack:${d.eventId}`;
      break;
    case 'approve':
      if (!ID22_RE.test(d.id)) throw new CallbackCodecError('approve requires an id22');
      s = `ok:${d.id}`;
      break;
    case 'deny':
      if (!ID22_RE.test(d.id)) throw new CallbackCodecError('deny requires an id22');
      s = `no:${d.id}`;
      break;
  }
  if (byteLength(s) > CALLBACK_MAX_BYTES) throw new CallbackCodecError(`callback data exceeds ${CALLBACK_MAX_BYTES} bytes`);
  return s;
}

export function decodeCallback(raw: unknown): CallbackData | null {
  if (typeof raw !== 'string' || byteLength(raw) > CALLBACK_MAX_BYTES) return null;
  const ack = /^ack:([0-9a-f-]{36})$/.exec(raw);
  if (ack?.[1] && UUID_RE.test(ack[1])) return { kind: 'ack', eventId: ack[1] };
  const ok = /^ok:([A-Za-z0-9_-]{22})$/.exec(raw);
  if (ok?.[1]) return { kind: 'approve', id: ok[1] };
  const no = /^no:([A-Za-z0-9_-]{22})$/.exec(raw);
  if (no?.[1]) return { kind: 'deny', id: no[1] };
  return null;
}
