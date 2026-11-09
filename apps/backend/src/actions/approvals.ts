// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pending approvals (§4.3 step 6).
 * SECURITY-GATE SG-01: no device action without a human tap; a pending approval that times out is denied, and each approval can be decided exactly once.
 */
import { encodeCallback, newId22 } from '@survey-anything/shared';
import { getContact, notify } from '../alerts/dispatcher';
import type { Senders } from '../alerts/outbox';
import type { AppCtx } from '../context';
import type { Keyboard } from '../alerts/telegram';
import { appendAudit } from './audit';
import { GateUnavailableError } from './gate-client';

export interface ApprovalRow {
  id: string;
  event_id: string;
  tool: string;
  args: string;
  params_hash: string;
  card_text: string;
  created_at: number;
  expires_at: number;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
  decided_by: string | null;
  decided_at: number | null;
  gate_pending_id: string | null;
  result: string | null;
}

export interface Approver {
  contactId: string;
  roles: string[];
  telegramUserId: string;
  chatId: string;
}

function approverChats(ctx: AppCtx): { contactId: string; chatId: string }[] {
  const rows = ctx.db.prepare('SELECT id, roles, telegram_chat_id FROM contacts WHERE telegram_chat_id IS NOT NULL').all() as { id: string; roles: string; telegram_chat_id: string }[];
  return rows.filter((r) => (JSON.parse(r.roles) as string[]).includes('approver')).map((r) => ({ contactId: r.id, chatId: r.telegram_chat_id }));
}

export async function createApproval(
  ctx: AppCtx,
  a: { eventId: string; tool: string; args: Record<string, unknown>; paramsHash: string; cardHtml: string; gatePendingId: string; timeoutSec: number },
): Promise<{ id: string; sentTo: number }> {
  if (!ctx.telegram) throw new Error('approvals need Telegram (D5)');
  const id = newId22();
  const now = ctx.now();
  ctx.db
    .prepare(
      "INSERT INTO approvals(id, event_id, tool, args, params_hash, card_text, created_at, expires_at, status, gate_pending_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
    )
    .run(id, a.eventId, a.tool, JSON.stringify(a.args), a.paramsHash, a.cardHtml, now, now + a.timeoutSec * 1000, a.gatePendingId);
  appendAudit(ctx.db, 'approval.created', { id, eventId: a.eventId, tool: a.tool, paramsHash: a.paramsHash }, now);
  const keyboard = approvalKeyboard(id);
  let sent = 0;
  for (const ap of approverChats(ctx)) {
    try {
      const mid = await ctx.telegram.sendMessage(ap.chatId, a.cardHtml, keyboard);
      ctx.db.prepare('INSERT INTO approval_messages(approval_id, chat_id, message_id) VALUES (?, ?, ?)').run(id, ap.chatId, mid);
      sent++;
    } catch (e) {
      ctx.log.warn({ err: String(e), contact: ap.contactId }, 'approval card not delivered');
    }
  }
  return { id, sentTo: sent };
}

function approvalKeyboard(id: string): Keyboard {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: encodeCallback({ kind: 'approve', id }) },
      { text: '❌ Deny', callback_data: encodeCallback({ kind: 'deny', id }) },
    ]],
  };
}

/**
 * Edits every copy of the card. Telegram drops a message's buttons when an edit omits reply_markup, so a
 * closed card loses them and a card that needs one more tap (high-risk second yes) keeps them.
 */
async function closeCards(ctx: AppCtx, id: string, footer: string, keepButtons = false): Promise<void> {
  const row = ctx.db.prepare('SELECT card_text FROM approvals WHERE id = ?').get(id) as { card_text: string } | undefined;
  const msgs = ctx.db.prepare('SELECT chat_id, message_id FROM approval_messages WHERE approval_id = ?').all(id) as { chat_id: string; message_id: number }[];
  for (const m of msgs) {
    await ctx.telegram?.editMessageText(m.chat_id, m.message_id, `${row?.card_text ?? ''}\n\n${footer}`, keepButtons ? approvalKeyboard(id) : undefined).catch(() => undefined);
  }
}

export async function decideApproval(ctx: AppCtx, senders: Senders, id: string, decision: 'approve' | 'deny', who: Approver): Promise<{ message: string }> {
  const now = ctx.now();
  const a = ctx.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  if (!a) return { message: 'Unknown approval.' };
  // SG-04: only an approver, tapping in the private chat the card was sent to.
  if (!who.roles.includes('approver')) {
    appendAudit(ctx.db, 'approval.rejected-tap', { id, by: who.contactId, reason: 'not an approver' }, now);
    return { message: 'You are not an approver.' };
  }
  const contact = getContact(ctx, who.contactId);
  if (!contact || contact.telegram_user_id !== who.telegramUserId) return { message: 'Identity mismatch.' };
  const sentHere = ctx.db.prepare('SELECT 1 FROM approval_messages WHERE approval_id = ? AND chat_id = ?').get(id, who.chatId);
  if (!sentHere) {
    appendAudit(ctx.db, 'approval.rejected-tap', { id, by: who.contactId, reason: 'card not sent to this chat' }, now);
    return { message: 'This card was not sent to you.' };
  }
  if (a.status !== 'pending') return { message: `Already ${a.status}.` };
  if (a.expires_at <= now) {
    await expireOne(ctx, a);
    return { message: 'Timed out: denied.' };
  }
  // Atomic single decision: a replayed or double tap finds the row no longer pending.
  const next = decision === 'approve' ? 'approved' : 'denied';
  const claimed = ctx.db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(next, who.contactId, now, id);
  if (claimed.changes !== 1) return { message: 'Already decided.' };
  appendAudit(ctx.db, `approval.${next}`, { id, by: who.contactId, paramsHash: a.params_hash }, now);

  if (decision === 'deny') {
    if (ctx.gate && a.gate_pending_id) await ctx.gate.deny(a.gate_pending_id).catch((e: unknown) => ctx.log.warn({ err: String(e) }, 'gate deny failed'));
    await closeCards(ctx, id, `❌ Denied by ${who.contactId}.`);
    return { message: 'Denied. Nothing will run.' };
  }

  if (!ctx.gate || !a.gate_pending_id) {
    ctx.db.prepare("UPDATE approvals SET status = 'failed', result = ? WHERE id = ?").run('gate not configured', id);
    await closeCards(ctx, id, '⚠️ Gate not configured: nothing ran.');
    return { message: 'Gate not configured: nothing ran.' };
  }
  try {
    const r = await ctx.gate.approve(a.gate_pending_id, a.tool, JSON.parse(a.args) as Record<string, unknown>);
    const status = r.status === 'done' ? 'executed' : r.status === 'needs_final_yes' ? 'pending' : 'failed';
    if (status === 'pending') {
      // High-risk tool: the gate opened a new card set for a second, separate yes (its final_ttl is 60 s).
      // Re-open this approval for one more tap, bound to the new gate card.
      ctx.db
        .prepare("UPDATE approvals SET status = 'pending', decided_by = NULL, decided_at = NULL, expires_at = ?, gate_pending_id = COALESCE(?, gate_pending_id) WHERE id = ?")
        .run(now + 60_000, r.nextPendingId, id);
      await closeCards(ctx, id, '⚠️ High-risk action: tap Approve once more within 60 s to confirm.', true);
      return { message: 'Second confirmation required.' };
    }
    ctx.db.prepare('UPDATE approvals SET status = ?, result = ? WHERE id = ?').run(status, JSON.stringify(r.receipt ?? r.reason ?? null).slice(0, 4000), id);
    appendAudit(ctx.db, `approval.${status}`, { id, gateStatus: r.status, reason: r.reason });
    await closeCards(ctx, id, status === 'executed' ? `✅ Approved by ${who.contactId}. Executed.` : `⚠️ Gate ${r.status}: ${r.reason ?? 'nothing ran'}.`);
    return { message: status === 'executed' ? 'Approved and executed.' : `Not executed: ${r.reason ?? r.status}` };
  } catch (e) {
    // SG-05: gate unreachable means deny and notify a human.
    const msg = e instanceof GateUnavailableError ? e.message : `gate error: ${e instanceof Error ? e.message : String(e)}`;
    ctx.db.prepare("UPDATE approvals SET status = 'failed', result = ? WHERE id = ?").run(msg.slice(0, 500), id);
    appendAudit(ctx.db, 'approval.gate-failed', { id, error: msg });
    await closeCards(ctx, id, '⚠️ The approval gate is unreachable: denied, nothing ran.');
    await notify(ctx, senders, ['owner'], `gatefail:${id}`, 'Approval gate unreachable', `Action "${a.tool}" was approved but the gate could not be reached, so it was denied. ${msg}`);
    return { message: 'Gate unreachable: denied, nothing ran.' };
  }
}

async function expireOne(ctx: AppCtx, a: ApprovalRow): Promise<void> {
  const r = ctx.db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").run(ctx.now(), a.id);
  if (r.changes !== 1) return;
  appendAudit(ctx.db, 'approval.expired', { id: a.id });
  if (ctx.gate && a.gate_pending_id) await ctx.gate.deny(a.gate_pending_id).catch(() => undefined);
  await closeCards(ctx, a.id, '⏱ No answer in time: denied. Nothing ran.');
}

/** Timeout means deny (SG-01). Called by the watchdog. */
export async function expireApprovals(ctx: AppCtx): Promise<number> {
  const due = ctx.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ?").all(ctx.now()) as unknown as ApprovalRow[];
  for (const a of due) await expireOne(ctx, a);
  return due.length;
}
