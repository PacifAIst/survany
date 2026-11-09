// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * §4.3 step 6, extension half. After a confirmed alert has gone out, the Reasoner may suggest one device
 * action. It is a text-only call: it gets the DetectionResult and the tool list the backend's policy
 * allows, never a frame. Its answer is untrusted data, validated against that tool list here and against
 * the full policy on the backend, which renders the approval card and waits for a human tap on Telegram.
 *
 * SECURITY-GATE SG-02: the Reasoner only produces JSON that is posted to the backend's /api/actions/propose; the extension holds no MCP connection, gate key, device key or nonce, and never calls the gate.
 */
import { parseReasonerOutput, reasonText } from '@survey-anything/providers';
import { type Config, type DetectionResult, isCloudProfile, resolveProfile } from '@survey-anything/shared';
import { BudgetLedger } from './budget';
import { backendClient, guardedFetch } from './runtime';
import * as store from './storage';

export interface ProposalInput {
  eventId: string;
  rule: string;
  detection: DetectionResult;
}

export type ProposalOutcome =
  | { status: 'skipped'; why: string }
  | { status: 'none' }
  | { status: 'invalid'; reason: string }
  | { status: 'pending'; approvalId: string; sentTo: number }
  | { status: 'rejected'; reason: string }
  | { status: 'error'; error: string };

function skipped(why: string): ProposalOutcome {
  return { status: 'skipped', why };
}

export async function proposeForEvent(c: Config, ev: ProposalInput): Promise<ProposalOutcome> {
  if (!c.mcp.enabled) return skipped('mcp.enabled is off');
  if (!c.reasoner.enabled || !c.reasoner.providerId) return skipped('the Reasoner is off');
  const backend = await backendClient();
  if (!backend) return skipped('no paired backend (actions need T3)');
  const profile = resolveProfile(c, c.reasoner.providerId);
  const model = c.reasoner.model ?? profile?.model ?? null;
  if (!profile || !model) return skipped(`no profile or model for reasoner provider '${c.reasoner.providerId}'`);
  if (c.proxyMode && profile.apiKeyRef) return skipped('in proxy mode the browser holds no provider keys; use a local Reasoner that needs no key');

  let tools;
  try {
    tools = await backend.actionTools();
  } catch (e) {
    return { status: 'error', error: `tool list: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!tools.enabled || tools.tools.length === 0) return skipped('the backend has no gate or no tools in its policy');

  // The Reasoner call is a model call like any other: same budget, same egress rules (guardedFetch).
  const ledger = await BudgetLedger.load(c.budget, () => store.get('budget'), (s) => store.set('budget', s));
  const metered = { cloud: isCloudProfile(profile), providerId: profile.id, model };
  if (!ledger.allow(metered)) return skipped('budget');
  await ledger.begin(metered);

  let text: string;
  try {
    const res = await reasonText(
      {
        id: profile.id,
        baseUrl: profile.baseUrl,
        model,
        apiKey: await store.secret(profile.apiKeyRef),
        timeoutMs: profile.timeoutMs,
        // No frame ever goes to the Reasoner: a request carrying image bytes is blocked here (SG-15).
        fetchFn: (url, init) => guardedFetch(url, init, { purpose: 'provider', frames: 'none' }),
        directBrowser: true,
      },
      { detection: ev.detection, rule: ev.rule, tools: tools.tools, maxOutputTokens: c.vision.maxOutputTokens },
    );
    text = res.text;
    await ledger.addTokens(metered, res.usage.inputTokens + res.usage.outputTokens);
  } catch (e) {
    return { status: 'error', error: `reasoner: ${e instanceof Error ? e.message : String(e)}` };
  }

  const decision = parseReasonerOutput(text, tools.tools);
  if (decision.kind === 'none') return { status: 'none' };
  if (decision.kind === 'invalid') return { status: 'invalid', reason: decision.reason };
  try {
    const out = await backend.proposeAction({ eventId: ev.eventId, tool: decision.tool, args: decision.args });
    return out.status === 'pending' ? { status: 'pending', approvalId: out.approvalId, sentTo: out.sentTo } : { status: 'rejected', reason: out.reason };
  } catch (e) {
    return { status: 'error', error: `propose: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function describeOutcome(o: ProposalOutcome): string {
  switch (o.status) {
    case 'skipped':
      return `skipped (${o.why})`;
    case 'none':
      return 'the Reasoner suggested no action';
    case 'invalid':
      return `Reasoner output refused: ${o.reason}`;
    case 'pending':
      return `approval ${o.approvalId} sent to ${o.sentTo} approver(s); nothing runs without a tap`;
    case 'rejected':
      return `backend refused the proposal: ${o.reason}`;
    case 'error':
      return `error: ${o.error}`;
  }
}
