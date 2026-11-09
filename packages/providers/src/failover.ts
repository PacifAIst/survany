/**
 * Failover chain (§6.1). Advances on timeout, 429, 5xx, 401, 402, 403 and parse errors
 * (and, fail-safe, on any other provider error). Logs which provider answered.
 * When every provider fails the caller sends an "unconfirmed" alert (§10), never silence.
 */
import type { DetectionResult, ProviderErrorKind } from '@survey-anything/shared';
import type { AnalyzeOpts, VisionProvider } from './adapter';
import { ProviderError } from './errors';

export interface ChainEntry {
  provider: VisionProvider;
  /** Cloud entries are metered; local ones are free (§4 principle 4). */
  cloud: boolean;
}

export interface FailoverAttempt {
  providerId: string;
  outcome: 'answered' | 'failed' | 'skipped-budget';
  errorKind: ProviderErrorKind | null;
  message: string | null;
  latencyMs: number;
}

export interface FailoverOutcome {
  result: DetectionResult;
  providerId: string;
  attempts: FailoverAttempt[];
}

export class AllProvidersFailedError extends Error {
  constructor(
    public readonly attempts: FailoverAttempt[],
    public readonly reason: 'all-providers-failed' | 'budget',
  ) {
    super(`all providers failed: ${attempts.map((a) => `${a.providerId}=${a.outcome}${a.errorKind ? `(${a.errorKind})` : ''}`).join(', ')}`);
    this.name = 'AllProvidersFailedError';
  }
}

export const ADVANCE_ON: readonly ProviderErrorKind[] = ['timeout', 'rate-limit', 'server', 'auth', 'payment', 'forbidden', 'parse', 'network', 'bad-request', 'blocked'];

export interface FailoverOpts extends AnalyzeOpts {
  /** Budget hook: return false to skip a metered call. */
  allowCall?: (entry: ChainEntry) => boolean;
  onAttempt?: (a: FailoverAttempt) => void;
  now?: () => number;
}

export async function analyzeWithFailover(
  chain: readonly ChainEntry[],
  image: Blob,
  question: string,
  opts: FailoverOpts,
): Promise<FailoverOutcome> {
  const now = opts.now ?? Date.now;
  const attempts: FailoverAttempt[] = [];
  const record = (a: FailoverAttempt): void => {
    attempts.push(a);
    opts.onAttempt?.(a);
  };
  for (const entry of chain) {
    const id = entry.provider.id;
    if (opts.allowCall && !opts.allowCall(entry)) {
      record({ providerId: id, outcome: 'skipped-budget', errorKind: null, message: 'budget exhausted', latencyMs: 0 });
      continue;
    }
    const t0 = now();
    try {
      const result = await entry.provider.analyze(image, question, opts);
      record({ providerId: id, outcome: 'answered', errorKind: null, message: null, latencyMs: now() - t0 });
      return { result, providerId: id, attempts };
    } catch (e) {
      const kind: ProviderErrorKind = e instanceof ProviderError ? e.kind : 'network';
      record({ providerId: id, outcome: 'failed', errorKind: kind, message: e instanceof Error ? e.message : String(e), latencyMs: now() - t0 });
      if (opts.signal?.aborted) break;
      if (!ADVANCE_ON.includes(kind)) break;
    }
  }
  const onlyBudget = attempts.length > 0 && attempts.every((a) => a.outcome === 'skipped-budget');
  throw new AllProvidersFailedError(attempts, onlyBudget ? 'budget' : 'all-providers-failed');
}
