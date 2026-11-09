// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** Email acknowledge (§4.3): inert on GET; a POST with the contact's PIN acknowledges. */
import { SOURCE_URL } from '@survey-anything/shared';
import { post } from './api';
import { readLink, renderMeta } from './meta';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function status(text: string, error = false): void {
  const el = $('status');
  el.textContent = text;
  el.className = error ? 'error' : '';
}

$('source').setAttribute('href', SOURCE_URL);
const { token, meta } = readLink(location.search);
renderMeta($('meta'), meta, 'unverified');
if (!token) status('This link is incomplete.', true);
$('pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!token) return;
  const pin = ($('pin') as HTMLInputElement).value.trim();
  void post<{ acknowledged: boolean; first: boolean }>('/api/ack/email', { token, pin }).then((r) => {
    if (r.kind === 'ok') {
      $('pin-form').hidden = true;
      renderMeta($('meta'), meta, 'verified');
      status(r.value.first ? 'Acknowledged. Thank you.' : 'Someone already acknowledged this alert.');
    } else if (r.kind === 'rejected') {
      if (r.status === 403 && /expired|invalid/.test(r.reason)) renderMeta($('meta'), {}, 'rejected');
      status(r.reason, true);
    } else {
      status('The server is unavailable. Acknowledge from Telegram, or contact the owner directly.', true);
    }
  });
});
