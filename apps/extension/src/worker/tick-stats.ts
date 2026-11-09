/** Tick timing statistics for the M1 soak acceptance (≥95% within ±1 s, no gap over 2 intervals). */

export interface TickSnapshot {
  ticks: number;
  withinOneSecond: number;
  fractionWithinOneSecond: number;
  maxGapMs: number;
  gapsOver2x: number;
  maxConsecutiveMissed: number;
  lastTickAt: number | null;
}

export class TickRecorder {
  private ticks = 0;
  private last: number | null = null;
  private withinOneSecond = 0;
  private maxGapMs = 0;
  private gapsOver2x = 0;
  private maxConsecutiveMissed = 0;

  constructor(public intervalMs: number) {}

  tick(t: number): void {
    if (this.last !== null) {
      const gap = t - this.last;
      if (Math.abs(gap - this.intervalMs) <= 1000) this.withinOneSecond++;
      if (gap > this.maxGapMs) this.maxGapMs = gap;
      if (gap > 2 * this.intervalMs) this.gapsOver2x++;
      const missed = Math.max(0, Math.round(gap / this.intervalMs) - 1);
      if (missed > this.maxConsecutiveMissed) this.maxConsecutiveMissed = missed;
    }
    this.ticks++;
    this.last = t;
  }

  snapshot(): TickSnapshot {
    const intervals = Math.max(0, this.ticks - 1);
    return {
      ticks: this.ticks,
      withinOneSecond: this.withinOneSecond,
      fractionWithinOneSecond: intervals === 0 ? 1 : this.withinOneSecond / intervals,
      maxGapMs: this.maxGapMs,
      gapsOver2x: this.gapsOver2x,
      maxConsecutiveMissed: this.maxConsecutiveMissed,
      lastTickAt: this.last,
    };
  }
}
