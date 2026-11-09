/** Minimal in-memory chrome.* for unit-testing service-worker modules in Node. */
export function installChromeMock(): { store: Map<string, unknown>; badge: { text: string }; notifications: string[] } {
  const store = new Map<string, unknown>();
  const badge = { text: '' };
  const notifications: string[] = [];
  const local = {
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
    },
    async remove(k: string) {
      store.delete(k);
    },
    async setAccessLevel() {},
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'testext', getURL: (p: string) => `chrome-extension://testext/${p.replace(/^\//, '')}` },
    storage: { local, session: { ...local, setAccessLevel: async () => undefined } },
    action: {
      async setBadgeText(o: { text: string }) {
        badge.text = o.text;
      },
      async getBadgeText() {
        return badge.text;
      },
      async setBadgeBackgroundColor() {},
      async setTitle() {},
    },
    notifications: {
      async create(id: string) {
        notifications.push(id);
        return id;
      },
      async clear() {
        return true;
      },
    },
    alarms: { async clear() {}, create() {} },
  };
  return { store, badge, notifications };
}
