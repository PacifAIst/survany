/**
 * SMTP email from the backend (D7). Message-ID is derived from event_id + contact, so a retry
 * carries the same identity and never looks like a second alert.
 * SECURITY-GATE SG-12: email carries no approval link or button, ever; only view and acknowledge links that are inert on GET.
 */
import nodemailer, { type Transporter } from 'nodemailer';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  cid?: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  attachments: MailAttachment[];
}

/** Approval callback data or approval endpoints. Their presence in an email is a bug, so sending is refused. */
export const APPROVAL_PATTERN = /\b(?:ok|no):[A-Za-z0-9_-]{22}\b|\/api\/(?:actions|approvals?)\b/;

export class MailError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface Mailer {
  send(m: OutgoingMail): Promise<string>;
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(m: OutgoingMail): Promise<string> {
    if (APPROVAL_PATTERN.test(m.html) || APPROVAL_PATTERN.test(m.text)) {
      throw new MailError('refusing to email anything that looks like an approval (SG-12)', false);
    }
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        html: m.html,
        messageId: m.messageId,
        headers: { 'X-Auto-Response-Suppress': 'All', 'Auto-Submitted': 'auto-generated' },
        attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, ...(a.cid ? { cid: a.cid } : {}) })),
      });
      return String(info.messageId ?? m.messageId);
    } catch (e) {
      const err = e as { responseCode?: number; code?: string; message?: string };
      // 5xx SMTP replies are permanent; 4xx and connection problems are retried.
      const permanent = typeof err.responseCode === 'number' && err.responseCode >= 500;
      throw new MailError(`smtp: ${err.message ?? String(e)}`, !permanent);
    }
  }
}

export function messageIdFor(eventId: string, contactId: string, kind: string, host: string): string {
  return `<${eventId}.${contactId}.${kind}@${host}>`;
}
