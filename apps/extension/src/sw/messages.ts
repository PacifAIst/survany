// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** Runtime messages between the service worker, the offscreen document and extension pages. JSON only (C4). */
import type { GateInfo, ScanSetup, TickStats } from '../worker/protocol';
import type { BudgetReport } from './budget';

export type SourceSpec =
  | { kind: 'tab'; streamId: string; tabId: number; label: string }
  | { kind: 'camera'; deviceId: string | null; label: string }
  /** Firefox: a window or the screen, chosen in Firefox's own picker from a click on the monitor tab. */
  | { kind: 'display'; label: string };

export interface ClipSetup {
  seconds: number;
  videoBitsPerSecond: number;
}

export type CandidateType = 'udp' | 'tcp' | 'relay' | 'none';

export type ToOffscreen =
  | { target: 'offscreen'; type: 'start'; source: SourceSpec; setup: ScanSetup; clip: ClipSetup | null }
  | { target: 'offscreen'; type: 'update'; setup: ScanSetup; clip: ClipSetup | null }
  | { target: 'offscreen'; type: 'stop' }
  | { target: 'offscreen'; type: 'status' }
  | { target: 'offscreen'; type: 'get-clip' }
  | { target: 'offscreen'; type: 'whip-start'; url: string; iceServers: RTCIceServer[] }
  | { target: 'offscreen'; type: 'whip-stop' }
  | { target: 'offscreen'; type: 'whip-probe'; url: string; iceServers: RTCIceServer[] }
  /** Firefox monitor tab only: bring it to the front, or close it. */
  | { target: 'offscreen'; type: 'focus' }
  | { target: 'offscreen'; type: 'close' };

export interface OffscreenStatus {
  running: boolean;
  source: { kind: SourceSpec['kind']; label: string } | null;
  stats: TickStats | null;
  whip: 'idle' | 'connecting' | 'live' | 'failed';
}

export interface ClipPayload {
  mime: string;
  b64: string;
  durationMs: number;
}

export type FromOffscreen =
  /** tabId is set when the capture page is a tab (Firefox), so closing that tab can stop watching. */
  | { target: 'sw'; type: 'offscreen-ready'; tabId?: number }
  | {
      target: 'sw';
      type: 'candidate' | 'still-hot';
      rule: string;
      confirmImageB64: string;
      snapshotB64: string;
      framesPerCheck: number;
      gate: GateInfo;
    }
  | { target: 'sw'; type: 'clear'; rule: string }
  | { target: 'sw'; type: 'source-health'; state: 'ok' | 'frozen' | 'black' | 'no-frames' }
  | { target: 'sw'; type: 'source-ended'; reason: string }
  | { target: 'sw'; type: 'whip-state'; state: 'connecting' | 'live' | 'failed' | 'closed'; detail: string }
  | { target: 'sw'; type: 'log'; level: 'info' | 'warn' | 'error'; msg: string };

export type ArmSource = { kind: 'tab'; streamId: string; tabId: number; label: string } | { kind: 'camera'; label: string } | { kind: 'display'; label: string };

export type ToSw =
  | { target: 'sw'; type: 'arm'; source: ArmSource }
  | { target: 'sw'; type: 'disarm' }
  | { target: 'sw'; type: 'get-status' }
  | { target: 'sw'; type: 'stop-stream' }
  | { target: 'sw'; type: 'test-provider'; profile: unknown; allowCloudProviders: boolean; proxyMode: boolean }
  | { target: 'sw'; type: 'action-tools' }
  | { target: 'sw'; type: 'detect-local'; baseUrl: string }
  | { target: 'sw'; type: 'save-config'; config: unknown }
  | { target: 'sw'; type: 'send-test-alert'; contactId: string }
  | { target: 'sw'; type: 'debug-stats' }
  | FromOffscreen;

/** What a local model server reports about its models (LM Studio says which can see and which are loaded). */
export interface LocalDetect {
  reachable: boolean;
  /** 'lmstudio' when the server answered LM Studio's /api/v0/models with model types. */
  server: 'lmstudio' | 'openai-compatible' | null;
  models: { id: string; vision: boolean | null; loaded: boolean | null }[];
  error: string | null;
}

export interface PopupStatus {
  consented: boolean;
  cameraGranted: boolean;
  armed: boolean;
  source: { kind: SourceSpec['kind']; label: string } | null;
  lastTickAt: number | null;
  streaming: { recipients: string[]; since: number } | null;
  budget: BudgetReport | null;
  configErrors: string[];
  notices: string[];
  backendPaired: boolean;
}

/**
 * True only for this extension's own pages. Compared with the extension's base URL rather than a built
 * string: Chrome pages are chrome-extension://<id>/, Firefox pages moz-extension://<per-install uuid>/.
 */
export function isFromExtension(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && (sender.url?.startsWith(chrome.runtime.getURL('')) ?? false);
}
