/** Creates and talks to the single offscreen document (S4). */
import type { ToOffscreen } from './messages';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
let creating: Promise<void> | null = null;

export async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

export async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
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
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

interface Reply<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/** Sends to the offscreen document, retrying briefly while it finishes loading. */
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
