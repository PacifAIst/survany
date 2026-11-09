/**
 * Alert dispatch from the extension (§4.3 step 5, §10).
 * T1+: one POST to the backend, which fans out to every channel in parallel.
 * T0 (or backend unreachable): every configured direct channel starts at the same moment;
 * none waits for another, and each failure gets its own outbox entry.
 */
import {
  type AlertTextInput,
  buildAlertText,
  type Config,
  type EventResponse,
  type EventSubmission,
  type Severity,
  type UnconfirmedReason,
} from '@survey-anything/shared';
import { beginLiveIndicator } from './badge';
import { resendSend } from './email-direct';
import { applyEgressPolicy, canEmailSnapshot, canSendAlertMedia, canStreamLive, canUploadClip } from './egress-policy';
import type { ClipPayload } from './messages';
import { sendToOffscreen } from './offscreen-host';
import { enqueue, RetryableError } from './outbox';
import { backendClient, guardedFetch } from './runtime';
import * as store from './storage';
import { telegramSendAlert } from './telegram-direct';

export interface AlertDraft {
  eventId: string;
  rule: string;
  ruleTitle: string;
  severity: Severity;
  confirmed: boolean;
  unconfirmedReason: UnconfirmedReason | null;
  confidence: number;
  provider: string | null;
  reason: string;
  timestamp: string;
  sourceLabel: string;
  recipients: string[];
  snapshotB64: string | null;
}

export interface DirectSendPayload {
  draft: AlertDraft;
  contact: string;
}

export function toSubmission(d: AlertDraft, c: Config): EventSubmission {
  return applyEgressPolicy(
    {
      eventId: d.eventId,
      rule: d.rule,
      ruleTitle: d.ruleTitle,
      severity: d.severity,
      confirmed: d.confirmed,
      unconfirmedReason: d.unconfirmedReason,
      confidence: d.confidence,
      provider: d.provider,
      reason: d.reason.slice(0, 4000),
      timestamp: d.timestamp,
      sourceLabel: d.sourceLabel.slice(0, 200),
      recipients: d.recipients,
      channels: c.alerts.channels,
      snapshotJpegB64: d.snapshotB64,
      wantLiveView: true,
      ackTimeoutSec: c.alerts.ackTimeoutSec,
      streamTtlMinutes: c.stream.ttlMinutes,
    },
    c,
  );
}

function textInput(d: AlertDraft): AlertTextInput {
  return { ...d, linkExpiresAt: null };
}

export async function sendDirectTelegram(p: DirectSendPayload): Promise<void> {
  const { config } = await store.loadConfig();
  const tg = config?.direct.telegram;
  const chat = tg?.chatIds[p.contact];
  if (!config || !tg || !chat) throw new Error(`no direct Telegram chat for ${p.contact}`);
  const token = await store.secret(tg.botTokenRef);
  if (!token) throw new Error('Telegram bot token missing');
  await telegramSendAlert(guardedFetch, token, chat, buildAlertText(textInput(p.draft)), canSendAlertMedia(config) ? p.draft.snapshotB64 : null);
}

export async function sendDirectEmail(p: DirectSendPayload): Promise<void> {
  const { config } = await store.loadConfig();
  const em = config?.direct.email;
  const to = em?.addresses[p.contact];
  if (!config || !em || !to) throw new Error(`no direct email address for ${p.contact}`);
  const key = await store.secret(em.apiKeyRef);
  if (!key) throw new Error('mail API key missing');
  await resendSend(guardedFetch, {
    apiKey: key,
    from: em.from,
    to,
    idempotencyKey: `${p.draft.eventId}:${p.contact}:email`,
    text: buildAlertText(textInput(p.draft)),
    snapshotJpegB64: canEmailSnapshot(config) ? p.draft.snapshotB64 : null,
  });
}

/** T0: all configured channels for all recipients start together. Returns per-send outcomes. */
export async function dispatchDirect(d: AlertDraft, c: Config): Promise<{ key: string; ok: boolean; error: string | null }[]> {
  const jobs: { key: string; kind: 'telegram' | 'email'; run: () => Promise<void>; payload: DirectSendPayload }[] = [];
  for (const contact of d.recipients) {
    const payload = { draft: d, contact };
    if (c.alerts.channels.includes('telegram') && c.direct.telegram?.chatIds[contact]) {
      jobs.push({ key: `${d.eventId}:${contact}:telegram`, kind: 'telegram', run: () => sendDirectTelegram(payload), payload });
    }
    if (c.alerts.channels.includes('email') && c.direct.email?.addresses[contact]) {
      jobs.push({ key: `${d.eventId}:${contact}:email`, kind: 'email', run: () => sendDirectEmail(payload), payload });
    }
  }
  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const out: { key: string; ok: boolean; error: string | null }[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const s = settled[i];
    if (!j || !s) continue;
    if (s.status === 'fulfilled') out.push({ key: j.key, ok: true, error: null });
    else {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      out.push({ key: j.key, ok: false, error: msg });
      if (s.reason instanceof RetryableError) await enqueue(j.kind, j.key, j.payload, msg);
    }
  }
  return out;
}

async function localNotification(d: AlertDraft): Promise<void> {
  const t = buildAlertText(textInput(d));
  await chrome.notifications.create(`sa-alert-${d.eventId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: t.subject.slice(0, 120),
    message: t.plain.split('\n').slice(1, 4).join('\n').slice(0, 300),
    priority: 2,
  });
}

async function uploadClipFor(eventId: string): Promise<void> {
  const backend = await backendClient();
  if (!backend) return;
  const clip = await sendToOffscreen<ClipPayload | null>({ target: 'offscreen', type: 'get-clip' });
  if (!clip) throw new RetryableError('no complete clip yet');
  await backend.uploadClip(eventId, clip);
}

export async function sendBackendEvent(sub: EventSubmission): Promise<void> {
  const backend = await backendClient();
  if (!backend) throw new Error('backend not paired');
  await handleEventResponse(sub, await backend.postEvent(sub));
}

async function handleEventResponse(sub: EventSubmission, res: EventResponse): Promise<void> {
  const { config } = await store.loadConfig();
  if (!config) return;
  if (canUploadClip(config)) {
    // The alert is already out; the clip only matters on a §10 failure path, so it never delays anything.
    void uploadClipFor(sub.eventId).catch(async (e: unknown) => {
      await enqueue('backend-clip', `${sub.eventId}:clip`, { eventId: sub.eventId }, e instanceof Error ? e.message : String(e));
    });
  }
  if (res.stream && canStreamLive(config)) {
    try {
      await beginLiveIndicator(sub.eventId, sub.recipients);
      await sendToOffscreen({ target: 'offscreen', type: 'whip-start', url: res.stream.whipUrl, iceServers: res.stream.iceServers });
      chrome.alarms.create('stream-end', { when: Date.parse(res.stream.expiresAt) });
    } catch (e) {
      await store.appendLog(`live view not started: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export async function uploadClipFromOutbox(payload: unknown): Promise<void> {
  const p = payload as { eventId: string };
  await uploadClipFor(p.eventId);
}

/** Entry point for every alert, confirmed or not. */
export async function dispatchAlert(d: AlertDraft, c: Config): Promise<void> {
  await localNotification(d).catch(() => undefined);
  const backend = await backendClient();
  if (backend) {
    const sub = toSubmission(d, c);
    try {
      await handleEventResponse(sub, await backend.postEvent(sub));
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await store.appendLog(`backend alert failed: ${msg}`);
      // §10 "Backend unreachable": queue locally, retry, notify, and use T0 direct send if configured.
      await enqueue('backend-event', `${d.eventId}:backend`, sub, msg);
      await chrome.notifications.create(`sa-backend-down-${d.eventId}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: 'Backend unreachable: alert queued',
        message: 'The alert will be retried. Direct channels are used if configured.',
        priority: 2,
      });
    }
  }
  const results = await dispatchDirect(d, c);
  if (results.length > 0 && results.every((r) => !r.ok)) {
    await chrome.action.setBadgeBackgroundColor({ color: '#c0161b' });
    await chrome.action.setBadgeText({ text: '!' });
  }
}
