/**
 * Alert wording shared by the backend templates and the T0 direct senders, so every channel says
 * the same thing (§4.3 "Email alert contents"). All free text passes through sanitizeReason (SG-17).
 */
import { escapeHtml, escapeTelegramHtml, sanitizeLabel, sanitizeReason } from './sanitize';
import type { Severity } from './viewer-meta';

export interface AlertTextInput {
  eventId: string;
  ruleTitle: string;
  severity: Severity;
  confirmed: boolean;
  unconfirmedReason: 'all-providers-failed' | 'budget' | 'vision-disabled' | null;
  confidence: number;
  provider: string | null;
  reason: string;
  timestamp: string;
  sourceLabel: string;
  /** Present only when T2 live view exists for this recipient. */
  linkExpiresAt: string | null;
}

const SEVERITY_ICON: Record<Severity, string> = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };

const UNCONFIRMED_TEXT: Record<NonNullable<AlertTextInput['unconfirmedReason']>, string> = {
  'all-providers-failed': 'UNCONFIRMED: no AI model could check this (on-device gate only)',
  budget: 'UNCONFIRMED: AI budget reached for today (on-device gate only)',
  'vision-disabled': 'UNCONFIRMED: AI confirmation is turned off (on-device gate only)',
};

export interface AlertText {
  subject: string;
  telegramHtml: string;
  plain: string;
  emailHtml: string;
}

export function buildAlertText(a: AlertTextInput): AlertText {
  const title = sanitizeLabel(a.ruleTitle, 80) || 'Event';
  const source = sanitizeLabel(a.sourceLabel, 80) || 'monitored source';
  const reason = sanitizeReason(a.reason);
  const status = a.confirmed ? `Confirmed by ${sanitizeLabel(a.provider ?? 'model', 40)}` : UNCONFIRMED_TEXT[a.unconfirmedReason ?? 'all-providers-failed'];
  const conf = a.confirmed ? `${Math.round(a.confidence * 100)}%` : 'n/a';
  const lines: [string, string][] = [
    ['Status', status],
    ['Severity', a.severity],
    ['Confidence', conf],
    ['Source', source],
    ['Time (UTC)', a.timestamp],
    ['Event ID', a.eventId],
  ];
  if (a.linkExpiresAt) lines.push(['Live link expires', a.linkExpiresAt]);
  const subject = `${SEVERITY_ICON[a.severity]} ${a.confirmed ? '' : '[UNCONFIRMED] '}${title} — ${source}`;
  const plain = [subject, '', reason ? `Model note: ${reason}` : '', ...lines.map(([k, v]) => `${k}: ${v}`)].filter((x) => x !== '').join('\n');
  const telegramHtml = [
    `<b>${escapeTelegramHtml(subject)}</b>`,
    reason ? `<i>${escapeTelegramHtml(reason)}</i>` : '',
    ...lines.map(([k, v]) => `${escapeTelegramHtml(k)}: ${escapeTelegramHtml(v)}`),
  ]
    .filter((x) => x !== '')
    .join('\n');
  const emailHtml = [
    `<h2 style="margin:0 0 8px">${escapeHtml(subject)}</h2>`,
    reason ? `<p><em>${escapeHtml(reason)}</em></p>` : '',
    '<table cellpadding="4">',
    ...lines.map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`),
    '</table>',
  ]
    .filter((x) => x !== '')
    .join('\n');
  return { subject, telegramHtml, plain, emailHtml };
}
