// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/** One-time PIN choice from a pairing link (§6.5). A PIN can only be reset by re-pairing. */
import { SOURCE_URL } from '@survey-anything/shared';
import { post } from './api';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

$('source').setAttribute('href', SOURCE_URL);
const token = new URLSearchParams(location.search).get('t');
$('pin-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = ($('pin') as HTMLInputElement).value.trim();
  const again = ($('pin2') as HTMLInputElement).value.trim();
  const st = $('status');
  if (!/^\d{6,8}$/.test(pin)) {
    st.textContent = 'Use 6 to 8 digits.';
    return;
  }
  if (pin !== again) {
    st.textContent = 'The two PINs differ.';
    return;
  }
  if (!token) {
    st.textContent = 'This link is incomplete.';
    return;
  }
  void post('/api/pin/setup', { token, pin }).then((r) => {
    if (r.kind === 'ok') {
      $('pin-form').hidden = true;
      st.textContent = 'PIN saved. You will need it to open live view and acknowledge from email. It cannot be changed here; ask the owner to re-pair you to reset it.';
    } else {
      st.textContent = r.kind === 'rejected' ? r.reason : 'The server is unavailable. Try again later.';
    }
  });
});
