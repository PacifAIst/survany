// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** §6.1 normalized model result. `event` is a rule id or "none". */
export interface DetectionResult {
  event: string;
  confidence: number;
  reason: string;
}

export type ProviderErrorKind = 'timeout' | 'rate-limit' | 'server' | 'auth' | 'payment' | 'forbidden' | 'parse' | 'network' | 'bad-request' | 'blocked';

/** Per-rule state machine (§6.4). */
export type RuleState = 'idle' | 'candidate' | 'confirming' | 'alerted' | 'cooldown';

export type SourceKind = 'tab' | 'camera';
