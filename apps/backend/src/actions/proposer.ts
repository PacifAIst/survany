// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Turns an untrusted action proposal into a pending, human-approvable card (§4.3 step 6).
 * SECURITY-GATE SG-02: the model only ever produces JSON data that arrives here; it holds no MCP connection, HMAC key, device key or nonce. Only this deterministic code talks to the gate.
 */
import { ActionProposalSchema, type ActionToolsResponse } from '@survey-anything/shared';
import type { FastifyInstance } from 'fastify';
import { getEvent, notify } from '../alerts/dispatcher';
import type { Senders } from '../alerts/outbox';
import type { AppCtx } from '../context';
import { requireDevice } from '../routes/common';
import { createApproval } from './approvals';
import { appendAudit } from './audit';
import { GateUnavailableError } from './gate-client';
import { checkProposal, type Policy } from './policy';
import { renderCard } from './render-card';

export type ProposeOutcome = { status: 'pending'; approvalId: string; sentTo: number } | { status: 'rejected'; reason: string };

export async function proposeAction(ctx: AppCtx, senders: Senders, policy: Policy | null, deviceId: string, raw: unknown): Promise<ProposeOutcome> {
  const parsed = ActionProposalSchema.safeParse(raw);
  if (!parsed.success) return { status: 'rejected', reason: 'proposal is not valid JSON of the expected shape' };
  const p = parsed.data;
  const ev = getEvent(ctx, p.eventId);
  if (!ev || ev.device_id !== deviceId) return { status: 'rejected', reason: 'unknown event' };
  if (!policy || !ctx.gate) return { status: 'rejected', reason: 'actions are not enabled on this backend' };
  const decision = checkProposal(policy, p.tool, p.args);
  if (!decision.ok) {
    appendAudit(ctx.db, 'proposal.rejected', { eventId: p.eventId, tool: p.tool, reason: decision.reason });
    return { status: 'rejected', reason: decision.reason };
  }
  const card = renderCard(decision.tool, decision.args, { ruleTitle: ev.rule_title, sourceLabel: ev.source_label, timeoutSec: policy.pendingTtlSeconds });
  let pendingId: string;
  try {
    pendingId = (await ctx.gate.propose(decision.tool.name, decision.args)).pendingId;
  } catch (e) {
    const msg = e instanceof GateUnavailableError ? e.message : String(e);
    appendAudit(ctx.db, 'proposal.gate-failed', { eventId: p.eventId, tool: p.tool, error: msg });
    await notify(ctx, senders, ['owner'], `gatefail:propose:${p.eventId}`, 'Approval gate unreachable', `A proposed action (${p.tool}) could not be registered with the gate, so it was dropped. ${msg}`);
    return { status: 'rejected', reason: 'gate unreachable' };
  }
  const a = await createApproval(ctx, { eventId: ev.id, tool: decision.tool.name, args: decision.args, paramsHash: card.paramsHash, cardHtml: card.html, gatePendingId: pendingId, timeoutSec: policy.pendingTtlSeconds });
  return { status: 'pending', approvalId: a.id, sentTo: a.sentTo };
}

/**
 * The tool list the extension's Reasoner may choose from. It is derived from the policy so the Reasoner
 * never sees a tool the backend would refuse; the policy check on /propose still decides.
 */
export function toolsFor(ctx: AppCtx, policy: Policy | null): ActionToolsResponse {
  if (!policy || !ctx.gate) return { enabled: false, approvalTimeoutSec: 0, tools: [] };
  return {
    enabled: true,
    approvalTimeoutSec: policy.pendingTtlSeconds,
    tools: policy.tools.map((t) => {
      const allow = t.entities.allow.concat(t.entities.allowSensitive);
      const entityNote = t.entityArg && allow.length ? ` ${t.entityArg} must match one of: ${allow.join(', ')}.` : '';
      return {
        name: t.name,
        description: `Card shown to the approver: "${t.card}".${entityNote}`.slice(0, 400),
        args: Object.fromEntries(Object.entries(t.args).map(([k, s]) => [k, { ...s }])),
      };
    }),
  };
}

export function registerActionRoutes(app: FastifyInstance, ctx: AppCtx, senders: Senders, policy: Policy | null): void {
  app.get('/api/actions/tools', { preHandler: requireDevice(ctx) }, async () => toolsFor(ctx, policy));

  app.post('/api/actions/propose', { preHandler: requireDevice(ctx) }, async (req, reply) => {
    if (!req.device) return reply.code(401).send({ error: 'device required' });
    const out = await proposeAction(ctx, senders, policy, req.device.id, req.body);
    return out.status === 'pending' ? out : reply.code(422).send(out);
  });
}
