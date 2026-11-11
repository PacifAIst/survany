// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** Popup: arm/disarm, the live indicator banner with Stop (SG-13), and status. */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { PopupStatus } from '../sw/messages';
import { sw } from '../ui/rpc';

function page(path: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}

function Popup() {
  const [s, setS] = useState<PopupStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      setS(await sw<PopupStatus>({ type: 'get-status' }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, []);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const armTab = () =>
    run(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');
      // C2: getMediaStreamId needs this user gesture; the id is consumed in the offscreen document.
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      await sw({ type: 'arm', source: { kind: 'tab', streamId, tabId: tab.id, label: (tab.title ?? 'tab').slice(0, 80) } });
    });

  const armCamera = () => run(() => sw({ type: 'arm', source: { kind: 'camera', label: 'Camera' } }));

  if (!s) return <p>{err ?? 'Loading…'}</p>;

  if (!s.consented) {
    return (
      <div>
        <h1>Survey Anything</h1>
        <p>Before anything is captured, read and accept what this extension does with your screen or camera.</p>
        <button class="primary" onClick={() => page('src/onboarding/consent/index.html')}>
          Review and accept
        </button>
      </div>
    );
  }

  return (
    <div>
      {s.streaming && (
        <div class="banner-live" role="alert">
          <span>🔴 Streaming to {s.streaming.recipients.join(', ')}</span>
          <button class="danger" style="background:#fff;color:#c0161b" disabled={busy} onClick={() => run(() => sw({ type: 'stop-stream' }))}>
            Stop
          </button>
        </div>
      )}
      <h1>Survey Anything</h1>
      {s.configErrors.length > 0 && (
        <p class="error">
          Configuration invalid, arming is blocked:{'\n'}
          {s.configErrors.slice(0, 3).join('\n')}
        </p>
      )}
      {s.armed ? (
        <div class="card">
          <div>
            <strong class="ok">● Watching</strong> {s.source?.label}
          </div>
          <div class="muted">Last scan: {s.lastTickAt ? `${Math.round((Date.now() - s.lastTickAt) / 1000)} s ago` : 'starting…'}</div>
          <button disabled={busy} onClick={() => run(() => sw({ type: 'disarm' }))}>
            Disarm
          </button>
        </div>
      ) : (
        <div class="row">
          <button class="primary" disabled={busy || s.configErrors.length > 0} onClick={armTab}>
            Watch this tab
          </button>
          <button disabled={busy || s.configErrors.length > 0 || !s.cameraGranted} onClick={armCamera}>
            Watch camera
          </button>
          {!s.cameraGranted && (
            <button onClick={() => page('src/onboarding/grant-camera/index.html')} class="muted">
              Allow camera…
            </button>
          )}
        </div>
      )}
      <p class="muted">
        AI calls today: {s.budget ? `${s.budget.localDayCalls} local (free) · ${s.budget.dayCalls} / ${s.budget.dailyMaxApiCalls} cloud` : 'n/a'}
        {s.budget?.exhausted ? ' (budget reached: unconfirmed alerts only)' : ''}
      </p>
      {s.notices.length > 0 && (
        <details>
          <summary>Recent notices</summary>
          <ul>{s.notices.map((n) => <li key={n}>{n}</li>)}</ul>
        </details>
      )}
      {err && <p class="error">{err}</p>}
      <div class="row">
        <button onClick={() => chrome.runtime.openOptionsPage()}>Settings</button>
        {!s.backendPaired && <button onClick={() => page('src/onboarding/pair-backend/index.html')}>Pair backend…</button>}
      </div>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<Popup />, root);
