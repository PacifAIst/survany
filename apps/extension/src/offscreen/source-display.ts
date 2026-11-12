// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Window or screen source (Firefox, which has no tab capture). Firefox shows its sharing picker only
 * from a click on the page that asks, so the monitor tab shows a button and waits for it.
 * SECURITY-GATE SG-23: video only; audio is always false.
 */
export const DISPLAY_PICK_TIMEOUT_MS = 120_000;

export async function openDisplaySource(button: HTMLButtonElement, timeoutMs = DISPLAY_PICK_TIMEOUT_MS): Promise<MediaStream> {
  button.hidden = false;
  button.focus();
  try {
    return await new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no window or screen was chosen within 2 minutes')), timeoutMs);
      button.onclick = () => {
        clearTimeout(timer);
        navigator.mediaDevices
          .getDisplayMedia({ video: { frameRate: { ideal: 10, max: 10 } }, audio: false })
          .then(resolve, (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
      };
    });
  } finally {
    button.onclick = null;
    button.hidden = true;
  }
}
