// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * T0 email through one HTTP mail API (D7): browsers cannot speak SMTP. Resend's Idempotency-Key
 * makes retries safe (event_id + contact + channel).
 */
import type { AlertText } from '@survey-anything/shared';
import type { GuardedFetch } from './telegram-direct';
import { RetryableError } from './outbox';

const RESEND_URL = 'https://api.resend.com/emails';

export interface DirectEmail {
  apiKey: string;
  from: string;
  to: string;
  idempotencyKey: string;
  text: AlertText;
  snapshotJpegB64: string | null;
}

export async function resendSend(gf: GuardedFetch, m: DirectEmail): Promise<void> {
  const body: Record<string, unknown> = {
    from: m.from,
    to: [m.to],
    subject: m.text.subject,
    text: m.text.plain,
    html: m.text.emailHtml,
  };
  if (m.snapshotJpegB64) body['attachments'] = [{ filename: 'snapshot.jpg', content: m.snapshotJpegB64 }];
  let res: Response;
  try {
    res = await gf(
      RESEND_URL,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${m.apiKey}`, 'content-type': 'application/json', 'idempotency-key': m.idempotencyKey.slice(0, 256) },
        body: JSON.stringify(body),
      },
      { purpose: 'email-direct', frames: m.snapshotJpegB64 ? 'alert-media' : 'none' },
    );
  } catch (e) {
    throw new RetryableError(`email: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.ok) return;
  const detail = await res.text().catch(() => '');
  if (res.status === 429 || res.status >= 500) {
    const ra = Number(res.headers.get('retry-after'));
    throw new RetryableError(`email: HTTP ${res.status}`, Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  throw new Error(`email: HTTP ${res.status} ${detail.slice(0, 200)}`);
}
