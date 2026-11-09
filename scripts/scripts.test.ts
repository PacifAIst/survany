import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findAlarmPeriods, violations } from './check-alarm-period.ts';
import { checkCompose, checkModels, licenseAllowed } from './check-licenses.ts';
import { evaluate, parseGates, parseMilestoneStatus, scanTree } from './check-security-gates.ts';
import { fillSecrets, SECRET_KEYS } from './gen-secrets.ts';

// Fake gate ids (SG-9x) so this file never satisfies a real gate's test requirement.
const PLAN = `
| ID | Gate | Enforced in | Milestone |
|---|---|---|---|
| SG-97 | thing | \`a\` | M1 |
| SG-98 | thing | \`b\` | M2, M5 |
| SG-99 | thing | \`c\` | M6 |
`;

describe('check-security-gates', () => {
  it('parses gates and milestone lists from the plan table', () => {
    expect(parseGates(PLAN)).toEqual([
      { id: 'SG-97', milestones: ['M1'] },
      { id: 'SG-98', milestones: ['M2', 'M5'] },
      { id: 'SG-99', milestones: ['M6'] },
    ]);
  });

  it('parses milestone status rows', () => {
    const s = parseMilestoneStatus('| M0 | done | x |\n| M1 | doing | |\n| M2 | todo | |');
    expect(s.get('M0')).toBe('done');
    expect(s.get('M1')).toBe('doing');
    expect(s.get('M2')).toBe('todo');
  });

  it('hard-fails a done milestone with no marker, warns on doing, ignores todo', () => {
    const gates = parseGates(PLAN);
    const status = parseMilestoneStatus('| M1 | done | |\n| M2 | doing | |\n| M6 | todo | |');
    const res = evaluate(gates, status, { markers: new Map(), tests: new Map() });
    expect(res.errors).toEqual(['SG-97 (M1): no code marker and no test']);
    expect(res.warnings).toEqual(['SG-98 (M2, M5): no code marker and no test']);
    expect(res.checked).toBe(2);
  });

  it('finds markers in code and references in test files only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), '// SECURITY-GATE SG-97: reason here\nexport {};');
    writeFileSync(join(dir, 'src', 'a.test.ts'), "it('SG-97 holds', () => {});");
    writeFileSync(join(dir, 'src', 'b.ts'), '// mentions SG-98 but is not a marker');
    writeFileSync(join(dir, 'Caddyfile'), '# SECURITY-GATE SG-98: forward_auth');
    const scan = scanTree(dir);
    expect(scan.markers.get('SG-97')).toEqual(['src/a.ts']);
    expect(scan.markers.get('SG-98')).toEqual(['Caddyfile']);
    expect(scan.tests.get('SG-97')).toEqual(['src/a.test.ts']);
    expect(scan.tests.has('SG-98')).toBe(false);
  });

  it('rejects an empty marker reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-'));
    writeFileSync(join(dir, 'x.ts'), '// SECURITY-GATE SG-97:\n');
    expect(scanTree(dir).markers.has('SG-97')).toBe(false);
  });
});

describe('check-alarm-period', () => {
  it('accepts literals and consts >= 0.5 min', () => {
    const src = 'const WATCHDOG_MIN = 0.5;\nchrome.alarms.create("w", { periodInMinutes: WATCHDOG_MIN });\nchrome.alarms.create("h", { periodInMinutes: 1 });';
    expect(violations(findAlarmPeriods(src, 'x.ts'))).toEqual([]);
  });

  it('rejects periods under 30 s and unresolvable expressions', () => {
    const src = 'chrome.alarms.create("a", { periodInMinutes: 0.1 });\nchrome.alarms.create("b", { delayInMinutes: cfg.x });';
    const v = violations(findAlarmPeriods(src, 'x.ts'));
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('0.1 min is under 0.5');
    expect(v[1]).toContain('not a resolvable numeric constant');
  });
});

describe('check-licenses', () => {
  it('evaluates SPDX expressions', () => {
    expect(licenseAllowed('MIT')).toBe(true);
    expect(licenseAllowed('(MIT OR GPL-3.0)')).toBe(true);
    expect(licenseAllowed('MIT AND GPL-3.0')).toBe(false);
    expect(licenseAllowed('UNLICENSED')).toBe(false);
    expect(licenseAllowed('SSPL-1.0')).toBe(false);
  });

  it('refuses Ultralytics weights and unchecksummed models', () => {
    const errs = checkModels(
      JSON.stringify({ files: [{ name: 'yolov8n.onnx', license: 'AGPL-3.0', sha256: 'x' }] }),
    );
    expect(errs.join('\n')).toMatch(/Ultralytics/);
    expect(errs.join('\n')).toMatch(/license AGPL-3.0 not allowed/);
    expect(errs.join('\n')).toMatch(/sha256/);
  });

  it('allows only OvenMediaEngine in the media plane', () => {
    expect(checkCompose('services:\n  ome:\n    image: airensoft/ovenmediaengine:0.21.0')).toEqual([]);
    expect(checkCompose('services:\n  r:\n    image: datarhei/restreamer:2')).toHaveLength(1);
    expect(checkCompose('services:\n  l:\n    image: livekit/livekit-server:v1')).toHaveLength(1);
  });
});

describe('gen-secrets', () => {
  it('fills empty secrets, keeps existing values, appends missing keys', () => {
    let n = 0;
    const out = fillSecrets('PUBLIC_HOST=example.org\nTELEGRAM_WEBHOOK_SECRET=keep\nOME_ADMISSION_SECRET=\n', () => `s${n++}`);
    expect(out).toContain('PUBLIC_HOST=example.org');
    expect(out).toContain('TELEGRAM_WEBHOOK_SECRET=keep');
    expect(out).toContain('OME_ADMISSION_SECRET=s0');
    for (const k of SECRET_KEYS) expect(out).toMatch(new RegExp(`^${k}=.+$`, 'm'));
  });
});

describe('fire/smoke retrain rule (docs/BENCHMARKS.md)', () => {
  it('the checked-in model report keeps fire mAP@0.5 at or above the floor; below it fails', async () => {
    const { readFileSync } = await import('node:fs');
    const { fireFloorVerdict, FIRE_AP50_FLOOR } = await import('../bench/generate-benchmarks.ts');
    const report = JSON.parse(readFileSync(join(__dirname, '..', 'bench', 'reports', 'm2-fire-smoke.json'), 'utf8')) as Parameters<typeof fireFloorVerdict>[0];
    const v = fireFloorVerdict(report);
    expect(FIRE_AP50_FLOOR).toBe(0.7);
    expect(v.ok, `fire mAP@0.5 ${v.fireAP50} is below ${FIRE_AP50_FLOOR}: retrain`).toBe(true);
    expect(fireFloorVerdict({ eval: { coco: { fire: { mAP50: 0.699 } } } }).ok).toBe(false);
    expect(fireFloorVerdict({ eval: { coco: {} } }).ok).toBe(false);
  });
});

describe('doctor (deployment check from outside)', () => {
  it('requires both hosts and treats only 401/403 as a refused untokened publish', async () => {
    const { parseArgs, untokenedVerdict } = await import('./doctor.ts');
    expect(() => parseArgs(['--live', 'x'])).toThrow(/usage/);
    expect(parseArgs(['--public', 'a.example', '--live', 'l.example', '--ip', '203.0.113.7'])).toEqual({ pub: 'a.example', live: 'l.example', ip: '203.0.113.7' });
    expect(untokenedVerdict(403).ok).toBe(true);
    expect(untokenedVerdict(401).ok).toBe(true);
    expect(untokenedVerdict(201).ok).toBe(false);
    expect(untokenedVerdict(404).ok).toBe(false);
    expect(untokenedVerdict(0).ok).toBe(false);
  });

  it('runs every check against a stub network and fails on an admitted publish', async () => {
    const { runDoctor } = await import('./doctor.ts');
    const stub = (whipStatus: number) => (async (url: string | URL | Request) => new Response('', { status: String(url).endsWith('/healthz') ? 200 : String(url).includes('direction=whip') ? whipStatus : 404 })) as typeof fetch;
    const ok = await runDoctor('a.invalid', 'l.invalid', '127.0.0.1', stub(403));
    expect(ok.map((c) => c.name)).toEqual(['backend reachable over TLS', 'OME signaling reachable over TLS', '3478/tcp open: OME TcpRelay (UDP-blocked viewers)', '10000/tcp open: ICE-TCP media', 'untokened WHIP publish refused']);
    expect(ok[0]!.ok && ok[1]!.ok && ok[4]!.ok).toBe(true);
    const bad = await runDoctor('a.invalid', 'l.invalid', '127.0.0.1', stub(201));
    expect(bad[4]).toMatchObject({ ok: false });
  });
});
