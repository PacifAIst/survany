// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Creates and talks to the single capture page (S4). On Chrome it is the offscreen document. Firefox has
 * no offscreen documents, so the same page runs in a pinned extension tab (the "monitor tab"), which
 * also tells the user that watching is on. Messages are the same in both cases.
 */
import type { ToOffscreen } from './messages';

export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creating: Promise<void> | null = null;

/** Firefox: the monitor tabs that are loaded (a background page can list extension views). */
function monitorViews(): Window[] {
  const path = `/${OFFSCREEN_PATH}`;
  return chrome.extension.getViews({ type: 'tab' }).filter((v) => {
    try {
      return v.location.pathname === path;
    } catch {
      return false;
    }
  });
}

export async function hasOffscreen(): Promise<boolean> {
  if (__FIREFOX__) {
    return monitorViews().length > 0;
  } else {
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
    return contexts.length > 0;
  }
}

/**
 * Makes sure the capture page exists. `focus` (Firefox) brings the monitor tab to the front, for
 * choosing a window or screen to share, which Firefox allows only from a click on that page.
 */
export async function ensureOffscreen(opts: { focus?: boolean } = {}): Promise<void> {
  if (__FIREFOX__) {
    if (monitorViews().length > 0) {
      if (opts.focus) await sendToOffscreen({ target: 'offscreen', type: 'focus' }).catch(() => undefined);
      return;
    }
    creating ??= chrome.tabs
      .create({ url: chrome.runtime.getURL(OFFSCREEN_PATH), pinned: true, active: opts.focus === true })
      .then(() => undefined)
      .finally(() => {
        creating = null;
      });
    await creating;
  } else {
    await ensureChromeOffscreen();
  }
}

async function ensureChromeOffscreen(): Promise<void> {
  if (__FIREFOX__ || (await hasOffscreen())) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [
        chrome.offscreen.Reason.USER_MEDIA,
        chrome.offscreen.Reason.DISPLAY_MEDIA,
        chrome.offscreen.Reason.WEB_RTC,
        chrome.offscreen.Reason.WORKERS,
        chrome.offscreen.Reason.BLOBS,
      ],
      justification: 'Watches the tab or camera you armed: frame analysis, 10 s clip recording and private live view.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export async function closeOffscreen(): Promise<void> {
  if (__FIREFOX__) {
    // The monitor tab removes itself (closing a tab needs its id, which only the page knows for sure).
    if (monitorViews().length > 0) await sendToOffscreen({ target: 'offscreen', type: 'close' }, 1).catch(() => undefined);
  } else if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument();
  }
}

interface Reply<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** Sends to the capture page, retrying briefly while it finishes loading. */
export async function sendToOffscreen<T>(msg: ToOffscreen, attempts = 10): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined;
      if (!r) throw new Error('no reply from offscreen document');
      if (!r.ok) throw new Error(r.error ?? 'offscreen error');
      return r.value as T;
    } catch (e) {
      lastErr = e;
      const m = e instanceof Error ? e.message : String(e);
      if (!/Receiving end does not exist|no reply/.test(m)) throw e;
      await new Promise((res) => setTimeout(res, 200));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
