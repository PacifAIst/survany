// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Budget engine (§3 principle 4, §10 "Budget exhausted"). Cloud calls only; local providers are
 * free. State is persisted after every change so a service worker restart cannot reset it.
 * hardStopOnBudget is literal true: when a limit is hit, metered calls stop.
 */
import type { Config } from '@survey-anything/shared';
import { OPENROUTER_FREE_LIMITS } from '@survey-anything/shared';

export interface BudgetState {
  day: string;
  dayCalls: number;
  dayTokens: number;
  /** Timestamps (ms) of metered calls in the last minute. */
  minute: number[];
  /** Day on which the "budget exhausted" notice was sent (one notice per day). */
  noticeDay: string | null;
  /** Calls to OpenRouter `:free` models today (C27). */
  freeDayCalls: number;
}

export type BudgetBlock = 'minute' | 'day-calls' | 'day-tokens' | 'openrouter-free-minute' | 'openrouter-free-day';

export interface MeteredCall {
  cloud: boolean;
  providerId: string;
  model: string;
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class BudgetLedger {
  private constructor(
    private state: BudgetState,
    private readonly limits: Config['budget'],
    private readonly save: (s: BudgetState) => Promise<void>,
    private readonly now: () => number,
    private readonly openRouterHasCredits: boolean,
  ) {}

  static async load(
    limits: Config['budget'],
    load: () => Promise<BudgetState>,
    save: (s: BudgetState) => Promise<void>,
    now: () => number = Date.now,
    openRouterHasCredits = false,
  ): Promise<BudgetLedger> {
    const l = new BudgetLedger(await load(), limits, save, now, openRouterHasCredits);
    l.roll();
    return l;
  }

  private roll(): void {
    const t = this.now();
    const day = utcDay(t);
    if (this.state.day !== day) this.state = { ...this.state, day, dayCalls: 0, dayTokens: 0, freeDayCalls: 0 };
    this.state.minute = this.state.minute.filter((x) => t - x < 60_000);
  }

  private isOpenRouterFree(c: MeteredCall): boolean {
    return c.providerId === 'openrouter' && c.model.endsWith(':free');
  }

  /** Synchronous check used by the failover chain's `allowCall` hook. */
  block(c: MeteredCall): BudgetBlock | null {
    if (!c.cloud) return null;
    this.roll();
    if (this.state.minute.length >= this.limits.maxCallsPerMinute) return 'minute';
    if (this.state.dayCalls >= this.limits.dailyMaxApiCalls) return 'day-calls';
    if (this.state.dayTokens >= this.limits.dailyTokenCap) return 'day-tokens';
    if (this.isOpenRouterFree(c)) {
      const perMinute = this.state.minute.length; // all metered calls share the window; conservative
      if (perMinute >= OPENROUTER_FREE_LIMITS.perMinute) return 'openrouter-free-minute';
      const perDay = this.openRouterHasCredits ? OPENROUTER_FREE_LIMITS.perDayWith10Credits : OPENROUTER_FREE_LIMITS.perDayUnder10Credits;
      if (this.state.freeDayCalls >= perDay) return 'openrouter-free-day';
    }
    return null;
  }

  allow(c: MeteredCall): boolean {
    return this.block(c) === null;
  }

  /** Records a metered call before it is made, so a crash mid-call still counts it. */
  async begin(c: MeteredCall): Promise<void> {
    if (!c.cloud) return;
    this.roll();
    this.state.minute.push(this.now());
    this.state.dayCalls++;
    if (this.isOpenRouterFree(c)) this.state.freeDayCalls++;
    await this.save(this.state);
  }

  async addTokens(c: MeteredCall, tokens: number): Promise<void> {
    if (!c.cloud || tokens <= 0) return;
    this.state.dayTokens += tokens;
    await this.save(this.state);
  }

  /** True exactly once per UTC day, when a limit first blocks a call. */
  async claimExhaustedNotice(): Promise<boolean> {
    const day = utcDay(this.now());
    if (this.state.noticeDay === day) return false;
    this.state.noticeDay = day;
    await this.save(this.state);
    return true;
  }

  get exhausted(): boolean {
    this.roll();
    return this.state.dayCalls >= this.limits.dailyMaxApiCalls || this.state.dayTokens >= this.limits.dailyTokenCap;
  }

  get snapshot(): Readonly<BudgetState> {
    return this.state;
  }

  /** What the Options page and popup show: today's use against each limit, and when the day resets (UTC). */
  report(): BudgetReport {
    this.roll();
    const t = this.now();
    const next = new Date(t);
    next.setUTCHours(24, 0, 0, 0);
    const blockedBy = this.state.dayCalls >= this.limits.dailyMaxApiCalls ? 'day-calls' : this.state.dayTokens >= this.limits.dailyTokenCap ? 'day-tokens' : null;
    return {
      day: this.state.day,
      dayCalls: this.state.dayCalls,
      dailyMaxApiCalls: this.limits.dailyMaxApiCalls,
      dayTokens: this.state.dayTokens,
      dailyTokenCap: this.limits.dailyTokenCap,
      minuteCalls: this.state.minute.length,
      maxCallsPerMinute: this.limits.maxCallsPerMinute,
      exhausted: blockedBy !== null,
      blockedBy,
      resetsAt: next.toISOString(),
    };
  }
}

export interface BudgetReport {
  day: string;
  dayCalls: number;
  dailyMaxApiCalls: number;
  dayTokens: number;
  dailyTokenCap: number;
  minuteCalls: number;
  maxCallsPerMinute: number;
  exhausted: boolean;
  blockedBy: 'day-calls' | 'day-tokens' | null;
  resetsAt: string;
}
