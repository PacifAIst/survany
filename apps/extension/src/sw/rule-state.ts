/**
 * Per-rule state machine (§6.4): idle → candidate (N-of-M, in the Worker) → confirming → alerted
 * → cooldown → idle. Persisted on every transition so a service worker restart never re-alerts.
 */

export interface RulePersist {
  phase: 'idle' | 'confirming' | 'cooldown';
  since: number;
  cooldownUntil: number;
  /** Rising edge: a `clear` (or a "none" answer) has been seen since the last alert. */
  armedForRise: boolean;
  lastNoneAt: number | null;
  lastEventId: string | null;
}

export interface RuleTiming {
  cooldownMs: number;
  risingEdgeOnly: boolean;
}

/** A confirmation that outlives this is treated as abandoned (the SW died mid-call, C4 caps calls at 25 s). */
export const STALE_CONFIRMING_MS = 60_000;

export function initialRuleState(now: number): RulePersist {
  return { phase: 'idle', since: now, cooldownUntil: 0, armedForRise: true, lastNoneAt: null, lastEventId: null };
}

export type CandidateDecision = 'confirm' | 'ignore';

export function onCandidate(s: RulePersist, now: number, t: RuleTiming, kind: 'candidate' | 'still-hot'): { next: RulePersist; decision: CandidateDecision } {
  let cur = s;
  if (cur.phase === 'confirming' && now - cur.since > STALE_CONFIRMING_MS) cur = { ...cur, phase: 'idle', since: now };
  switch (cur.phase) {
    case 'confirming':
      return { next: cur, decision: 'ignore' };
    case 'cooldown': {
      if (now < cur.cooldownUntil) return { next: cur, decision: 'ignore' };
      if (t.risingEdgeOnly && !cur.armedForRise) return { next: cur, decision: 'ignore' };
      return { next: { ...cur, phase: 'confirming', since: now }, decision: 'confirm' };
    }
    case 'idle': {
      // After a "none" answer, a still-hot gate is re-asked at most once per cooldown period.
      if (kind === 'still-hot' && cur.lastNoneAt !== null && now - cur.lastNoneAt < t.cooldownMs) return { next: cur, decision: 'ignore' };
      return { next: { ...cur, phase: 'confirming', since: now }, decision: 'confirm' };
    }
  }
}

export function onClear(s: RulePersist, now: number): RulePersist {
  const next = { ...s, armedForRise: true };
  if (next.phase === 'cooldown' && now >= next.cooldownUntil) return { ...next, phase: 'idle', since: now };
  return next;
}

/** `alert` covers confirmed and unconfirmed alerts alike; both enter cooldown (C15). */
export function onConfirmed(s: RulePersist, now: number, t: RuleTiming, outcome: { kind: 'alert'; eventId: string } | { kind: 'none' }): RulePersist {
  if (outcome.kind === 'none') return { ...s, phase: 'idle', since: now, lastNoneAt: now };
  return { ...s, phase: 'cooldown', since: now, cooldownUntil: now + t.cooldownMs, armedForRise: false, lastEventId: outcome.eventId, lastNoneAt: null };
}
