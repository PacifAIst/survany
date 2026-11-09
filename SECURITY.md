# Security policy

Survey Anything watches cameras and screens and can, after human approval, trigger device actions. Security reports are the most valuable contribution you can make.

## Reporting

Use GitHub's **private vulnerability reporting** on this repository (Security tab → "Report a vulnerability"). Do not open a public issue. Include reproduction steps, affected component (extension, backend, viewer, deploy) and the security gate (SG-xx in `docs/PLAN.md` §7) you believe is bypassed, if any.

We aim to acknowledge within 72 hours and to ship a fix or mitigation for critical issues within 14 days.

## Scope

In scope, with highest priority:

- Any path where a device action executes without a human Telegram tap (SG-01 to SG-06).
- Any way for model output, page text or image content to reach an approval card, URL, shell or action unvalidated (principle 7).
- Stream or viewer access without a valid, bound token (SG-09 to SG-12, SG-27).
- Frames leaving the machine while `allowCloudProviders` is false or the relevant `egress` flag is off (SG-14, SG-15).
- Streaming without the visible indicator (SG-13).

Out of scope: a fully compromised backend host (see `docs/THREAT_MODEL.md`), social engineering of the owner, and denial of service against a self-hosted instance by its own operator.

## Not end-to-end encrypted

Telegram bot messages and email are not end-to-end encrypted for this use. Snapshots and links pass through those providers. See `docs/PRIVACY_POLICY.md`.
