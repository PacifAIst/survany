/**
 * Camera source (C3). Permission must already be granted on a visible extension page
 * (onboarding/grant-camera) because an offscreen document cannot show the prompt.
 * SECURITY-GATE SG-23: video only; audio is always false.
 */
export const CAMERA_CONSTRAINTS = (deviceId: string | null): MediaStreamConstraints => ({
  audio: false,
  video: deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 10, max: 15 } }
    : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 10, max: 15 } },
});

export async function openCameraSource(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS(deviceId));
}
