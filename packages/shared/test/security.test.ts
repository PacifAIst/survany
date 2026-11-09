import { describe, expect, it } from 'vitest';
import {
  assertNoEmbeddedSecrets,
  buildViewerQuery,
  classifyHost,
  decodeCallback,
  encodeCallback,
  escapeTelegramHtml,
  isBlockedForProxy,
  isLocalHost,
  newId22,
  parseViewerMeta,
  redact,
  sanitizeReason,
  uuidv4,
} from '../src';

describe('SG-08 callback data <= 64 bytes', () => {
  it('property: every generated callback fits in 64 bytes and round-trips', () => {
    for (let i = 0; i < 5000; i++) {
      for (const d of [
        { kind: 'ack', eventId: uuidv4() } as const,
        { kind: 'approve', id: newId22() } as const,
        { kind: 'deny', id: newId22() } as const,
      ]) {
        const s = encodeCallback(d);
        expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(64);
        expect(decodeCallback(s)).toEqual(d);
      }
    }
  });

  it('rejects malformed and oversized callback data', () => {
    expect(() => encodeCallback({ kind: 'ack', eventId: 'not-a-uuid' })).toThrow();
    expect(decodeCallback('ack:' + 'a'.repeat(70))).toBeNull();
    expect(decodeCallback('ok:short')).toBeNull();
    expect(decodeCallback('exec:rm -rf')).toBeNull();
    expect(decodeCallback(42)).toBeNull();
  });
});

describe('SG-17 reason sanitization', () => {
  it('strips URLs, bare domains, IPs and mentions', () => {
    const s = sanitizeReason('Fire! see https://evil.example/x and www.bad.io, evil.com/p, 10.0.0.1:8080 @someone /unlock now');
    expect(s).not.toMatch(/evil|bad\.io|10\.0\.0\.1|@someone|\/unlock/);
    expect(s).toContain('[link removed]');
    expect(s).toContain('Fire!');
  });

  it('removes control and bidi characters, collapses whitespace, caps length', () => {
    const s = sanitizeReason('a‮b\u0000c\n\n\td' + 'x'.repeat(1000));
    expect(s.startsWith('a b c d')).toBe(true);
    expect([...s].length).toBeLessThanOrEqual(280);
    expect(s.endsWith('…')).toBe(true);
  });

  it('escapes Telegram HTML', () => {
    expect(escapeTelegramHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('returns empty for non-strings', () => {
    expect(sanitizeReason({ toString: () => 'x' })).toBe('');
  });
});

describe('SG-27 viewer-link metadata', () => {
  const meta = { eventId: uuidv4(), rule: 'fire', severity: 'critical' as const, timestamp: '2026-11-09T10:11:12.000Z' };

  it('round-trips valid metadata', () => {
    const q = buildViewerQuery('tok', meta);
    expect(parseViewerMeta(new URLSearchParams(q))).toEqual(meta);
  });

  it('drops malformed, oversized, HTML-bearing and duplicated values independently', () => {
    const p = new URLSearchParams();
    p.set('event_id', '<img src=x onerror=alert(1)>');
    p.set('rule', 'Fire<script>');
    p.set('severity', 'catastrophic');
    p.set('timestamp', '2026-02-31T00:00:00Z');
    expect(parseViewerMeta(p)).toEqual({});
    const q = new URLSearchParams();
    q.append('rule', 'fire');
    q.append('rule', 'robbery');
    q.set('severity', 'x'.repeat(65));
    q.set('event_id', meta.eventId);
    expect(parseViewerMeta(q)).toEqual({ eventId: meta.eventId });
  });

  it('never accepts free text', () => {
    expect(() => buildViewerQuery('t', { ...meta, rule: 'reason with spaces' })).toThrow();
  });
});

describe('SG-21 secrets excluded from logs and import', () => {
  it('redacts secret keys and secret-shaped values', () => {
    const out = redact({
      apiKeyRef: 'key_openrouter',
      deviceToken: 'abc',
      nested: { msg: 'bot TEST_BOT_TOKEN_NOT_REAL used, Bearer abcdefghijklmnopqrstu' },
      url: 'https://x/v?t=AAAAAAAAAAAAAAAAAAAAAAAA&rule=fire',
    }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.apiKeyRef).toBe('key_openrouter');
    expect(out.deviceToken).toBe('[redacted]');
    expect(out.nested.msg).not.toMatch(/AAHdq|abcdefghijklmnop/);
    expect(out.url).toBe('https://x/v?t=[redacted]&rule=fire');
  });

  it('rejects an import that embeds a key', () => {
    expect(() => assertNoEmbeddedSecrets('{"x":"sk-abcdefghijklmnopqrstuvwxyz"}')).toThrow();
    expect(() => assertNoEmbeddedSecrets('{"apiKeyRef":"key_openai"}')).not.toThrow();
  });
});

describe('host classification', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['localhost', 'loopback'],
    ['[::1]', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.0.10', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['[::ffff:7f00:1]', 'loopback'],
    ['fd00::1', 'private'],
    ['fe80::1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['8.8.8.8', 'public'],
    ['api.openai.com', 'hostname'],
  ])('%s -> %s', (host, cls) => {
    expect(classifyHost(host)).toBe(cls);
  });

  it('local means loopback or RFC 1918 only', () => {
    expect(isLocalHost('192.168.1.1')).toBe(true);
    expect(isLocalHost('ollama.lan')).toBe(false);
    expect(isLocalHost('100.64.1.1')).toBe(false);
  });

  it('SG-19 proxy blocks every non-public address', () => {
    for (const h of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fd12::1', '0.0.0.0', '100.100.100.100']) {
      expect(isBlockedForProxy(h)).toBe(true);
    }
    expect(isBlockedForProxy('1.1.1.1')).toBe(false);
  });
});
