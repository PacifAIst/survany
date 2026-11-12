// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Arm/disarm and the confirm half of the pipeline (§4.3 steps 2-3, §6.4).
 * SECURITY-GATE SG-24: nothing is captured before the consent and disclosure screen has been accepted.
 * SECURITY-GATE SG-13: the visible "watching" indicator is set before capture starts.
 */
import { BUILTIN_RECIPES, confirmDecision, confirmEvents, confirmQuestion, type Recipe } from '@survey-anything/recipes';
import {
  AllProvidersFailedError,
  analyzeWithFailover,
  base64ToBlob,
  type ChainEntry,
  createProvider,
  parseDetection,
  type VisionProvider,
} from '@survey-anything/providers';
import type { AnalyzeOpts, ProbeResult } from '@survey-anything/providers';
import {
  type Config,
  type DetectionResult,
  isCloudProfile,
  modelConfirmThreshold,
  type ProviderId,
  recipientsFor,
  resolveChain,
  resolveProfile,
  type UnconfirmedReason,
  uuidv4,
} from '@survey-anything/shared';
import { describeOutcome, proposeForEvent } from './actions';
import { endLiveIndicator, setIndicator } from './badge';
import { BudgetLedger, type MeteredCall } from './budget';
import { dispatchAlert } from './dispatch';
import type { ArmSource, ClipSetup, FromOffscreen, OffscreenStatus, SourceSpec } from './messages';
import { raiseNotice } from './notices';
import { closeOffscreen, ensureOffscreen, hasOffscreen, sendToOffscreen } from './offscreen-host';
import { initialRuleState, onCandidate, onClear, onConfirmed, type RulePersist } from './rule-state';
import { backendClient, guardedFetch } from './runtime';
import * as store from './storage';
import type { ScanSetup } from '../worker/protocol';

type CandidateMsg = Extract<FromOffscreen, { type: 'candidate' | 'still-hot' }>;

export async function enabledRecipes(c: Config): Promise<Recipe[]> {
  const imported = await store.get('importedRecipes');
  const byId = new Map<string, Recipe>([...BUILTIN_RECIPES, ...imported].map((r) => [r.id, r]));
  return c.rules.map((id) => byId.get(id)).filter((r): r is Recipe => r !== undefined);
}

export function buildScanSetup(c: Config, recipes: Recipe[]): ScanSetup {
  return {
    intervalMs: c.vision.scanIntervalMs,
    recipes,
    minYoloConfidence: c.vision.minYoloConfidence,
    minHits: c.gate.minHits,
    windowFrames: c.gate.windowFrames,
    downscaleMaxPx: c.vision.downscaleMaxPx,
    jpegQuality: c.vision.jpegQuality,
    preferWebGPU: true,
  };
}

async function clipSetup(c: Config): Promise<ClipSetup | null> {
  const device = await store.get('device');
  // Clips exist for the §10 failure paths in T1+, and only when alert media may leave the machine (SG-15).
  return device && c.egress.alertMedia ? { seconds: c.clip.seconds, videoBitsPerSecond: c.clip.videoBitsPerSecond } : null;
}

export class ArmError extends Error {}

/**
 * Arm, disarm and capture recovery run one at a time. Overlapping requests (a double click on
 * "Watch camera", found in Firefox where three starts arrived within 20 ms) otherwise start several
 * captures that stop each other's camera stream, and watching silently gets no frames.
 */
let captureLock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = captureLock.then(fn, fn);
  captureLock = run.catch(() => undefined);
  return run;
}

export function arm(src: ArmSource): Promise<void> {
  return exclusive(() => armNow(src));
}

export function disarm(reason = 'user'): Promise<void> {
  return exclusive(() => disarmNow(reason));
}

export function recoverSource(why: string): Promise<void> {
  return exclusive(() => recoverNow(why));
}

async function armNow(src: ArmSource): Promise<void> {
  // Already watching this camera or shared window: a repeated request changes nothing.
  const current = await store.get('armed');
  if (current.armed && src.kind !== 'tab' && current.source?.kind === src.kind && (await offscreenStatus())?.running) {
    await store.appendLog(`arm ignored: already watching ${src.kind}`);
    return;
  }
  if (!(await store.get('consentAt'))) throw new ArmError('Accept the consent and disclosure screen first.');
  const { config, errors } = await store.loadConfig();
  // §10 "Zero channels configured": an invalid (e.g. tampered) config refuses to arm with a hard error.
  if (!config) throw new ArmError(`Configuration is invalid, refusing to arm: ${errors.join('; ')}`);
  if (config.alerts.channels.length === 0) throw new ArmError('No alert channel configured, refusing to arm.');
  if (src.kind === 'camera' && !(await store.get('cameraGranted'))) throw new ArmError('Grant camera access on the setup page first.');
  const recipes = await enabledRecipes(config);
  if (recipes.length === 0) throw new ArmError('No watch rules enabled.');

  await setIndicator('armed', src.label);
  // A window or screen (Firefox) is chosen with a click on the monitor tab, so bring it to the front.
  await ensureOffscreen({ focus: src.kind === 'display' });
  const cameraId = await store.get('cameraDeviceId');
  const source: SourceSpec = src.kind === 'tab' ? { ...src } : src.kind === 'display' ? { kind: 'display', label: src.label } : { kind: 'camera', deviceId: cameraId, label: src.label };
  try {
    await sendToOffscreen({ target: 'offscreen', type: 'start', source, setup: buildScanSetup(config, recipes), clip: await clipSetup(config) });
  } catch (e) {
    await setIndicator('error', 'capture failed to start');
    throw new ArmError(`Capture failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }
  await store.set('armed', {
    armed: true,
    source: src.kind === 'tab' ? { kind: 'tab', tabId: src.tabId, label: src.label } : src.kind === 'display' ? { kind: 'display', label: src.label } : { kind: 'camera', label: src.label },
    armedAt: Date.now(),
  });
  await store.appendLog(`armed: ${src.kind} "${src.label}"`);
  void probeLiveView(config);
}

async function disarmNow(reason: string): Promise<void> {
  const streaming = await store.get('streaming');
  if (streaming) await stopStream();
  // Firefox: forget the monitor tab first, so its closing below is not mistaken for the user closing it.
  await store.set('monitorTabId', null);
  if (await hasOffscreen()) {
    await sendToOffscreen({ target: 'offscreen', type: 'stop' }).catch(() => undefined);
    await closeOffscreen().catch(() => undefined);
  }
  await store.set('armed', { armed: false, source: null, armedAt: null });
  await setIndicator('off');
  await store.appendLog(`disarmed (${reason})`);
}

export async function stopStream(): Promise<void> {
  const streaming = await store.get('streaming');
  if (await hasOffscreen()) await sendToOffscreen({ target: 'offscreen', type: 'whip-stop' }).catch(() => undefined);
  if (streaming) {
    const backend = await backendClient();
    await backend?.stopStream(streaming.eventId).catch(() => undefined);
  }
  const armed = await store.get('armed');
  await endLiveIndicator(armed.armed ? (armed.source?.label ?? null) : null);
  await chrome.alarms.clear('stream-end');
}

/**
 * Restores capture after the offscreen document or the browser went away (§10). Camera sources
 * resume automatically; tab sources cannot (C20: tab capture needs a user gesture).
 */
async function recoverNow(why: string): Promise<void> {
  const armed = await store.get('armed');
  if (!armed.armed || !armed.source) return;
  if (armed.source.kind === 'tab' || armed.source.kind === 'display') {
    // Tabs (C20) and shared windows or screens can only be picked again by the user.
    const what = armed.source.kind === 'tab' ? 'Tab watching stopped' : 'Window or screen watching stopped';
    await raiseNotice('re-arm-needed', `${what} (${why}). Press Watch again in the extension.`);
    await disarmNow(`${armed.source.kind} source lost: ${why}`);
    return;
  }
  const { config } = await store.loadConfig();
  if (!config) return;
  try {
    await ensureOffscreen();
    await sendToOffscreen({
      target: 'offscreen',
      type: 'start',
      source: { kind: 'camera', deviceId: await store.get('cameraDeviceId'), label: armed.source.label },
      setup: buildScanSetup(config, await enabledRecipes(config)),
      clip: await clipSetup(config),
    });
    await setIndicator('armed', armed.source.label);
    await store.appendLog(`camera restored after: ${why}`);
  } catch (e) {
    await setIndicator('error', 'camera could not be restored');
    await raiseNotice('offscreen-failed', `Camera capture could not be restored (${why}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---- confirmation ---------------------------------------------------------------------------

class MeteredProvider implements VisionProvider {
  supportsVision = true;
  readonly id: ProviderId;
  constructor(
    private readonly inner: VisionProvider,
    private readonly ledger: BudgetLedger,
    private readonly m: MeteredCall,
  ) {
    this.id = inner.id;
  }
  probe(): Promise<ProbeResult> {
    return this.inner.probe();
  }
  async analyze(image: Blob, q: string, opts: AnalyzeOpts): Promise<DetectionResult> {
    await this.ledger.begin(this.m);
    return this.inner.analyze(image, q, {
      ...opts,
      onUsage: (u) => {
        void this.ledger.addTokens(this.m, u.inputTokens + u.outputTokens);
        opts.onUsage?.(u);
      },
    });
  }
}

/** proxyMode: the backend holds the keys and makes the provider call (SG-19 applies there). */
class ProxyProvider implements VisionProvider {
  supportsVision = true;
  constructor(
    readonly id: ProviderId,
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}
  probe(): Promise<ProbeResult> {
    throw new Error('probe runs from the Options page');
  }
  async analyze(image: Blob, q: string, opts: AnalyzeOpts): Promise<DetectionResult> {
    const backend = await backendClient();
    if (!backend) throw new Error('proxyMode needs a paired backend');
    const bytes = new Uint8Array(await image.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const out = await backend.proxyAnalyze({
      providerId: this.id,
      baseUrl: this.baseUrl,
      model: this.model,
      imageJpegB64: btoa(bin),
      prompt: q,
      allowedEvents: [...opts.allowedEvents],
      maxOutputTokens: opts.maxOutputTokens,
    });
    opts.onUsage?.(out.usage);
    // The backend's answer is untrusted too: re-validate it here.
    return parseDetection(JSON.stringify(out.result), opts.allowedEvents, this.id);
  }
}

export async function providerFor(c: Config, id: ProviderId): Promise<VisionProvider | null> {
  const p = resolveProfile(c, id);
  if (!p?.model) return null;
  if (c.proxyMode) return new ProxyProvider(p.id, p.baseUrl, p.model);
  return createProvider({
    id: p.id,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: await store.secret(p.apiKeyRef),
    timeoutMs: p.timeoutMs,
    fetchFn: (url, init) => guardedFetch(url, init, { purpose: 'provider', frames: 'provider-frame' }),
    directBrowser: true,
  });
}

type ConfirmOutcome =
  | { kind: 'none' }
  | { kind: 'alert'; confirmed: true; confidence: number; provider: string; reason: string }
  | { kind: 'alert'; confirmed: false; unconfirmedReason: UnconfirmedReason; confidence: number; reason: string };

async function confirm(recipe: Recipe, msg: CandidateMsg, c: Config): Promise<ConfirmOutcome> {
  const gateNote = `On-device gate (${msg.gate.via}${msg.gate.labels.length ? `: ${msg.gate.labels.join(', ')}` : ''}) score ${msg.gate.score.toFixed(2)}`;
  const gateConfidence = Math.min(1, Math.max(0, msg.gate.score));
  if (!c.vision.enableVision) return { kind: 'alert', confirmed: false, unconfirmedReason: 'vision-disabled', confidence: gateConfidence, reason: gateNote };

  const ledger = await BudgetLedger.load(c.budget, () => store.get('budget'), (s) => store.set('budget', s));
  const chain: ChainEntry[] = [];
  for (const p of resolveChain(c)) {
    if (!p.model) continue;
    const inner = await providerFor(c, p.id);
    if (!inner) continue;
    const cloud = isCloudProfile(p);
    chain.push({ provider: new MeteredProvider(inner, ledger, { cloud, providerId: p.id, model: p.model }), cloud });
  }
  const meteredOf = (e: ChainEntry): MeteredCall => {
    const p = resolveProfile(c, e.provider.id);
    return { cloud: e.cloud, providerId: e.provider.id, model: p?.model ?? '' };
  };
  try {
    const out = await analyzeWithFailover(chain, base64ToBlob(msg.confirmImageB64, 'image/jpeg'), confirmQuestion(recipe), {
      allowedEvents: confirmEvents(recipe),
      maxOutputTokens: c.vision.maxOutputTokens,
      framesPerCheck: msg.framesPerCheck,
      allowCall: (e) => ledger.allow(meteredOf(e)),
    });
    await store.appendLog(`confirm ${recipe.id}: ${out.providerId} answered ${out.result.event} (${out.result.confidence.toFixed(2)}); attempts ${out.attempts.map((a) => `${a.providerId}:${a.errorKind ?? a.outcome}`).join(',')}`);
    const model = resolveProfile(c, out.providerId as ProviderId)?.model ?? '';
    const decision = confirmDecision(recipe, out.result, modelConfirmThreshold(model));
    if (decision.alert) {
      return { kind: 'alert', confirmed: true, confidence: decision.confidence, provider: out.providerId, reason: out.result.reason };
    }
    return { kind: 'none' };
  } catch (e) {
    if (!(e instanceof AllProvidersFailedError)) throw e;
    await store.appendLog(`confirm ${recipe.id}: ${e.message}`);
    const budgetBlocked = e.attempts.some((a) => a.outcome === 'skipped-budget');
    if (budgetBlocked && (await ledger.claimExhaustedNotice())) {
      await raiseNotice('budget-exhausted', 'Cloud AI calls stopped for today. The on-device gate keeps running and sends "unconfirmed" alerts under cooldown.');
    }
    // C12/§10: all providers failing is never silence. It is an "unconfirmed" alert.
    return { kind: 'alert', confirmed: false, unconfirmedReason: e.reason === 'budget' ? 'budget' : 'all-providers-failed', confidence: gateConfidence, reason: gateNote };
  }
}

// ---- per-rule event handling ------------------------------------------------------------------

const ruleQueues = new Map<string, Promise<void>>();

function serialize(rule: string, fn: () => Promise<void>): Promise<void> {
  const prev = ruleQueues.get(rule) ?? Promise.resolve();
  const next = prev.then(fn, fn).catch((e: unknown) => store.appendLog(`rule ${rule}: ${e instanceof Error ? e.message : String(e)}`));
  ruleQueues.set(rule, next);
  return next;
}

async function persistRule(rule: string, s: RulePersist): Promise<void> {
  await store.update('rules', (all) => ({ ...all, [rule]: s }));
}

export function handleCandidate(msg: CandidateMsg): Promise<void> {
  return serialize(msg.rule, async () => {
    const armed = await store.get('armed');
    if (!armed.armed) return;
    const { config } = await store.loadConfig();
    if (!config) return;
    const recipe = (await enabledRecipes(config)).find((r) => r.id === msg.rule);
    if (!recipe) return;
    const timing = { cooldownMs: config.vision.cooldownPerEventMs, risingEdgeOnly: config.vision.risingEdgeOnly };
    const now = Date.now();
    const cur = (await store.get('rules'))[msg.rule] ?? initialRuleState(now);
    const { next, decision } = onCandidate(cur, now, timing, msg.type);
    await persistRule(msg.rule, next);
    if (decision === 'ignore') return;

    const outcome = await confirm(recipe, msg, config);
    if (outcome.kind === 'none') {
      await persistRule(msg.rule, onConfirmed(next, Date.now(), timing, { kind: 'none' }));
      return;
    }
    const eventId = uuidv4();
    // Persist the transition before sending, so a restart mid-dispatch cannot re-alert (§6.4).
    await persistRule(msg.rule, onConfirmed(next, Date.now(), timing, { kind: 'alert', eventId }));
    await dispatchAlert(
      {
        eventId,
        rule: recipe.id,
        ruleTitle: recipe.title,
        severity: recipe.severity,
        confirmed: outcome.confirmed,
        unconfirmedReason: outcome.confirmed ? null : outcome.unconfirmedReason,
        confidence: outcome.confidence,
        provider: outcome.confirmed ? outcome.provider : null,
        reason: outcome.reason,
        timestamp: new Date().toISOString(),
        sourceLabel: armed.source?.label ?? 'source',
        recipients: recipientsFor(config, recipe.id),
        snapshotB64: msg.snapshotB64,
      },
      config,
    );
    // §4.3 step 6: only after the alert is out, and only for a model-confirmed event. The Reasoner may
    // suggest one action; a human must tap Approve on Telegram before the gate runs anything.
    if (outcome.confirmed && config.mcp.enabled) {
      const p = await proposeForEvent(config, { eventId, rule: recipe.id, detection: { event: recipe.id, confidence: outcome.confidence, reason: outcome.reason } });
      await store.appendLog(`action proposal for ${recipe.id}: ${describeOutcome(p)}`);
    }
  });
}

export function handleClear(rule: string): Promise<void> {
  return serialize(rule, async () => {
    const all = await store.get('rules');
    const cur = all[rule];
    if (cur) await persistRule(rule, onClear(cur, Date.now()));
  });
}

export async function handleSourceHealth(state: 'ok' | 'frozen' | 'black' | 'no-frames'): Promise<void> {
  if (state === 'ok') return;
  const armed = await store.get('armed');
  if (!armed.armed) return;
  const what = state === 'black' ? 'is showing black frames' : state === 'frozen' ? 'is frozen' : 'stopped delivering frames';
  // A virtual camera (NVIDIA Broadcast, OBS) delivers nothing while its app is closed: say how to pick another.
  const hint = armed.source?.kind === 'camera' ? ' If this computer has more than one camera, choose the real one: extension popup → Camera….' : '';
  await raiseNotice('camera-offline', `${armed.source?.label ?? 'The source'} ${what}.${hint}`);
}

export async function handleSourceEnded(reason: string): Promise<void> {
  const armed = await store.get('armed');
  if (!armed.armed) return;
  if (armed.source?.kind === 'camera') {
    await raiseNotice('camera-offline', `Camera track ended (${reason}). Trying to restore it.`);
  }
  await recoverSource(reason);
}

export async function offscreenStatus(): Promise<OffscreenStatus | null> {
  if (!(await hasOffscreen())) return null;
  return sendToOffscreen<OffscreenStatus>({ target: 'offscreen', type: 'status' }, 3).catch(() => null);
}

/** M5 arm-time reachability probe: synthetic black track, 30 s token, never fails arm. */
export async function probeLiveView(c: Config): Promise<void> {
  try {
    const device = await store.get('device');
    if (!device?.capabilities.liveView || !c.egress.liveView) return;
    const backend = await backendClient();
    if (!backend) return;
    const { whipUrl, iceServers } = await backend.probeToken();
    const { candidateType } = await sendToOffscreen<{ candidateType: string }>({ target: 'offscreen', type: 'whip-probe', url: whipUrl, iceServers });
    await backend.reportProbe(candidateType);
    await store.appendLog(`live-view probe: ${candidateType}`);
    if (candidateType !== 'udp') {
      await raiseNotice('live-view-udp-unavailable', `UDP media is unavailable from this network (${candidateType}); live view will use the TCP relay.`);
    }
  } catch (e) {
    await store.appendLog(`live-view probe skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}
