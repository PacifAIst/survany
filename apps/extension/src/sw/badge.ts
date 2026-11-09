/**
 * Visible indicators (§3 principle 5).
 * SECURITY-GATE SG-13: a stream cannot start until the LIVE badge and the "Streaming to" banner are set and verified; no config flag exists to hide them.
 */
import * as store from './storage';

export const LIVE_BADGE = 'LIVE';
const LIVE_NOTIFICATION_ID = 'sa-live';

export type IndicatorState = 'off' | 'armed' | 'live' | 'error';

export async function setIndicator(state: IndicatorState, detail = ''): Promise<void> {
  switch (state) {
    case 'off':
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'Survey Anything: not watching' });
      break;
    case 'armed':
      await chrome.action.setBadgeBackgroundColor({ color: '#1f7a3d' });
      await chrome.action.setBadgeText({ text: 'ON' });
      await chrome.action.setTitle({ title: `Survey Anything: watching ${detail}` });
      break;
    case 'live':
      await chrome.action.setBadgeBackgroundColor({ color: '#c0161b' });
      await chrome.action.setBadgeText({ text: LIVE_BADGE });
      await chrome.action.setTitle({ title: `🔴 Streaming to ${detail}` });
      break;
    case 'error':
      await chrome.action.setBadgeBackgroundColor({ color: '#c0161b' });
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setTitle({ title: `Survey Anything: ${detail}` });
      break;
  }
}

/**
 * Sets the badge, the persisted banner (shown by the popup and options page) and a persistent
 * notification, then reads the badge back. Throws if any of them did not take effect, in which
 * case the caller must not start the stream.
 */
export async function beginLiveIndicator(eventId: string, recipients: string[]): Promise<void> {
  const who = recipients.join(', ') || 'your contacts';
  await setIndicator('live', who);
  await store.set('streaming', { eventId, recipients, since: Date.now() });
  await chrome.notifications.create(LIVE_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: `🔴 Streaming to ${who}`,
    message: 'Live view is on. Open the extension and press Stop to end it.',
    requireInteraction: true,
    priority: 2,
  });
  const text = await chrome.action.getBadgeText({});
  const banner = await store.get('streaming');
  if (text !== LIVE_BADGE || banner?.eventId !== eventId) {
    throw new Error('SG-13: live indicator could not be verified; refusing to stream');
  }
}

export async function endLiveIndicator(armedLabel: string | null): Promise<void> {
  await store.set('streaming', null);
  await chrome.notifications.clear(LIVE_NOTIFICATION_ID);
  await setIndicator(armedLabel ? 'armed' : 'off', armedLabel ?? '');
}
