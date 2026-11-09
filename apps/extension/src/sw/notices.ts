/**
 * Operational notices to the owner (§10): budget exhausted, camera offline (≤ 1 per hour),
 * re-arm needed, offscreen failure. Always a local notification; also the backend (T1+) or the
 * T0 direct channels to the owner.
 */
import { CAMERA_OFFLINE_NOTICE_INTERVAL_MS, escapeTelegramHtml, type NoticeKind } from '@survey-anything/shared';
import { resendSend } from './email-direct';
import { enqueue, RetryableError } from './outbox';
import { backendClient, guardedFetch } from './runtime';
import * as store from './storage';
import { telegramSendText } from './telegram-direct';

const MIN_INTERVAL: Partial<Record<NoticeKind, number>> = {
  'camera-offline': CAMERA_OFFLINE_NOTICE_INTERVAL_MS,
  'budget-exhausted': 24 * 60 * 60 * 1000,
  'channel-failing': 60 * 60 * 1000,
  'live-view-udp-unavailable': 24 * 60 * 60 * 1000,
};

const TITLES: Record<NoticeKind, string> = {
  'budget-exhausted': 'AI budget reached: gate-only "unconfirmed" alerts until tomorrow',
  'camera-offline': 'Camera offline',
  're-arm-needed': 'Re-arm needed',
  'offscreen-failed': 'Capture stopped',
  'live-view-udp-unavailable': 'Live view will use the TCP relay',
  'channel-failing': 'An alert channel is failing',
};

export async function raiseNotice(kind: NoticeKind, detail: string, now = Date.now()): Promise<boolean> {
  const sent = await store.get('noticesSentAt');
  const min = MIN_INTERVAL[kind] ?? 0;
  if (min > 0 && sent[kind] !== undefined && now - (sent[kind] ?? 0) < min) return false;
  await store.set('noticesSentAt', { ...sent, [kind]: now });
  await store.update('recentNotices', (l) => [...l.slice(-19), `${new Date(now).toISOString()} ${TITLES[kind]}: ${detail}`]);
  await chrome.notifications.create(`sa-notice-${kind}-${now}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: TITLES[kind],
    message: detail.slice(0, 300),
    priority: 1,
  });
  const backend = await backendClient();
  if (backend) {
    try {
      await backend.notice({ kind, detail: detail.slice(0, 500) });
    } catch (e) {
      if (e instanceof RetryableError) await enqueue('backend-notice', `notice:${kind}:${now}`, { kind, detail }, e.message, now);
    }
    return true;
  }
  const { config } = await store.loadConfig();
  if (!config) return true;
  const text = `<b>${escapeTelegramHtml(TITLES[kind])}</b>\n${escapeTelegramHtml(detail)}`;
  const tasks: Promise<void>[] = [];
  const tg = config.direct.telegram;
  const ownerChat = tg?.chatIds['owner'];
  if (tg && ownerChat && config.alerts.channels.includes('telegram')) {
    const token = await store.secret(tg.botTokenRef);
    if (token) tasks.push(telegramSendText(guardedFetch, token, ownerChat, text));
  }
  const em = config.direct.email;
  const ownerMail = em?.addresses['owner'];
  if (em && ownerMail && config.alerts.channels.includes('email')) {
    const key = await store.secret(em.apiKeyRef);
    if (key) {
      tasks.push(
        resendSend(guardedFetch, {
          apiKey: key,
          from: em.from,
          to: ownerMail,
          idempotencyKey: `notice:${kind}:${now}`,
          snapshotJpegB64: null,
          text: { subject: TITLES[kind], plain: detail, telegramHtml: text, emailHtml: `<p>${escapeTelegramHtml(detail)}</p>` },
        }),
      );
    }
  }
  await Promise.allSettled(tasks);
  return true;
}
