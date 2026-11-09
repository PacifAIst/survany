/**
 * Untrusted model text handling (principle 7).
 * SECURITY-GATE SG-17: `reason` is sanitized, length-capped, URL-stripped and escaped before Telegram or email.
 * Shared so the backend and the T0 direct senders apply identical rules.
 */
import { REASON_MAX_CHARS } from './defaults';

const URL_LIKE = [
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/\S+/gi, // scheme://...
  /\bwww\.\S+/gi,
  /\b(?:[a-z0-9-]{1,63}\.)+(?:[a-z]{2,24})(?::\d{1,5})?(?:\/\S*)?/gi, // bare domains (Telegram auto-links them)
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/\S*)?/g, // IPv4 literals
  /\b(?:mailto|tel|sms|javascript|data|tg):\S+/gi,
];

export const LINK_PLACEHOLDER = '[link removed]';

export function sanitizeReason(input: unknown, maxChars = REASON_MAX_CHARS): string {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFKC');
  // Control, format (bidi overrides, zero-width) and private-use characters.
  s = s.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, ' ');
  for (const re of URL_LIKE) s = s.replace(re, LINK_PLACEHOLDER);
  // @mentions and #commands would ping users or trigger bot commands.
  s = s.replace(/(^|\s)[@/][A-Za-z0-9_]{2,}/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  if ([...s].length > maxChars) s = [...s].slice(0, maxChars - 1).join('') + '…';
  return s;
}

/** Telegram parse_mode=HTML escaping: only &, < and > are special (S13). */
export function escapeTelegramHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Short single-line labels (source label, rule title) supplied by the user or a recipe. */
export function sanitizeLabel(input: unknown, maxChars = 80): string {
  return sanitizeReason(input, maxChars);
}
