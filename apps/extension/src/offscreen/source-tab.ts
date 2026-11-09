// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Background tab capture (C2): the stream id comes from chrome.tabCapture.getMediaStreamId after a
 * user gesture, and is consumed here in the offscreen document.
 * SECURITY-GATE SG-23: video only; audio is always false and no biometric processing exists.
 */
export async function openTabSource(streamId: string): Promise<MediaStream> {
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxFrameRate: 10,
      },
    },
  };
  return navigator.mediaDevices.getUserMedia(constraints as unknown as MediaStreamConstraints);
}
