/**
 * Viewer-link metadata in the URL query string (§4.3 step 4, §10).
 * SECURITY-GATE SG-27: each field is validated independently, length-capped, and dropped if invalid; never free text.
 */
import { UUID_RE } from './ids';

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface ViewerMeta {
  eventId: string;
  rule: string;
  severity: Severity;
  timestamp: string;
}

export const VIEWER_QUERY_KEYS = { token: 't', eventId: 'event_id', rule: 'rule', severity: 'severity', timestamp: 'timestamp' } as const;

const RULE_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_FIELD = 64;

function field(params: URLSearchParams, key: string): string | null {
  const all = params.getAll(key);
  if (all.length !== 1) return null; // duplicated keys are ambiguous: drop
  const v = all[0] ?? '';
  return v.length > 0 && v.length <= MAX_FIELD ? v : null;
}

export function isValidTimestamp(s: string): boolean {
  if (!TS_RE.test(s)) return false;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return false;
  // Round-trip check rejects 2026-02-31 style dates that Date.parse normalizes.
  return new Date(t).toISOString().slice(0, 19) === s.slice(0, 19);
}

export function parseViewerMeta(params: URLSearchParams): Partial<ViewerMeta> {
  const out: Partial<ViewerMeta> = {};
  const eventId = field(params, VIEWER_QUERY_KEYS.eventId);
  if (eventId && UUID_RE.test(eventId)) out.eventId = eventId;
  const rule = field(params, VIEWER_QUERY_KEYS.rule);
  if (rule && RULE_RE.test(rule)) out.rule = rule;
  const severity = field(params, VIEWER_QUERY_KEYS.severity);
  if (severity && (SEVERITIES as readonly string[]).includes(severity)) out.severity = severity as Severity;
  const timestamp = field(params, VIEWER_QUERY_KEYS.timestamp);
  if (timestamp && isValidTimestamp(timestamp)) out.timestamp = timestamp;
  return out;
}

/** Builds the query string. Free text such as `reason` is never accepted here. */
export function buildViewerQuery(token: string, meta: ViewerMeta): string {
  const p = new URLSearchParams();
  p.set(VIEWER_QUERY_KEYS.token, token);
  p.set(VIEWER_QUERY_KEYS.eventId, meta.eventId);
  p.set(VIEWER_QUERY_KEYS.rule, meta.rule);
  p.set(VIEWER_QUERY_KEYS.severity, meta.severity);
  p.set(VIEWER_QUERY_KEYS.timestamp, meta.timestamp);
  const roundTrip = parseViewerMeta(p);
  if (Object.keys(roundTrip).length !== 4) throw new Error('viewer metadata failed its own validation');
  return p.toString();
}
