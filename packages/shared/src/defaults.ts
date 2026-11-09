/**
 * The only place model IDs and vendor defaults may be hardcoded (PLAN §0 rule 7).
 * Verified 2026-11-09 against PLAN §17 sources; see docs/PROGRESS.md "External facts checked".
 */
import type { Config, ProviderId } from './config';

export const PROVIDER_IDS = ['anthropic', 'openai', 'openrouter', 'deepseek', 'local'] as const;

/** null means "the user selects, the probe validates" (openai, §6.1). */
export const DEFAULT_MODELS: Record<ProviderId, string | null> = {
  anthropic: 'claude-haiku-5-5',
  openai: null,
  openrouter: 'qwen/qwen2.5-vl-72b-instruct',
  deepseek: 'deepseek-flash',
  local: 'qwen2.5vl',
};

export const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com',
  local: 'http://127.0.0.1:11434/v1',
};

/** C24 / S32: this version returns 400 on temperature, top_p or top_k. */
export const ANTHROPIC_VERSION = '2026-10-21';

/** Licenses shown before a model is used (§11). Unknown models show "check the model card". */
export const MODEL_LICENSES: Record<string, string> = {
  'qwen2.5vl': 'Apache-2.0 (7B tag). Read the model card before use.',
  'qwen2.5vl:7b': 'Apache-2.0. Read the model card before use.',
  'qwen2.5vl:32b': 'Apache-2.0. Read the model card before use.',
  'qwen2.5vl:72b': 'Qwen License (not Apache). Read the model card before use.',
  'qwen2.5vl:3b': 'Research license per some sources; secondary sources disagree. Read the model card.',
  'qwen/qwen2.5-vl-72b-instruct': 'Qwen License, hosted by OpenRouter (paid listing).',
  'claude-haiku-5-5': 'Anthropic commercial terms (hosted API).',
  'deepseek-flash': 'DeepSeek API terms (hosted API).',
};

/**
 * Model confidence is self-reported and poorly calibrated (§6.1). A "yes" below the threshold is
 * treated as "none". Per-model values come from bench/; unknown models use the default.
 */
export const MODEL_CONFIRM_MIN_CONFIDENCE_DEFAULT = 0.5;
export const MODEL_CONFIRM_MIN_CONFIDENCE: Record<string, number> = {};

export function modelConfirmThreshold(model: string): number {
  return MODEL_CONFIRM_MIN_CONFIDENCE[model] ?? MODEL_CONFIRM_MIN_CONFIDENCE_DEFAULT;
}

export const PROVIDER_TIMEOUT_DEFAULT_MS = 20_000;
/** C4: the service worker is killed if a fetch response takes over 30 s. */
export const PROVIDER_TIMEOUT_MAX_MS = 25_000;

export const SCAN_FLOOR_CLOUD_MS = 2_000;
export const SCAN_FLOOR_LOCAL_MS = 500;

export const CALLBACK_MAX_BYTES = 64;
export const STREAM_TTL_MAX_MINUTES = 10;
export const PROBE_TOKEN_TTL_SECONDS = 30;
export const REASON_MAX_CHARS = 280;
export const HEARTBEAT_PERIOD_MINUTES = 0.5;
export const DEAD_MAN_MISSED_HEARTBEATS = 3;
export const STREAM_START_BUDGET_MS = 5_000;
export const VIEWER_SOURCE_WATCHDOG_MS = 10_000;
export const CAMERA_OFFLINE_NOTICE_INTERVAL_MS = 60 * 60 * 1000;

/** C27 / S28 */
export const OPENROUTER_FREE_LIMITS = { perMinute: 20, perDayUnder10Credits: 50, perDayWith10Credits: 1000 } as const;

/** Approximate per-1M-token USD prices for the cost column in bench and the Options budget hint. */
export const APPROX_PRICE_PER_MTOK_INPUT: Record<string, number> = {
  'claude-haiku-5-5': 1.0,
  'deepseek-flash': 0.3,
  'qwen/qwen2.5-vl-72b-instruct': 0.6,
  'qwen2.5vl': 0,
};

export const SOURCE_URL = 'https://github.com/PacifAIst/survany';

/** The §6.2 sample, verbatim. Tests assert it validates. */
export const EXAMPLE_CONFIG_JSON = {
  schemaVersion: 1,
  provider: {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'qwen/qwen2.5-vl-72b-instruct',
    apiKeyRef: 'key_openrouter',
  },
  providerProfiles: {
    local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5vl', apiKeyRef: null },
    anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5', apiKeyRef: 'key_anthropic' },
  },
  reasoner: { enabled: false, providerId: null, model: null },
  failoverChain: ['local', 'openrouter', 'anthropic'],
  allowCloudProviders: true,
  proxyMode: false,
  egress: { alertMedia: true, liveView: true },
  vision: {
    enableVision: true,
    scanIntervalMs: 5000,
    minYoloConfidence: 0.6,
    cooldownPerEventMs: 60000,
    risingEdgeOnly: true,
    downscaleMaxPx: 512,
    jpegQuality: 0.7,
    maxOutputTokens: 200,
  },
  gate: { minHits: 2, windowFrames: 3 },
  budget: { maxCallsPerMinute: 6, dailyMaxApiCalls: 500, dailyTokenCap: 200000, hardStopOnBudget: true },
  stream: { ttlMinutes: 10, singleUse: true, viewerAllowlistOnly: true },
  clip: { seconds: 10, videoBitsPerSecond: 500000 },
  alerts: {
    channels: ['telegram', 'email'],
    email: { transport: 'smtp-backend', includeSnapshot: true },
    ackTimeoutSec: 300,
  },
  contacts: {
    owner: { roles: ['viewer', 'approver'] },
    contactA: { roles: ['viewer'] },
    contactB: { roles: ['viewer'] },
    contactC: { roles: ['viewer'] },
  },
  routing: { fire: ['contactA'], robbery: ['contactB', 'contactC'], other: ['owner'] },
  rules: ['fire', 'robbery', 'other'],
  mcp: { enabled: false, requireSecondChannelApproval: true, approvalTimeoutSec: 300 },
} as const;

/** Fresh-install config: fully local, no key needed, owner-only routing. */
export function defaultConfigInput(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: { id: 'local', baseUrl: DEFAULT_BASE_URLS.local, model: DEFAULT_MODELS.local, apiKeyRef: null },
    providerProfiles: {},
    failoverChain: ['local'],
    allowCloudProviders: true,
    proxyMode: false,
    egress: { alertMedia: true, liveView: true },
    vision: { ...EXAMPLE_CONFIG_JSON.vision },
    gate: { ...EXAMPLE_CONFIG_JSON.gate },
    budget: { ...EXAMPLE_CONFIG_JSON.budget },
    stream: { ...EXAMPLE_CONFIG_JSON.stream },
    clip: { ...EXAMPLE_CONFIG_JSON.clip },
    alerts: {
      channels: ['telegram', 'email'],
      email: { transport: 'smtp-backend', includeSnapshot: true },
      ackTimeoutSec: 300,
    },
    contacts: { owner: { roles: ['viewer', 'approver'] } },
    routing: { fire: ['owner'], other: ['owner'] },
    rules: ['fire', 'other'],
    mcp: { enabled: false, requireSecondChannelApproval: true, approvalTimeoutSec: 300 },
  };
}

export type { Config };
