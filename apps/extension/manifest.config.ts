/**
 * MV3 manifest. No content scripts at all (C2). Host access is optional and requested from a
 * user gesture for each origin the user types (C9). 'wasm-unsafe-eval' is the only CSP relaxation,
 * required by onnxruntime-web (S7). No remote code (S43).
 */
export interface ManifestInput {
  version: string;
}

export function buildManifest({ version }: ManifestInput): chrome.runtime.ManifestV3 {
  const icons = { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' };
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
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  };
}
