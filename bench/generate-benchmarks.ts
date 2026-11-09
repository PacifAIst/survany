#!/usr/bin/env node
/**
 * Renders docs/BENCHMARKS.md from the evidence files in bench/reports/ (PLAN M7: "BENCHMARKS.md generated
 * from one command"). Run: pnpm bench. Never edit BENCHMARKS.md by hand; re-run the measurement instead.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reports = join(root, 'bench', 'reports');

function load<T>(name: string): T | null {
  const p = join(reports, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
}

/**
 * Retrain rule (owner decision, 2026-11-09): the shipped fire/smoke model must keep fire mAP@0.5 at or above
 * this floor on the official D-Fire test split, measured on the exported ONNX. Any run below it means
 * retrain; `pnpm bench` fails and so does the scripts test suite.
 */
export const FIRE_AP50_FLOOR = 0.7;

export function fireFloorVerdict(r: { eval: { coco: Record<string, { mAP50: number } | undefined> } }): { ok: boolean; fireAP50: number | null; margin: number | null } {
  const v = r.eval.coco['fire']?.mAP50 ?? null;
  return { ok: v !== null && v >= FIRE_AP50_FLOOR, fireAP50: v, margin: v === null ? null : v - FIRE_AP50_FLOOR };
}

const pct = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | null | undefined, digits = 3): string => (v === null || v === undefined ? 'n/a' : v.toFixed(digits));

interface FireSmoke {
  model: string;
  onnxSha256: string;
  onnxBytes: number;
  training: { epochs: number; batch: number; input: number; trainImages: number; valImages: number; excludedPublicImages: number; bestValAP50_95: number | null; bestValAP50: number | null; gpu: string; minutes: number | null };
  dataset: { source: string; verified: Record<string, number>; official: Record<string, number> };
  torchTest: { AP50_95: number | null; AP50: number | null } | null;
  eval: {
    test_images: number;
    positives: number;
    none_images: number;
    coco: Record<string, { mAP50_95: number; mAP50: number }>;
    gate: {
      threshold: number;
      recall_fire_or_smoke_images: number | null;
      recall_images_with_fire: number | null;
      recall_smoke_only_images: number | null;
      false_alarm_rate_none_images: number | null;
      image_precision: number | null;
      false_alarm_rate_none_images_excluding_public: number | null;
    }[];
    cpu_ms_per_image: number;
  };
}

interface Soak {
  minutes: number;
  intervalMs: number;
  ticks: number;
  fractionWithinOneSecond: number;
  maxGapMs: number;
  maxConsecutiveMissed: number;
  headless: boolean;
  chromium: string;
  finishedAt: string;
}

function fireSmoke(r: FireSmoke): string {
  const coco = r.eval.coco;
  const lines = [
    '## Fire and smoke detector (M2)',
    '',
    `YOLOX-tiny fine-tuned from Megvii's COCO weights on D-Fire, evaluated on the **official D-Fire test split** (${r.eval.test_images} images: ${r.eval.positives} with fire or smoke, ${r.eval.none_images} with neither). The numbers below are measured on the exported ONNX file the extension ships (\`${r.model}\`, sha256 \`${r.onnxSha256.slice(0, 16)}…\`, ${(r.onnxBytes / 1e6).toFixed(1)} MB), with the extension's preprocessing (416 letterbox, BGR).`,
    '',
    '### Detection quality (COCO metrics)',
    '',
    '| Class | mAP@0.5 | mAP@0.5:0.95 |',
    '|---|---|---|',
    ...(['all', 'fire', 'smoke'] as const).map((k) => `| ${k} | ${num(coco[k]?.mAP50)} | ${num(coco[k]?.mAP50_95)} |`),
    '',
    r.torchTest ? `Cross-check with YOLOX's own evaluator on the PyTorch checkpoint: mAP@0.5 ${num(r.torchTest.AP50)}, mAP@0.5:0.95 ${num(r.torchTest.AP50_95)}.` : '',
    '',
    '### What the fire gate sees (per frame)',
    '',
    'A frame "fires" when any fire or smoke box reaches the threshold after the extension\'s class-agnostic NMS. The extension additionally needs N-of-M hits (default 2 of 3) before it calls a model, which lowers false alarms further; that is not modelled here. The default gate threshold is 0.6 (`minYoloConfidence` and the recipe\'s `minConfidence`).',
    '',
    '| Threshold | Recall, images with fire or smoke | Recall, images with fire | Recall, smoke-only images | False alarms on "none" images | Image precision |',
    '|---|---|---|---|---|---|',
    ...r.eval.gate.map((g) => `| ${g.threshold} | ${pct(g.recall_fire_or_smoke_images)} | ${pct(g.recall_images_with_fire)} | ${pct(g.recall_smoke_only_images)} | ${pct(g.false_alarm_rate_none_images)} | ${pct(g.image_precision)} |`),
    '',
    `CPU inference in the evaluator (onnxruntime, single image): ${r.eval.cpu_ms_per_image} ms per image.`,
    '',
    '### Retrain rule',
    '',
    (() => {
      const v = fireFloorVerdict(r);
      return `**Retrain if fire AP (mAP@0.5 on the official D-Fire test split, measured on the shipped ONNX) drops below ${FIRE_AP50_FLOOR.toFixed(2)} on any future run.** This run: ${num(v.fireAP50)}, which is ${v.margin === null ? 'n/a' : `${v.margin >= 0 ? '' : '-'}${Math.abs(v.margin).toFixed(3)}`} ${v.ok ? 'above' : 'BELOW'} the line${v.ok ? ', a thin margin: treat any retraining, data change or export change as a candidate regression and re-measure before shipping' : ': do not ship this model'}. \`pnpm bench\` exits with an error below the line, and the scripts test suite checks the report in \`bench/reports/\` on every CI run.`;
    })(),
    '',
    '### Known weak spot: smoke without visible flame',
    '',
    "Smoke-only frames are the hardest case. At the default threshold the model misses about 3 in 10 of them per frame, while it catches fire images reliably. Lowering the recipe's `minConfidence` trades recall for false alarms:",
    '',
    '| Threshold | Recall, smoke-only images | False alarms on "none" images | Recall, images with fire |',
    '|---|---|---|---|',
    ...r.eval.gate.map((g) => `| ${g.threshold}${g.threshold === 0.6 ? ' (default)' : ''} | ${pct(g.recall_smoke_only_images)} | ${pct(g.false_alarm_rate_none_images)} | ${pct(g.recall_images_with_fire)} |`),
    '',
    (() => {
      const at = (t: number) => r.eval.gate.find((g) => g.threshold === t);
      const d = at(0.6);
      const l = at(0.4);
      if (!d || !l || d.recall_smoke_only_images === null || l.recall_smoke_only_images === null || d.false_alarm_rate_none_images === null || l.false_alarm_rate_none_images === null) return '';
      return `Going from 0.6 to 0.4 raises smoke-only recall from ${pct(d.recall_smoke_only_images)} to ${pct(l.recall_smoke_only_images)} and multiplies per-frame false alarms by ${(l.false_alarm_rate_none_images / d.false_alarm_rate_none_images).toFixed(1)} (${pct(d.false_alarm_rate_none_images)} to ${pct(l.false_alarm_rate_none_images)}). The 2-of-3 frame rule and the vision-model confirmation absorb part of that; neither is modelled in these per-frame numbers. Where smoke matters most (a kitchen, a server room), consider a copy of the \`fire\` recipe with \`minConfidence\` 0.4.`;
    })(),
    '',
    '### Training',
    '',
    `- Data: ${r.dataset.source}. Verified against every number in the official D-Fire README before training: ${Object.entries(r.dataset.verified).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    `- ${r.training.trainImages} training and ${r.training.valImages} validation images (1 in 10 training images by filename hash). ${r.training.excludedPublicImages} images prefixed \`PublicDataset\` were left out of training and validation because D-Fire's README says they remain under their original providers' terms; the weights are trained on CC0 images only. The test split is evaluated in full.`,
    `- ${r.training.epochs} epochs, batch ${r.training.batch}, input ${r.training.input}, fp16, ${r.training.gpu}${r.training.minutes ? `, ${Math.round(r.training.minutes)} minutes` : ''}. Best validation checkpoint: mAP@0.5 ${num(r.training.bestValAP50)}, mAP@0.5:0.95 ${num(r.training.bestValAP50_95)}.`,
    '- Reproduce: see `models/fire-smoke/README.md`.',
    '',
  ];
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

function soak(s: Soak): string {
  return [
    '## Scan-loop timing (M1)',
    '',
    '| Duration | Target interval | Ticks | Within ±1 s | Longest gap | Consecutive misses |',
    '|---|---|---|---|---|---|',
    `| ${s.minutes} min | ${s.intervalMs / 1000} s | ${s.ticks} | ${pct(s.fractionWithinOneSecond)} | ${(s.maxGapMs / 1000).toFixed(2)} s | ${s.maxConsecutiveMissed} |`,
    '',
    `Chromium ${s.chromium}${s.headless ? ' (headless)' : ''}, fake camera, every page hidden behind another tab. Acceptance: ≥ 95% within ±1 s and no more than 1 consecutive miss.`,
    '',
  ].join('\n');
}

function m5(r: Record<string, unknown>): string {
  const v = r['view'] as { status: string; video: { w: number; h: number } } | undefined;
  const wf = r['webhookFailures'] as { hungStatus: number; hungMs: number; downDirect: number; downCaddy: number } | undefined;
  const un = r['untokened'] as { direct: number; viaCaddy: number } | undefined;
  const lt = r['lifetime'] as { ttlMinutes: number; cutAfterMs: number } | undefined;
  return [
    '## Live view against the real OvenMediaEngine (M5)',
    '',
    '| Check | Result |',
    '|---|---|',
    `| Publish over WHIP through forward_auth, then view in Chrome | ${v ? `${v.video.w}x${v.video.h} playing (${v.status.split('.')[0]})` : 'n/a'} |`,
    `| Untokened publish | OME ${un?.direct ?? 'n/a'}, forward_auth ${un?.viaCaddy ?? 'n/a'} |`,
    `| Admission webhook hung | denied (${wf?.hungStatus ?? 'n/a'}) after ${wf ? (wf.hungMs / 1000).toFixed(1) : 'n/a'} s |`,
    `| Backend stopped | OME ${wf?.downDirect ?? 'n/a'}, forward_auth ${wf?.downCaddy ?? 'n/a'} (fails closed) |`,
    `| Stream lifetime | cut ${lt ? (lt.cutAfterMs / 1000).toFixed(0) : 'n/a'} s into a ${lt?.ttlMinutes ?? 'n/a'}-minute TTL |`,
    '',
  ].join('\n');
}

function m6(r: { gate: string; scenarios: Record<string, Record<string, unknown>> }): string {
  const s = r.scenarios;
  return [
    `## Human-approved actions against the real ${r.gate} (M6)`,
    '',
    '| Scenario | Executions |',
    '|---|---|',
    `| Proposal, before any tap | ${s['approveOnce']?.['executionsBeforeTap'] ?? 'n/a'} |`,
    `| One approver tap | ${s['approveOnce']?.['executionsAfterTap'] ?? 'n/a'} |`,
    `| Then three replayed taps | ${s['approveOnce']?.['afterThreeReplays'] ?? 'n/a'} (total) |`,
    `| Non-approver, unknown user, other chat, group chat | ${s['wrongUserAndDeny']?.['executionsAfterWrongTaps'] ?? 'n/a'} |`,
    `| Explicit deny, then a late approve | ${s['wrongUserAndDeny']?.['executionsAfterDenyAndLateApprove'] ?? 'n/a'} |`,
    `| No tap within the window (expired after ${s['timeout'] ? ((s['timeout']['expiredAfterMs'] as number) / 1000).toFixed(0) : 'n/a'} s), then a late tap | ${s['timeout']?.['executionsAfterLateTap'] ?? 'n/a'} |`,
    `| Gate down at tap time (owner notified: ${s['gateDown']?.['ownerNotified'] ?? 'n/a'}) | ${s['gateDown']?.['executions'] ?? 'n/a'} |`,
    '',
  ].join('\n');
}

export function render(now = new Date()): string {
  const parts = [
    '# Benchmarks',
    '',
    `Generated by \`pnpm bench\` from \`bench/reports/*.json\` on ${now.toISOString().slice(0, 10)}. Do not edit by hand: re-run the measurement and regenerate.`,
    '',
  ];
  const fs = load<FireSmoke>('m2-fire-smoke.json');
  if (fs) parts.push(fireSmoke(fs));
  const sk = load<Soak>('m1-soak.json');
  if (sk) parts.push(soak(sk));
  const o = load<Record<string, unknown>>('m5-ome.json');
  if (o) parts.push(m5(o));
  const g = load<{ gate: string; scenarios: Record<string, Record<string, unknown>> }>('m6-gate.json');
  if (g) parts.push(m6(g));
  parts.push(
    '## Not measured yet',
    '',
    '- Per-provider precision, recall, time-to-alert, calls per hour, tokens and cost per day (§9, M7): needs the provider bench harness run against real providers.',
    '- False alarms on sunset, orange-clothing and on-screen-fire clips (§9): needs the clip set.',
    '- Prompt-injection red-team suppressed-event rate (§9, M7).',
    '',
  );
  return parts.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(root, 'docs', 'BENCHMARKS.md'), render());
  console.info('wrote docs/BENCHMARKS.md');
  const fs = load<FireSmoke>('m2-fire-smoke.json');
  if (fs) {
    const v = fireFloorVerdict(fs);
    if (!v.ok) {
      console.error(`RETRAIN: fire mAP@0.5 ${v.fireAP50 ?? 'n/a'} is below the ${FIRE_AP50_FLOOR} floor (docs/BENCHMARKS.md, retrain rule).`);
      process.exit(1);
    }
    console.info(`fire mAP@0.5 ${v.fireAP50?.toFixed(3)} >= ${FIRE_AP50_FLOOR} (margin ${v.margin?.toFixed(3)})`);
  }
}
