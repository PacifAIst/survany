// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Camera source (C3). Permission must already be granted on a visible extension page
 * (onboarding/grant-camera) because an offscreen document cannot show the prompt.
 * SECURITY-GATE SG-23: video only; audio is always false.
 *
 * Which camera: the one chosen on the camera page, else the browser's default unless that is a virtual
 * camera and a real one exists. Found 2026-11-12 in Firefox: its default was "Camera (NVIDIA Broadcast)",
 * a virtual camera that delivers no frames while the NVIDIA Broadcast app is closed, so watching stayed
 * dark while Chrome picked the real "Integrated Camera".
 */
export const CAMERA_CONSTRAINTS = (deviceId: string | null): MediaStreamConstraints => ({
  audio: false,
  video: deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 10, max: 15 } }
    : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 10, max: 15 } },
});

/** Cameras that are software (they show what an app feeds them, often nothing). */
export const VIRTUAL_CAMERA = /virtual|nvidia broadcast|\bobs\b|snap camera|manycam|xsplit|splitcam|e2esoft|vcam/i;

export interface CameraInfo {
  deviceId: string;
  label: string;
}

/** The camera to open: the chosen one if it still exists, else the first real (non-virtual) one, else none. */
export function pickCamera(cameras: readonly CameraInfo[], chosenId: string | null): string | null {
  if (chosenId && cameras.some((c) => c.deviceId === chosenId)) return chosenId;
  return cameras.find((c) => c.deviceId && c.label && !VIRTUAL_CAMERA.test(c.label))?.deviceId ?? null;
}

export async function listCameras(): Promise<CameraInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput' && d.deviceId).map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

export async function openCameraSource(chosenId: string | null): Promise<MediaStream> {
  if (chosenId) {
    try {
      return await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS(chosenId));
    } catch (e) {
      // The chosen camera is gone (unplugged, renamed id): fall back to the automatic choice below.
      if (!(e instanceof DOMException) || !['OverconstrainedError', 'NotFoundError'].includes(e.name)) throw e;
    }
  }
  const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS(null));
  const label = stream.getVideoTracks()[0]?.label ?? '';
  if (!VIRTUAL_CAMERA.test(label)) return stream;
  // The default is a virtual camera: use a real one if there is one (labels are readable now that a stream is open).
  const real = pickCamera(await listCameras().catch(() => []), null);
  if (!real) return stream;
  stream.getTracks().forEach((t) => t.stop());
  return navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS(real));
}
