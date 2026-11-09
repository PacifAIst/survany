/**
 * First-run consent and data disclosure (§3 principle 8, §12, Chrome Web Store S41/S42).
 * SECURITY-GATE SG-24: an affirmative action on this page is required before any capture; arm() checks consentAt.
 */
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { SOURCE_URL } from '@survey-anything/shared';

export const CONSENT_VERSION = 1;

function Consent() {
  const [checks, setChecks] = useState({ data: false, law: false, scope: false });
  const [done, setDone] = useState(false);
  const all = checks.data && checks.law && checks.scope;

  const accept = async (): Promise<void> => {
    await chrome.storage.local.set({ consentAt: Date.now(), consentVersion: CONSENT_VERSION });
    setDone(true);
  };

  if (done) {
    return (
      <div>
        <h1>Thank you</h1>
        <p>You can now arm a tab from the toolbar button. To watch a camera, first allow camera access.</p>
        <div class="row">
          <button class="primary" onClick={() => (location.href = chrome.runtime.getURL('src/onboarding/grant-camera/index.html'))}>
            Allow camera access
          </button>
          <button onClick={() => chrome.runtime.openOptionsPage()}>Open settings</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1>Before Survey Anything watches anything</h1>
      <div class="card">
        <h2>What this extension does</h2>
        <ul>
          <li>When you arm it, it captures frames from <strong>the one tab or camera you choose</strong>. Video only: it never records audio.</li>
          <li>A free on-device check runs on every frame. Only when that check fires is a frame sent to the AI model you configured. With a cloud model, that frame leaves your computer and goes to that provider.</li>
          <li>Alerts go to the people you set up, through Telegram and/or email. If you allow alert media, they include a snapshot. Telegram and email are not end-to-end encrypted for this use.</li>
          <li>If you run the optional server, it may keep a 10-second clip for up to 24 hours (configurable down to 0) and can offer a private live view. A red "LIVE" badge and a "Streaming to…" banner are always shown while live view is on. They cannot be hidden.</li>
          <li>Device actions (for example through Home Assistant) never run without a person tapping Approve in Telegram.</li>
          <li>No telemetry. Nothing is sent to the authors of this extension.</li>
        </ul>
      </div>
      <div class="card">
        <h2>What it will never do</h2>
        <p>Face recognition, identifying or re-identifying people, emotion inference, hidden or stealth recording, audio capture, or contacting emergency services on its own.</p>
      </div>
      <div class="card">
        <h2>Your responsibilities</h2>
        <p>
          Cameras may only record areas and people you are allowed to record. In the EU, a camera limited to your home's interior is generally household use, but that exemption
          ends when you capture public space beyond a minimal strip or record household employees or carers. Read <a href={`${SOURCE_URL}/blob/main/docs/RESPONSIBLE_USE.md`} target="_blank" rel="noreferrer">Responsible use</a>. This is not legal advice.
        </p>
      </div>
      <label class="inline">
        <input type="checkbox" checked={checks.data} onChange={(e) => setChecks({ ...checks, data: (e.target as HTMLInputElement).checked })} /> I understand which data leaves my computer and when.
      </label>
      <br />
      <label class="inline">
        <input type="checkbox" checked={checks.law} onChange={(e) => setChecks({ ...checks, law: (e.target as HTMLInputElement).checked })} /> I will only watch places and people I am allowed to record.
      </label>
      <br />
      <label class="inline">
        <input type="checkbox" checked={checks.scope} onChange={(e) => setChecks({ ...checks, scope: (e.target as HTMLInputElement).checked })} /> I understand alerts need a human to act; nothing happens without my tap.
      </label>
      <div class="row" style="margin-top:12px">
        <button class="primary" disabled={!all} onClick={() => void accept()}>
          I agree, enable capture
        </button>
        <a href={`${SOURCE_URL}/blob/main/docs/PRIVACY_POLICY.md`} target="_blank" rel="noreferrer">
          Privacy policy
        </a>
      </div>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<Consent />, root);
