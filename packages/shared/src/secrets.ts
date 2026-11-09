/**
 * SECURITY-GATE SG-21: secrets never appear in config export or in logs.
 * Config holds only `*Ref` names; secret values live in a separate store that export never reads.
 */
import type { Config } from './config';

const SECRET_KEY_RE = /(token|secret|password|passwd|pin|apikey|api_key|authorization|initdata|cookie|hmac|nonce)/i;
const SECRET_VALUE_RES: RegExp[] = [
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / OpenRouter / DeepSeek style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bre_[A-Za-z0-9_]{16,}\b/g, // Resend
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /([?&](?:t|token|key)=)[A-Za-z0-9_-]{16,}/g,
];

export function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_VALUE_RES) {
    out = out.replace(re, (m, prefix?: unknown) => (typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out;
}

/** Deep-redacts an object for logging. Keys ending in `Ref` are names, not secrets, and are kept. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) && !/Ref$/.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Export is config only. The secrets store is a different storage key and is never read here. */
export function exportConfig(config: Config): string {
  return JSON.stringify(config, null, 2);
}

/** Import accepts plain JSON and rejects anything that looks like an embedded secret value. */
export function assertNoEmbeddedSecrets(json: string): void {
  if (redactString(json) !== json) throw new Error('import rejected: the file appears to contain a secret value; keys are never imported');
}
