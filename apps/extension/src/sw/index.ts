// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Service worker entry (§4.1). Listeners are registered synchronously at top level so a restarted
 * worker receives the event that woke it. No state lives in memory.
 */
import { createProvider, listModels, openAiBase, type ProbeResult } from '@survey-anything/providers';
import { parseConfig, type ResolvedProfile, ResolvedProfileSchema } from '@survey-anything/shared';
import { BudgetLedger } from './budget';
import { createGuardedFetch, type PolicyConfig } from './guarded-fetch';
import { HEARTBEAT_ALARM, ensureHeartbeatAlarm, sendHeartbeat } from './heartbeat';
import { isFromExtension, type LocalDetect, type PopupStatus, type ToSw } from './messages';
import { raiseNotice } from './notices';
import { backendClient } from './runtime';
import {
  arm,
  disarm,
  handleCandidate,
  handleClear,
  handleSourceEnded,
  handleSourceHealth,
  offscreenStatus,
  recoverSource,
  stopStream,
} from './scan-controller';
import * as store from './storage';
import { ensureWatchdogAlarm, runWatchdog, WATCHDOG_ALARM } from './watchdog';

/** When this service worker instance started; lets tests prove a restart happened. Not state. */
const instanceStartedAt = Date.now();

async function boot(): Promise<void> {
  await store.restrictStorageAccess();
  await ensureWatchdogAlarm();
  await ensureHeartbeatAlarm();
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await boot();
    if (details.reason === 'install' && !(await store.get('consentAt'))) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/consent/index.html') });
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await store.set('monitorTabId', null); // tab ids do not survive a browser restart
    await boot();
    // C20: after a browser restart a tab source needs a re-arm; a camera resumes automatically.
    await recoverSource('browser restarted');
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    if (alarm.name === WATCHDOG_ALARM) await runWatchdog();
    else if (alarm.name === HEARTBEAT_ALARM) await sendHeartbeat().catch((e: unknown) => store.appendLog(`heartbeat: ${e instanceof Error ? e.message : String(e)}`));
    else if (alarm.name === 'stream-end') await stopStream();
  })();
});

function osForProbe(os: string): 'mac' | 'windows' | 'linux' {
  if (os === 'mac') return 'mac';
  if (os === 'win') return 'windows';
  return 'linux';
}

function failedProbe(error: string, hint: string | null = null): ProbeResult {
  return { ok: false, supportsVision: false, latencyMs: 0, expected: '', got: null, error, hint, attempts: 0 };
}

/**
 * C26 probe of one provider profile, under the policy of the configuration being edited (not the stored
 * one, which may not exist yet or may still forbid the cloud host the user is setting up). The request
 * carries only the synthetic code image. In proxy mode the backend runs the probe with its own key.
 */
async function probeProfile(policy: PolicyConfig, p: ResolvedProfile): Promise<ProbeResult> {
  if (!p.model) return failedProbe('no model selected');
  if (policy.proxyMode) {
    const backend = await backendClient();
    if (!backend) return failedProbe('proxy mode needs a paired backend');
    return backend.proxyProbe({ providerId: p.id, baseUrl: p.baseUrl, model: p.model }).catch((e: unknown) => failedProbe(e instanceof Error ? e.message : String(e)));
  }
  // Say what is missing instead of letting the provider answer 401.
  const apiKey = await store.secret(p.apiKeyRef);
  if (p.id !== 'local' && !p.apiKeyRef) return failedProbe(`${p.id} needs an API key: set "API key reference" (for example key_${p.id}) and paste the key`);
  if (p.apiKeyRef && !apiKey) return failedProbe(`no API key is stored under ${p.apiKeyRef}: paste the key into "API key" (it is saved when you leave the field or press Store)`);
  const gf = createGuardedFetch(async () => policy);
  const provider = createProvider({
    id: p.id,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey,
    timeoutMs: p.timeoutMs,
    fetchFn: (url, init) => gf(url, init, { purpose: 'probe', frames: 'synthetic-probe' }),
    directBrowser: true,
  });
  const platform = await chrome.runtime.getPlatformInfo();
  const r = await provider.probe({ os: osForProbe(platform.os), extensionOrigin: chrome.runtime.getURL('').replace(/\/$/, '') });
  if (r.ok || r.hint) return r;
  // Nothing listening: name the address and the usual ports instead of the browser's "Failed to fetch".
  if (p.id === 'local' && r.got === null && /failed to fetch|networkerror|err_connection/i.test(r.error ?? '')) {
    return {
      ...r,
      error: `nothing answered at ${openAiBase('local', p.baseUrl)}: is the server running?`,
      hint: 'Start the server and load a vision model, then put its address in Base URL (or press LM Studio / Ollama above it).\nLM Studio: Developer tab → Start server; address http://127.0.0.1:1234\nOllama: address http://127.0.0.1:11434',
    };
  }
  if (/HTTP 40[13]\b/.test(r.error ?? '')) return { ...r, hint: 'The provider rejected the API key: check that it was copied completely and is still active, then paste it again.' };
  if (p.id === 'anthropic') return r;
  // On an OpenAI-compatible server, show which model ids it actually serves (LM Studio ids are often not the file name).
  const ids = await listModels({ id: p.id, baseUrl: p.baseUrl, apiKey, fetchFn: (url, init) => gf(url, init, { purpose: 'probe', frames: 'none' }) }).catch((): string[] => []);
  if (ids.length > 0 && !ids.includes(p.model)) {
    return { ...r, hint: `This server serves: ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ', …' : ''}. Copy one of these ids into Model exactly.` };
  }
  return r;
}

/**
 * Asks a local model server which models it has. LM Studio's /api/v0/models also says which models can
 * see ("vlm") and which are loaded; other servers only list ids (GET /v1/models). Loopback and private
 * hosts only (allowCloudProviders is false for this request), and nothing but a GET is sent.
 */
async function detectLocal(baseUrl: string): Promise<LocalDetect> {
  const { config } = await store.loadConfig();
  const gf = createGuardedFetch(async () => ({ allowCloudProviders: false, proxyMode: false, egress: { alertMedia: false, liveView: false }, backend: config?.backend ?? { url: null } }));
  const get = (url: string): Promise<Response> => gf(url, { method: 'GET', signal: AbortSignal.timeout(5000) }, { purpose: 'probe', frames: 'none' });
  const base = openAiBase('local', baseUrl);
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return { reachable: false, server: null, models: [], error: 'Base URL is not a valid address' };
  }
  try {
    const res = await get(`${origin}/api/v0/models`);
    const body = res.ok ? ((await res.json().catch(() => null)) as { data?: { id?: unknown; type?: unknown; state?: unknown }[] } | null) : null;
    const typed = Array.isArray(body?.data) && body.data.some((m) => typeof m.type === 'string');
    if (typed && body?.data) {
      const models = body.data
        .filter((m) => typeof m.id === 'string' && m.type !== 'embeddings')
        .map((m) => ({ id: m.id as string, vision: m.type === 'vlm', loaded: m.state === 'loaded' }));
      return { reachable: true, server: 'lmstudio', models, error: null };
    }
    const ids = await listModels({ id: 'local', baseUrl, apiKey: null, fetchFn: (url, init) => gf(url, { ...init, signal: AbortSignal.timeout(5000) }, { purpose: 'probe', frames: 'none' }) });
    return { reachable: true, server: 'openai-compatible', models: ids.map((id) => ({ id, vision: null, loaded: null })), error: null };
  } catch (e) {
    return { reachable: false, server: null, models: [], error: `nothing answered at ${base}: is the server running? (${e instanceof Error ? e.message : String(e)})` };
  }
}

async function status(): Promise<PopupStatus> {
  const [consentAt, cameraGranted, armed, streaming, notices, device] = await Promise.all([
    store.get('consentAt'),
    store.get('cameraGranted'),
    store.get('armed'),
    store.get('streaming'),
    store.get('recentNotices'),
    store.get('device'),
  ]);
  const { config, errors } = await store.loadConfig();
  const off = armed.armed ? await offscreenStatus() : null;
  const budget = config ? (await BudgetLedger.load(config.budget, () => store.get('budget'), async () => undefined)).report() : null;
  return {
    consented: consentAt !== null,
    cameraGranted,
    armed: armed.armed,
    source: armed.source ? { kind: armed.source.kind, label: armed.source.label } : null,
    lastTickAt: off?.stats?.lastTickAt ?? null,
    streaming: streaming ? { recipients: streaming.recipients, since: streaming.since } : null,
    budget,
    configErrors: errors,
    notices: notices.slice(-5),
    backendPaired: device !== null,
  };
}

async function handle(msg: ToSw): Promise<unknown> {
  switch (msg.type) {
    case 'arm':
      await arm(msg.source);
      return status();
    case 'disarm':
      await disarm();
      return status();
    case 'get-status':
      return status();
    case 'stop-stream':
      await stopStream();
      return status();
    case 'test-provider': {
      // Test Connection never saves the draft: it sends the profile and the draft's two policy switches.
      const p = ResolvedProfileSchema.safeParse(msg.profile);
      if (!p.success) return failedProbe(`profile invalid: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      const { config } = await store.loadConfig();
      return probeProfile({ allowCloudProviders: msg.allowCloudProviders, proxyMode: msg.proxyMode, egress: { alertMedia: false, liveView: false }, backend: config?.backend ?? { url: null } }, p.data);
    }
    case 'detect-local':
      return detectLocal(msg.baseUrl);
    case 'action-tools': {
      const backend = await backendClient();
      return backend ? backend.actionTools() : null;
    }
    case 'save-config': {
      const r = parseConfig(msg.config);
      if (!r.ok) return { ok: false, errors: r.errors };
      // §6.1: refuse to save a Vision provider that fails the probe; re-probe when base URL or model changes.
      if (r.config.vision.enableVision) {
        const p = r.config.provider;
        const key = `${p.id}|${p.baseUrl}|${p.model ?? ''}|${r.config.proxyMode ? 'proxy' : 'direct'}`;
        const probed = (await chrome.storage.local.get('probedVision'))['probedVision'] as string | undefined;
        if (probed !== key) {
          const res = await probeProfile(r.config, { ...p });
          if (!res.ok) return { ok: false, errors: [`Vision provider failed the image probe: ${res.error ?? 'unknown error'}`], hint: res.hint ?? null };
          await chrome.storage.local.set({ probedVision: key });
        }
      }
      await store.set('config', msg.config);
      const armed = await store.get('armed');
      if (armed.armed) await recoverSource('configuration changed').catch(() => undefined);
      return { ok: true, errors: [] };
    }
    case 'send-test-alert': {
      const backend = await backendClient();
      if (!backend) return { ok: false, error: 'pair a backend first' };
      return backend.testContact(msg.contactId);
    }
    case 'debug-stats': {
      const off = await offscreenStatus();
      return { stats: off?.stats ?? null, running: off?.running ?? false, swStartedAt: instanceStartedAt, log: (await store.get('log')).slice(-30) };
    }
    case 'candidate':
    case 'still-hot':
      await handleCandidate(msg);
      return null;
    case 'clear':
      await handleClear(msg.rule);
      return null;
    case 'source-health':
      await handleSourceHealth(msg.state);
      return null;
    case 'source-ended':
      await handleSourceEnded(msg.reason);
      return null;
    case 'whip-state':
      await store.appendLog(`live view: ${msg.state} ${msg.detail}`);
      return null;
    case 'offscreen-ready':
      // Firefox: the capture page is a tab; remember it so closing it stops watching (see tabs.onRemoved).
      if (typeof msg.tabId === 'number') await store.set('monitorTabId', msg.tabId);
      return null;
    case 'log':
      await store.appendLog(`[offscreen ${msg.level}] ${msg.msg}`);
      return null;
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as ToSw;
  // Only our own pages and offscreen document may talk to the service worker. There are no content scripts.
  if (!msg || msg.target !== 'sw' || !isFromExtension(sender)) return false;
  handle(msg).then(
    (value) => sendResponse({ ok: true, value }),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});

// Firefox: closing the "Survey Anything is watching" tab is how a person stops watching from the tab bar.
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    if ((await store.get('monitorTabId')) !== tabId) return;
    await store.set('monitorTabId', null);
    if (!(await store.get('armed')).armed) return;
    await raiseNotice('re-arm-needed', 'Watching stopped because the Survey Anything tab was closed. Press Watch in the extension to start again.');
    await disarm('monitor tab closed');
  })();
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'sa-live') void chrome.action.openPopup?.().catch(() => undefined);
});

void boot();
