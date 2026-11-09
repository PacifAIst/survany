/**
 * SECURITY-GATE SG-17: the backend re-sanitizes every model-provided string before Telegram or email, regardless of what the extension did.
 */
export { escapeHtml, escapeTelegramHtml, sanitizeLabel, sanitizeReason } from '@survey-anything/shared';
