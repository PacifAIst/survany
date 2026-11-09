// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * C17: the extension authenticates to the backend with a device token obtained from a one-time
 * pairing code (SG-16 is enforced by the backend). The token is stored as a secret, never in config.
 */
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { PairDeviceResponseSchema } from '@survey-anything/shared';
import { requestHost, sw } from '../../ui/rpc';

function Pair() {
  const [url, setUrl] = useState('https://');
  const [code, setCode] = useState('');
  const [name, setName] = useState('My browser');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const pair = async (): Promise<void> => {
    setMsg(null);
    try {
      const base = new URL(url).origin;
      if (!(await requestHost(base))) throw new Error('Permission to reach the backend was not granted.');
      // Pairing is the one backend call made from this page: there is no device token yet.
      const r = await pairRequest(base, code.trim().toUpperCase(), name.trim());
      const { secrets = {} } = (await chrome.storage.local.get('secrets')) as { secrets?: Record<string, string> };
      await chrome.storage.local.set({
        secrets: { ...secrets, key_device_token: r.deviceToken },
        device: { deviceId: r.deviceId, tokenRef: 'key_device_token', backendUrl: base, capabilities: r.capabilities },
      });
      const { config } = (await chrome.storage.local.get('config')) as { config?: Record<string, unknown> };
      if (config) await sw({ type: 'save-config', config: { ...config, backend: { url: base } } }).catch(() => undefined);
      setMsg({ ok: true, text: `Paired as ${r.deviceId}. Telegram: ${r.capabilities.telegram ? 'yes' : 'no'}, email: ${r.capabilities.email ? 'yes' : 'no'}, live view: ${r.capabilities.liveView ? 'yes' : 'no'}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div>
      <h1>Pair with your backend</h1>
      <p class="muted">
        On the server run <code>docker compose exec backend node dist/cli.js pair-device</code> and enter the 8-character code it prints. The code works once and expires in 10 minutes.
      </p>
      <label>
        Backend URL <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} size={40} />
      </label>
      <label>
        Pairing code <input value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} size={10} maxLength={8} />
      </label>
      <label>
        Device name <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} size={24} maxLength={60} />
      </label>
      <button class="primary" onClick={() => void pair()}>
        Pair
      </button>
      {msg && <p class={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
    </div>
  );
}

async function pairRequest(base: string, code: string, name: string) {
  const { createGuardedFetch } = await import('../../sw/guarded-fetch');
  const gf = createGuardedFetch(async () => ({ allowCloudProviders: true, proxyMode: false, egress: { alertMedia: false, liveView: false }, backend: { url: base } }));
  const res = await gf(`${base}/api/pair/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) }, { purpose: 'backend', frames: 'none' });
  if (!res.ok) throw new Error(res.status === 403 || res.status === 404 ? 'That code is wrong or expired.' : `Pairing failed (HTTP ${res.status}).`);
  return PairDeviceResponseSchema.parse(await res.json());
}

const root = document.getElementById('app');
if (root) render(<Pair />, root);
