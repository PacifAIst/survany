/**
 * C3: an offscreen document cannot show the camera permission prompt, so the grant happens here,
 * on a visible extension page. Video only (SG-23); the preview tracks are stopped immediately.
 */
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { CAMERA_CONSTRAINTS } from '../../offscreen/source-camera';

function Grant() {
  const [state, setState] = useState<'idle' | 'ok' | 'denied' | 'no-consent'>('idle');
  const [msg, setMsg] = useState('');

  const ask = async (): Promise<void> => {
    const { consentAt } = await chrome.storage.local.get('consentAt');
    if (!consentAt) {
      setState('no-consent');
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS(null));
      s.getTracks().forEach((t) => t.stop());
      await chrome.storage.local.set({ cameraGranted: true });
      setState('ok');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setState('denied');
    }
  };

  return (
    <div>
      <h1>Allow camera access</h1>
      <p>Chrome asks once, here. Afterwards the extension can watch the camera in the background while you use other tabs. It never records audio.</p>
      {state === 'no-consent' && <p class="error">Accept the consent screen first.</p>}
      {state === 'denied' && <p class="error">Camera access was not granted: {msg}</p>}
      {state === 'ok' ? (
        <p class="ok">Camera access granted. Use "Watch camera" in the toolbar popup.</p>
      ) : (
        <button class="primary" onClick={() => void ask()}>
          Allow camera
        </button>
      )}
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<Grant />, root);
