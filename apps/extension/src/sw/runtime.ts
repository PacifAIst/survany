/** Service-worker-wide helpers: the guarded network boundary and the backend client. */
import type { Config } from '@survey-anything/shared';
import { BackendClient } from './backend-client';
import { createGuardedFetch, type PolicyConfig } from './guarded-fetch';
import * as store from './storage';

/** If the stored config is invalid, the network policy falls back to the strictest settings. */
const STRICT_POLICY: PolicyConfig = {
  allowCloudProviders: false,
  proxyMode: false,
  egress: { alertMedia: false, liveView: false },
  backend: { url: null },
};

export const guardedFetch = createGuardedFetch(async () => {
  const { config } = await store.loadConfig();
  return config ?? STRICT_POLICY;
});

export async function backendClient(): Promise<BackendClient | null> {
  const device = await store.get('device');
  if (!device) return null;
  const token = await store.secret(device.tokenRef);
  if (!token) return null;
  return new BackendClient(device.backendUrl, token, guardedFetch);
}

export async function requireConfig(): Promise<Config> {
  const { config, errors } = await store.loadConfig();
  if (!config) throw new Error(`configuration invalid: ${errors.join('; ')}`);
  return config;
}
