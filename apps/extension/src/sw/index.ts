/**
 * Service worker entry (§4.1). Listeners are registered synchronously at top level so a restarted
 * worker receives the event that woke it. No state lives in memory.
 */
import { createProvider } from '@survey-anything/providers';
import { type Config, parseConfig, resolveProfile, type ProviderId } from '@survey-anything/shared';
import { BudgetLedger } from './budget';
import { HEARTBEAT_ALARM, ensureHeartbeatAlarm, sendHeartbeat } from './heartbeat';
import { isFromExtension, type PopupStatus, type ToSw } from './messages';
import { guardedFetch, backendClient } from './runtime';
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

async function probeProvider(config: Config, id: ProviderId): Promise<unknown> {
  const p = resolveProfile(config, id);
  if (!p?.model) return { ok: false, error: 'no model selected', supportsVision: false };
  const provider = createProvider({
    id: p.id,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: await store.secret(p.apiKeyRef),
    timeoutMs: p.timeoutMs,
    fetchFn: (url, init) => guardedFetch(url, init, { purpose: 'provider', frames: 'provider-frame' }),
    directBrowser: true,
  });
  const platform = await chrome.runtime.getPlatformInfo();
  return provider.probe({ os: osForProbe(platform.os), extensionOrigin: `chrome-extension://${chrome.runtime.id}` });
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
  let budget = { dayCalls: 0, dailyMax: 0, exhausted: false };
  if (config) {
    const ledger = await BudgetLedger.load(config.budget, () => store.get('budget'), async () => undefined);
    budget = { dayCalls: ledger.snapshot.dayCalls, dailyMax: config.budget.dailyMaxApiCalls, exhausted: ledger.exhausted };
  }
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
      const { config, errors } = await store.loadConfig();
      if (!config) return { ok: false, error: errors.join('; ') };
      return probeProvider(config, msg.providerId as ProviderId);
    }
    case 'save-config': {
      const r = parseConfig(msg.config);
      if (!r.ok) return { ok: false, errors: r.errors };
      // §6.1: refuse to save a Vision provider that fails the probe; re-probe when base URL or model changes.
      if (r.config.vision.enableVision) {
        const p = r.config.provider;
        const key = `${p.id}|${p.baseUrl}|${p.model ?? ''}`;
        const probed = (await chrome.storage.local.get('probedVision'))['probedVision'] as string | undefined;
        if (probed !== key) {
          const res = (await probeProvider(r.config, p.id)) as { ok: boolean; error?: string; hint?: string };
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

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'sa-live') void chrome.action.openPopup?.().catch(() => undefined);
});

void boot();
