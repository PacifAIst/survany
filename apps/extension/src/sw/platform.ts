// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The few places Chrome and Firefox differ (one code base, two builds; __FIREFOX__ is set at build time):
 *  - Chrome has offscreen documents and tab capture.
 *  - Firefox has neither: capture runs in a pinned extension tab ("monitor tab"), and the alternative to
 *    watching a tab is sharing a window or the screen through Firefox's own picker.
 */
export function hasOffscreenApi(): boolean {
  return !__FIREFOX__;
}

export function hasTabCapture(): boolean {
  return !__FIREFOX__;
}

/**
 * Notification options both browsers accept. Firefox supports only basic notifications without
 * requireInteraction or priority, so those are dropped there.
 */
export function notificationOptions<T extends chrome.notifications.NotificationOptions>(o: T): T {
  if (!__FIREFOX__) return o;
  const { requireInteraction: _r, priority: _p, ...rest } = o;
  return rest as T;
}
