// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MV3 manifest. No content scripts at all (C2). Host access is optional and requested from a
 * user gesture for each origin the user types (C9). 'wasm-unsafe-eval' is the only CSP relaxation,
 * required by onnxruntime-web (S7). No remote code (S43).
 */
export interface ManifestInput {
  version: string;
  /** 'chrome' (default) or 'firefox' (`vite build --mode firefox` -> dist-firefox/). */
  target?: 'chrome' | 'firefox';
  /**
   * Test builds only (`vite build --mode e2e` -> dist-e2e/): pre-grant the two loopback origins the
   * end-to-end tests talk to, because the permission prompt is browser UI that automation cannot click.
   * The release build never sets this (asserted in test/sw.test.ts).
   */
  e2eLoopbackHosts?: boolean;
}

export const E2E_LOOPBACK_HOSTS = ['http://localhost/*', 'http://127.0.0.1/*'];
/** Test builds also pre-grant the two alert APIs, which Save now requests (the tests answer them with route mocks). */
export const E2E_ALERT_HOSTS = ['https://api.telegram.org/*', 'https://api.resend.com/*'];

/** Firefox add-on id on addons.mozilla.org. It must never change once the add-on is published. */
export const FIREFOX_ADDON_ID = 'survany@pacifaist';

/**
 * Firefox's data collection declaration (required for new AMO submissions since 2025-11-03). Mozilla counts
 * anything sent outside the add-on, including to services the user configures: snapshots of what is watched
 * go to the user's AI model and, with alert media on, to their Telegram bot or email; the alert itself
 * carries the user's chat ID or email address. Nothing goes to the developer (no telemetry).
 */
export const FIREFOX_DATA_COLLECTION = { required: ['websiteContent', 'personallyIdentifyingInfo'] };

export function buildManifest({ version, target = 'chrome', e2eLoopbackHosts = false }: ManifestInput): chrome.runtime.ManifestV3 {
  const icons = { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' };
  const hostPermissions = e2eLoopbackHosts ? { host_permissions: [...E2E_LOOPBACK_HOSTS, ...E2E_ALERT_HOSTS] } : {};
  const csp = { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" };
  if (target === 'firefox') {
    // Firefox runs background scripts as an event page (no service workers) and has neither offscreen
    // documents nor tab capture: capture runs in a pinned extension tab (src/sw/offscreen-host.ts).
    return {
      manifest_version: 3,
      name: 'Survey Anything',
      short_name: 'Survey Anything',
      version,
      description: 'AI monitoring for a camera, a window or the screen, with human approval.',
      icons,
      action: { default_popup: 'src/popup/index.html', default_title: 'Survey Anything', default_icon: icons },
      background: { scripts: ['sw.js'], type: 'module' },
      options_ui: { page: 'src/options/index.html', open_in_tab: true },
      permissions: ['storage', 'alarms', 'notifications'],
      optional_host_permissions: ['https://*/*', 'http://*/*'],
      ...hostPermissions,
      content_security_policy: csp,
      browser_specific_settings: {
        gecko: { id: FIREFOX_ADDON_ID, strict_min_version: '140.0', data_collection_permissions: FIREFOX_DATA_COLLECTION },
      },
    } as unknown as chrome.runtime.ManifestV3;
  }
  return {
    manifest_version: 3,
    name: 'Survey Anything',
    short_name: 'Survey Anything',
    version,
    description: 'AI monitoring for any browser tab or camera, with human approval.',
    minimum_chrome_version: '120',
    icons,
    action: { default_popup: 'src/popup/index.html', default_title: 'Survey Anything', default_icon: icons },
    background: { service_worker: 'sw.js', type: 'module' },
    options_ui: { page: 'src/options/index.html', open_in_tab: true },
    permissions: ['offscreen', 'tabCapture', 'activeTab', 'storage', 'alarms', 'notifications'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    ...hostPermissions,
    content_security_policy: csp,
  };
}
