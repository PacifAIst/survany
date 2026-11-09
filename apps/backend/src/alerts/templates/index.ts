// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** Alert message content per channel (§4.3 "Email alert contents"). Built from stored, sanitized fields only. */
import { type AlertText, buildAlertText, escapeHtml, type Severity } from '@survey-anything/shared';

export interface EventRow {
  id: string;
  device_id: string;
  rule: string;
  rule_title: string;
  severity: string;
  confirmed: number;
  unconfirmed_reason: string | null;
  confidence: number;
  provider: string | null;
  reason: string;
  ts: string;
  source_label: string;
  recipients: string;
  channels: string;
  ack_timeout_sec: number;
  created_at: number;
  acked_at: number | null;
  acked_by: string | null;
  ack_channel: string | null;
  escalation_stage: number;
  snapshot_path: string | null;
  clip_path: string | null;
  clip_mime: string | null;
  clip_wanted: number;
}

export function alertTextFor(ev: EventRow, linkExpiresAt: string | null, prefix = ''): AlertText {
  const t = buildAlertText({
    eventId: ev.id,
    ruleTitle: ev.rule_title,
    severity: ev.severity as Severity,
    confirmed: ev.confirmed === 1,
    unconfirmedReason: (ev.unconfirmed_reason as 'all-providers-failed' | 'budget' | 'vision-disabled' | null) ?? null,
    confidence: ev.confidence,
    provider: ev.provider,
    reason: ev.reason,
    timestamp: ev.ts,
    sourceLabel: ev.source_label,
    linkExpiresAt,
  });
  if (!prefix) return t;
  return { ...t, subject: `${prefix} ${t.subject}`, plain: `${prefix}\n${t.plain}`, telegramHtml: `<b>${escapeHtml(prefix)}</b>\n${t.telegramHtml}`, emailHtml: `<p><strong>${escapeHtml(prefix)}</strong></p>${t.emailHtml}` };
}

export interface EmailLinks {
  viewUrl: string | null;
  ackUrl: string | null;
  sourceUrl: string;
}

export function emailBody(t: AlertText, links: EmailLinks, hasSnapshot: boolean): { html: string; text: string } {
  const parts = [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:640px">',
    t.emailHtml,
    hasSnapshot ? '<p><img src="cid:snapshot" alt="Snapshot at the time of the event" style="max-width:100%;border-radius:6px"></p>' : '',
    links.viewUrl
      ? `<p><a href="${escapeHtml(links.viewUrl)}" style="display:inline-block;padding:10px 16px;background:#1f5fbf;color:#fff;border-radius:6px;text-decoration:none">▶ View live</a> <small>(asks for your PIN)</small></p>`
      : '',
    links.ackUrl ? `<p><a href="${escapeHtml(links.ackUrl)}">✅ Acknowledge</a> <small>(asks for your PIN)</small></p>` : '',
    '<hr><p style="color:#666;font-size:12px">Sent by Survey Anything. This email cannot approve any action. ',
    `Email is not end-to-end encrypted. <a href="${escapeHtml(links.sourceUrl)}">Source code (AGPL-3.0)</a></p>`,
    '</body></html>',
  ];
  const text = [t.plain, '', links.viewUrl ? `View live (asks for your PIN): ${links.viewUrl}` : '', links.ackUrl ? `Acknowledge (asks for your PIN): ${links.ackUrl}` : '', '', `Source code (AGPL-3.0): ${links.sourceUrl}`]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  return { html: parts.join('\n'), text };
}
