// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * C3: an offscreen document cannot show the camera permission prompt, so the grant happens here,
 * on a visible extension page. Video only (SG-23); the preview tracks are stopped immediately.
 * It is also where the camera to watch is chosen, when the computer has more than one (real or virtual).
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { CAMERA_CONSTRAINTS, type CameraInfo, listCameras, pickCamera, VIRTUAL_CAMERA } from '../../offscreen/source-camera';

function Grant() {
  const [state, setState] = useState<'idle' | 'ok' | 'denied' | 'no-consent'>('idle');
  const [msg, setMsg] = useState('');
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    void chrome.storage.local.get(['cameraGranted', 'cameraDeviceId']).then((s) => {
      setChosen((s['cameraDeviceId'] as string | null | undefined) ?? null);
      if (s['cameraGranted']) setState('ok');
    });
  }, []);

  const choose = async (id: string, list: readonly CameraInfo[]): Promise<void> => {
    setChosen(id);
    await chrome.storage.local.set({ cameraDeviceId: id, cameraLabel: list.find((c) => c.deviceId === id)?.label ?? null });
  };

  const ask = async (): Promise<void> => {
    const { consentAt } = await chrome.storage.local.get('consentAt');
    if (!consentAt) {
      setState('no-consent');
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS(null));
      // Camera names are readable only while permission is granted, so list them now.
      const list = await listCameras().catch(() => []);
      s.getTracks().forEach((t) => t.stop());
      await chrome.storage.local.set({ cameraGranted: true });
      setCameras(list);
      const { cameraDeviceId } = (await chrome.storage.local.get('cameraDeviceId')) as { cameraDeviceId?: string | null };
      const pick = pickCamera(list, cameraDeviceId ?? null) ?? list[0]?.deviceId ?? null;
      if (pick) await choose(pick, list);
      setState('ok');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setState('denied');
    }
  };

  return (
    <div>
      <h1>Allow camera access</h1>
      <p>Your browser asks once, here. Afterwards the extension can watch the camera in the background while you use other tabs. It never records audio.</p>
      {state === 'no-consent' && <p class="error">Accept the consent screen first.</p>}
      {state === 'denied' && <p class="error">Camera access was not granted: {msg}</p>}
      {state === 'ok' && <p class="ok">Camera access granted. Use "Watch camera" in the toolbar popup.</p>}
      {cameras.length > 0 && (
        <fieldset data-testid="cameras">
          <legend>Camera to watch</legend>
          {cameras.map((c) => (
            <label key={c.deviceId}>
              <input type="radio" name="camera" checked={chosen === c.deviceId} onChange={() => void choose(c.deviceId, cameras)} /> {c.label || 'Unnamed camera'}
              {VIRTUAL_CAMERA.test(c.label) && <span class="muted"> (virtual: shows only what its app sends; nothing while the app is closed)</span>}
            </label>
          ))}
        </fieldset>
      )}
      <button class="primary" onClick={() => void ask()}>
        {state === 'ok' ? 'Choose the camera' : 'Allow camera'}
      </button>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<Grant />, root);
