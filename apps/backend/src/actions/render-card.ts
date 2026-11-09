/**
 * SECURITY-GATE SG-03: the approval card is rendered by the backend from the policy template, tool and validated args only; model text never reaches it, and the approval is bound to a params hash.
 */
import { escapeTelegramHtml } from '@survey-anything/shared';
import type { ToolPolicyT } from './policy';
import { paramsHash } from './signer';

export interface Card {
  html: string;
  paramsHash: string;
}

export function renderCard(tool: ToolPolicyT, args: Record<string, string | number | boolean>, ctx: { ruleTitle: string; sourceLabel: string; timeoutSec: number }): Card {
  const line = tool.card.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (_m, k: string) => (k in args ? String(args[k]) : `{${k}}`));
  const hash = paramsHash(tool.name, args);
  const html = [
    '<b>🔐 Approval needed</b>',
    `Action: <b>${escapeTelegramHtml(line)}</b>`,
    `Because of: ${escapeTelegramHtml(ctx.ruleTitle)} (${escapeTelegramHtml(ctx.sourceLabel)})`,
    `Tool: <code>${escapeTelegramHtml(tool.name)}</code>`,
    ...Object.entries(args).map(([k, v]) => `• ${escapeTelegramHtml(k)}: <code>${escapeTelegramHtml(String(v))}</code>`),
    `Params hash: <code>${hash.slice(0, 16)}</code>`,
    `No answer in ${ctx.timeoutSec} s means <b>deny</b>.`,
  ].join('\n');
  return { html, paramsHash: hash };
}
