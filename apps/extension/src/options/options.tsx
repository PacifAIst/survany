/** Options page for config schema v1 (§6.2). Every key is editable here or in the raw JSON editor. */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { BUILTIN_RECIPES, importRecipe, type Recipe } from '@survey-anything/recipes';
import {
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  defaultConfigInput,
  exportConfig,
  MODEL_LICENSES,
  OPENROUTER_FREE_LIMITS,
  parseConfig,
  PROVIDER_IDS,
  type ContactStatus,
  type ProviderId,
} from '@survey-anything/shared';
import type { ProbeResult } from '@survey-anything/providers';
import { requestHost, sw } from '../ui/rpc';
import { type Draft, getPath, importConfigJson, moveInList, omit, setPath, toggleChannel } from './model';

type Secrets = Record<string, string>;

function NumberField(p: { label: string; path: string; draft: Draft; set: (path: string, v: unknown) => void; step?: number; hint?: string }) {
  return (
    <label>
      {p.label}{' '}
      <input type="number" step={p.step ?? 1} value={String(getPath(p.draft, p.path) ?? '')} onInput={(e) => p.set(p.path, Number((e.target as HTMLInputElement).value))} />
      {p.hint && <span class="muted"> {p.hint}</span>}
    </label>
  );
}

function BoolField(p: { label: string; path: string; draft: Draft; set: (path: string, v: unknown) => void; locked?: boolean; hint?: string }) {
  return (
    <label class="inline">
      <input type="checkbox" checked={getPath(p.draft, p.path) === true} disabled={p.locked} onChange={(e) => p.set(p.path, (e.target as HTMLInputElement).checked)} /> {p.label}
      {p.locked && <span class="muted"> (always on)</span>}
      {p.hint && <span class="muted"> {p.hint}</span>}
    </label>
  );
}

function TextField(p: { label: string; path: string; draft: Draft; set: (path: string, v: unknown) => void; nullable?: boolean; size?: number }) {
  const v = getPath(p.draft, p.path);
  return (
    <label>
      {p.label}{' '}
      <input
        size={p.size ?? 36}
        value={typeof v === 'string' ? v : ''}
        onInput={(e) => {
          const s = (e.target as HTMLInputElement).value;
          p.set(p.path, p.nullable && s === '' ? null : s);
        }}
      />
    </label>
  );
}

function SecretField(p: { label: string; refName: string | null; secrets: Secrets; onSet: (ref: string, value: string) => void }) {
  const [val, setVal] = useState('');
  if (!p.refName) return null;
  const present = Boolean(p.secrets[p.refName]);
  return (
    <label>
      {p.label} <span class="muted">({p.refName}: {present ? 'set' : 'not set'})</span>{' '}
      <input type="password" autocomplete="off" value={val} placeholder={present ? '•••••• (replace)' : 'paste key'} onInput={(e) => setVal((e.target as HTMLInputElement).value)} />
      <button
        disabled={!val}
        onClick={() => {
          p.onSet(p.refName as string, val.trim());
          setVal('');
        }}
      >
        Store
      </button>
    </label>
  );
}

function ProviderCard(p: { id: ProviderId; path: string; draft: Draft; set: (path: string, v: unknown) => void; secrets: Secrets; onSecret: (ref: string, v: string) => void; primary: boolean; onRemove?: () => void }) {
  const [probe, setProbe] = useState<ProbeResult | { ok: false; error: string; hint?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const model = getPath(p.draft, `${p.path}.model`) as string | null;
  const baseUrl = getPath(p.draft, `${p.path}.baseUrl`) as string;
  const keyRef = getPath(p.draft, `${p.path}.apiKeyRef`) as string | null;

  const test = async (): Promise<void> => {
    setBusy(true);
    setProbe(null);
    try {
      // C9: user-typed origins need optional host permission, requested from this click.
      if (!(await requestHost(baseUrl))) throw new Error('permission to reach this host was not granted');
      await chrome.storage.local.set({ config: p.draft });
      setProbe(await sw<ProbeResult>({ type: 'test-provider', providerId: p.id }));
    } catch (e) {
      setProbe({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="card">
      <div class="row">
        <strong>{p.id}</strong>
        {p.primary && <span class="muted">Vision provider (must pass the image probe)</span>}
        {p.onRemove && <button onClick={p.onRemove}>Remove</button>}
      </div>
      <TextField label="Base URL" path={`${p.path}.baseUrl`} draft={p.draft} set={p.set} size={44} />
      <TextField label="Model" path={`${p.path}.model`} draft={p.draft} set={p.set} nullable />
      {model && <div class="muted">License: {MODEL_LICENSES[model] ?? 'unknown: read the model card before use'}</div>}
      {p.id === 'openrouter' && (
        <div class="muted">
          OpenRouter `:free` models: {OPENROUTER_FREE_LIMITS.perMinute}/min, {OPENROUTER_FREE_LIMITS.perDayUnder10Credits}/day below $10 lifetime credits, otherwise {OPENROUTER_FREE_LIMITS.perDayWith10Credits}/day. The budget engine enforces this.
        </div>
      )}
      <label>
        API key reference{' '}
        <input value={keyRef ?? ''} placeholder="key_name or empty" onInput={(e) => p.set(`${p.path}.apiKeyRef`, (e.target as HTMLInputElement).value || null)} />
      </label>
      <SecretField label="API key" refName={keyRef} secrets={p.secrets} onSet={p.onSecret} />
      <NumberField label="Timeout (ms, max 25000)" path={`${p.path}.timeoutMs`} draft={p.draft} set={p.set} />
      <button disabled={busy} onClick={() => void test()}>
        {busy ? 'Testing…' : 'Test connection'}
      </button>
      {probe && (
        <div class={probe.ok ? 'ok' : 'error'}>
          {probe.ok ? `Vision OK: read the code back in ${'latencyMs' in probe ? probe.latencyMs : 0} ms` : `Failed: ${probe.error}`}
          {'hint' in probe && probe.hint && <pre>{probe.hint}</pre>}
        </div>
      )}
    </div>
  );
}

function Options() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secrets, setSecrets] = useState<Secrets>({});
  const [imported, setImported] = useState<Recipe[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [pendingAck, setPendingAck] = useState<{ channel: 'telegram' | 'email'; on: boolean } | null>(null);
  const [raw, setRaw] = useState('');
  const [contacts, setContacts] = useState<ContactStatus[] | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [device, setDevice] = useState<{ deviceId: string; backendUrl: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const s = (await chrome.storage.local.get(['config', 'secrets', 'importedRecipes', 'device'])) as { config?: Draft; secrets?: Secrets; importedRecipes?: Recipe[]; device?: { deviceId: string; backendUrl: string } };
      const d = s.config ?? (defaultConfigInput() as Draft);
      setDraft(d);
      setRaw(JSON.stringify(d, null, 2));
      setSecrets(s.secrets ?? {});
      setImported(s.importedRecipes ?? []);
      setDevice(s.device ?? null);
      if (s.device) {
        try {
          const { BackendClient } = await import('../sw/backend-client');
          const { guardedFetch } = await import('../sw/runtime');
          const token = s.secrets?.['key_device_token'];
          if (token) setContacts(await new BackendClient(s.device.backendUrl, token, guardedFetch).contacts());
        } catch {
          setContacts(null);
        }
      }
    })();
  }, []);

  if (!draft) return <p>Loading…</p>;

  const set = (path: string, v: unknown): void => {
    const next = setPath(draft, path, v);
    setDraft(next);
    setRaw(JSON.stringify(next, null, 2));
    setSaved(null);
  };

  const storeSecret = async (ref: string, value: string): Promise<void> => {
    const next = { ...secrets, [ref]: value };
    await chrome.storage.local.set({ secrets: next });
    setSecrets(Object.fromEntries(Object.keys(next).map((k) => [k, 'set'])));
  };

  const save = async (d: Draft = draft): Promise<void> => {
    setErrors([]);
    const pre = parseConfig(d);
    if (!pre.ok) {
      setErrors(pre.errors);
      return;
    }
    const primaryUrl = getPath(d, 'provider.baseUrl') as string;
    if (pre.config.vision.enableVision && !(await requestHost(primaryUrl))) {
      setErrors(['Permission to reach the Vision provider was not granted.']);
      return;
    }
    const r = await sw<{ ok: boolean; errors: string[]; hint?: string | null }>({ type: 'save-config', config: d });
    if (!r.ok) setErrors([...r.errors, ...(r.hint ? [r.hint] : [])]);
    else setSaved(`Saved at ${new Date().toLocaleTimeString()}`);
  };

  const channels = (getPath(draft, 'alerts.channels') as string[]) ?? [];
  const onChannel = (channel: 'telegram' | 'email', on: boolean, ack = false): void => {
    const r = toggleChannel(draft, channel, on, ack);
    if (r.refused) setErrors([r.refused]);
    else if (r.needsAck) setPendingAck({ channel, on });
    else {
      setDraft(r.draft);
      setRaw(JSON.stringify(r.draft, null, 2));
    }
  };

  const chain = (getPath(draft, 'failoverChain') as ProviderId[]) ?? [];
  const primaryId = getPath(draft, 'provider.id') as ProviderId;
  const profiles = (getPath(draft, 'providerProfiles') as Record<string, unknown>) ?? {};
  const rules = (getPath(draft, 'rules') as string[]) ?? [];
  const contactsCfg = (getPath(draft, 'contacts') as Record<string, { roles: string[] }>) ?? {};
  const routing = (getPath(draft, 'routing') as Record<string, string[]>) ?? {};
  const allRecipes = [...BUILTIN_RECIPES, ...imported];

  const addProfile = (id: ProviderId): void => {
    set(`providerProfiles.${id}`, { baseUrl: DEFAULT_BASE_URLS[id], model: DEFAULT_MODELS[id], apiKeyRef: id === 'local' ? null : `key_${id}`, timeoutMs: 20000 });
  };

  return (
    <div>
      <h1>Survey Anything settings</h1>
      {pendingAck && (
        <div class="warn">
          <p>
            <strong>Alerts will not be redundant.</strong> With one channel, an outage of that channel delays every alert until the outbox can deliver it. Continue?
          </p>
          <button
            class="primary"
            onClick={() => {
              onChannel(pendingAck.channel, pendingAck.on, true);
              setPendingAck(null);
            }}
          >
            I understand, use one channel
          </button>{' '}
          <button onClick={() => setPendingAck(null)}>Keep both</button>
        </div>
      )}

      <h2>AI providers</h2>
      <p class="muted">The Vision provider must read back a code from a 256 px test image before it can be saved. Keys stay in this browser unless proxy mode is on (recommended with a backend).</p>
      <label>
        Vision provider{' '}
        <select value={primaryId} onChange={(e) => {
          const id = (e.target as HTMLSelectElement).value as ProviderId;
          set('provider', { id, baseUrl: DEFAULT_BASE_URLS[id], model: DEFAULT_MODELS[id], apiKeyRef: id === 'local' ? null : `key_${id}`, timeoutMs: 20000 });
        }}>
          {PROVIDER_IDS.map((id) => (
            <option value={id} key={id}>{id}</option>
          ))}
        </select>
      </label>
      <ProviderCard id={primaryId} path="provider" draft={draft} set={set} secrets={secrets} onSecret={(r, v) => void storeSecret(r, v)} primary />
      {Object.keys(profiles).filter((id) => id !== primaryId).map((id) => (
        <ProviderCard
          key={id}
          id={id as ProviderId}
          path={`providerProfiles.${id}`}
          draft={draft}
          set={set}
          secrets={secrets}
          onSecret={(r, v) => void storeSecret(r, v)}
          primary={false}
          onRemove={() => {
            set('providerProfiles', omit(profiles, id));
            set('failoverChain', chain.filter((c) => c !== id));
          }}
        />
      ))}
      <div class="row">
        Add profile:
        {PROVIDER_IDS.filter((id) => id !== primaryId && !(id in profiles)).map((id) => (
          <button key={id} onClick={() => addProfile(id)}>{id}</button>
        ))}
      </div>
      <h3>Failover chain</h3>
      <table>
        <tbody>
          {chain.map((id, i) => (
            <tr key={id}>
              <td>{i + 1}. {id}</td>
              <td>
                <button onClick={() => set('failoverChain', moveInList(chain, i, -1))}>↑</button>{' '}
                <button onClick={() => set('failoverChain', moveInList(chain, i, 1))}>↓</button>{' '}
                <button onClick={() => set('failoverChain', chain.filter((c) => c !== id))}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="row">
        {[primaryId, ...Object.keys(profiles)].filter((id, i, a) => a.indexOf(id) === i && !chain.includes(id as ProviderId)).map((id) => (
          <button key={id} onClick={() => set('failoverChain', [...chain, id])}>Add {id} to chain</button>
        ))}
      </div>
      <h3>Reasoner (text only, proposes actions for approval)</h3>
      <BoolField label="Enabled" path="reasoner.enabled" draft={draft} set={set} />
      <label>
        Provider{' '}
        <select value={(getPath(draft, 'reasoner.providerId') as string) ?? ''} onChange={(e) => set('reasoner.providerId', (e.target as HTMLSelectElement).value || null)}>
          <option value="">(none)</option>
          {PROVIDER_IDS.map((id) => (
            <option value={id} key={id}>{id}</option>
          ))}
        </select>
      </label>
      <TextField label="Model" path="reasoner.model" draft={draft} set={set} nullable />

      <h2>Privacy and egress</h2>
      <BoolField label="Allow cloud AI providers" path="allowCloudProviders" draft={draft} set={set} hint="Off: only loopback or private-network model hosts can receive frames." />
      <br />
      <BoolField label="Proxy mode (provider keys stay on the backend)" path="proxyMode" draft={draft} set={set} />
      <br />
      <BoolField label="Alert media: snapshots and 10 s clips may leave this machine" path="egress.alertMedia" draft={draft} set={set} />
      <br />
      <BoolField label="Live view: private stream to alerted contacts" path="egress.liveView" draft={draft} set={set} />

      <h2>Vision and token savers</h2>
      <BoolField label="Confirm candidates with AI" path="vision.enableVision" draft={draft} set={set} hint="Off: gate-only, zero API cost, alerts labelled unconfirmed." />
      <NumberField label="Scan interval (ms)" path="vision.scanIntervalMs" draft={draft} set={set} hint="Floor 2000 with a cloud provider, 500 fully local." />
      <NumberField label="Minimum on-device confidence" path="vision.minYoloConfidence" draft={draft} set={set} step={0.05} />
      <NumberField label="Cooldown per event (ms)" path="vision.cooldownPerEventMs" draft={draft} set={set} />
      <BoolField label="Rising edge only (one alert per event, not per frame)" path="vision.risingEdgeOnly" draft={draft} set={set} />
      <NumberField label="Downscale to max (px)" path="vision.downscaleMaxPx" draft={draft} set={set} />
      <NumberField label="JPEG quality" path="vision.jpegQuality" draft={draft} set={set} step={0.05} />
      <NumberField label="Max output tokens" path="vision.maxOutputTokens" draft={draft} set={set} />
      <NumberField label="Gate: hits needed" path="gate.minHits" draft={draft} set={set} />
      <NumberField label="Gate: out of last N frames" path="gate.windowFrames" draft={draft} set={set} />

      <h2>Budget</h2>
      <NumberField label="Max AI calls per minute" path="budget.maxCallsPerMinute" draft={draft} set={set} />
      <NumberField label="Max AI calls per day" path="budget.dailyMaxApiCalls" draft={draft} set={set} />
      <NumberField label="Max tokens per day" path="budget.dailyTokenCap" draft={draft} set={set} />
      <BoolField label="Hard stop on budget" path="budget.hardStopOnBudget" draft={draft} set={set} locked />

      <h2>Live stream and clips</h2>
      <NumberField label="Link lifetime (minutes, max 10)" path="stream.ttlMinutes" draft={draft} set={set} />
      <BoolField label="Single-use links" path="stream.singleUse" draft={draft} set={set} locked />
      <br />
      <BoolField label="Only alerted contacts may view" path="stream.viewerAllowlistOnly" draft={draft} set={set} locked />
      <NumberField label="Clip length (s)" path="clip.seconds" draft={draft} set={set} />
      <NumberField label="Clip bitrate (bit/s)" path="clip.videoBitsPerSecond" draft={draft} set={set} />

      <h2>Alert channels</h2>
      <p class="muted">Every alert goes to every selected channel at the same time. Two channels are redundant; one is allowed after an acknowledgement.</p>
      <label class="inline">
        <input type="checkbox" checked={channels.includes('telegram')} onChange={(e) => onChannel('telegram', (e.target as HTMLInputElement).checked)} /> Telegram
      </label>
      <label class="inline">
        <input type="checkbox" checked={channels.includes('email')} onChange={(e) => onChannel('email', (e.target as HTMLInputElement).checked)} /> Email
      </label>
      <label>
        Email transport{' '}
        <select value={getPath(draft, 'alerts.email.transport') as string} onChange={(e) => set('alerts.email.transport', (e.target as HTMLSelectElement).value)}>
          <option value="smtp-backend">SMTP from the backend (T1+)</option>
          <option value="http-direct">HTTP mail API from this browser (T0)</option>
        </select>
      </label>
      <BoolField label="Include snapshot in email" path="alerts.email.includeSnapshot" draft={draft} set={set} />
      <NumberField label="Re-send if not acknowledged within (s)" path="alerts.ackTimeoutSec" draft={draft} set={set} />

      <h2>Contacts and routing</h2>
      <p class="muted">Telegram IDs, email addresses and PINs live on the backend; this browser keeps only contact names and roles.</p>
      <table>
        <thead>
          <tr><th>Contact</th><th>Roles</th><th>Backend status</th><th /></tr>
        </thead>
        <tbody>
          {Object.entries(contactsCfg).map(([id, c]) => {
            const st = contacts?.find((x) => x.contactId === id);
            return (
              <tr key={id}>
                <td>{id}</td>
                <td>
                  {(['viewer', 'approver'] as const).map((role) => (
                    <label class="inline" key={role}>
                      <input type="checkbox" checked={c.roles.includes(role)} onChange={(e) => {
                        const on = (e.target as HTMLInputElement).checked;
                        set(`contacts.${id}.roles`, on ? [...new Set([...c.roles, role])] : c.roles.filter((r) => r !== role));
                      }} /> {role}
                    </label>
                  ))}
                </td>
                <td class="muted">
                  {st ? `Telegram ${st.telegramPaired ? '✓' : '✗'} · email ${st.emailSet ? '✓' : '✗'} · PIN ${st.pinSet ? '✓' : '✗'} · last test: tg ${st.lastTestOk.telegram ?? 'never'}, email ${st.lastTestOk.email ?? 'never'}` : device ? 'not invited' : 'pair a backend to invite'}
                </td>
                <td>
                  {device && (
                    <>
                      <button onClick={() => void (async () => {
                        const { BackendClient } = await import('../sw/backend-client');
                        const { guardedFetch } = await import('../sw/runtime');
                        const email = prompt(`Email for ${id} (optional)`) ?? null;
                        const token = (await chrome.storage.local.get('secrets')) as { secrets?: Secrets };
                        const b = new BackendClient(device.backendUrl, token.secrets?.['key_device_token'] ?? '', guardedFetch);
                        const r = await b.inviteContact({ contactId: id, roles: c.roles as ('viewer' | 'approver')[], email: email || null, channels: channels as ('telegram' | 'email')[] });
                        setInvite(`Send these to ${id} out of band:\nTelegram: ${r.telegramLink ?? '(bot not configured)'}\nPIN setup: ${r.pinSetupLink}`);
                      })().catch((e: unknown) => setErrors([e instanceof Error ? e.message : String(e)]))}>Invite</button>{' '}
                      <button onClick={() => void sw<Record<string, { ok: boolean; error: string | null }>>({ type: 'send-test-alert', contactId: id }).then((r) => setInvite(`Test to ${id}: ${Object.entries(r).map(([ch, v]) => `${ch} ${v.ok ? 'OK' : `failed (${v.error})`}`).join(', ')}`)).catch((e: unknown) => setErrors([String(e)]))}>Send test alert</button>
                    </>
                  )}
                  {id !== 'owner' && <button onClick={() => set('contacts', omit(contactsCfg, id))}>Remove</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {invite && <pre class="card">{invite}</pre>}
      <button onClick={() => {
        const id = prompt('New contact id (letters, digits, _ or -)');
        if (id) set(`contacts.${id}`, { roles: ['viewer'] });
      }}>Add contact</button>
      <h3>Routing</h3>
      <table>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule}>
              <td>{rule}</td>
              <td>
                {Object.keys(contactsCfg).map((cid) => (
                  <label class="inline" key={cid}>
                    <input type="checkbox" checked={(routing[rule] ?? []).includes(cid)} onChange={(e) => {
                      const on = (e.target as HTMLInputElement).checked;
                      const cur = routing[rule] ?? [];
                      const next = on ? [...cur, cid] : cur.filter((x) => x !== cid);
                      set('routing', next.length ? { ...routing, [rule]: next } : omit(routing, rule));
                    }} /> {cid}
                  </label>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Watch rules</h2>
      {allRecipes.map((r) => (
        <label class="inline" key={r.id} title={r.confirm.prompt}>
          <input type="checkbox" checked={rules.includes(r.id)} onChange={(e) => {
            const on = (e.target as HTMLInputElement).checked;
            set('rules', on ? [...rules, r.id] : rules.filter((x) => x !== r.id));
            if (!on) set('routing', omit(routing, r.id));
          }} /> {r.title} <span class="muted">({r.gate.type}, {r.severity})</span>
        </label>
      ))}
      <div class="card">
        <strong>Import a recipe</strong> <span class="muted">Recipes are data only and cannot change routing, egress or actions.</span>
        <input type="file" accept=".json,application/json" onChange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (!f) return;
          void f.text().then(async (t) => {
            try {
              const r = importRecipe(t);
              const next = [...imported.filter((x) => x.id !== r.id), r];
              await chrome.storage.local.set({ importedRecipes: next });
              setImported(next);
            } catch (err) {
              setErrors([err instanceof Error ? err.message : String(err)]);
            }
          });
        }} />
      </div>

      <h2>Human-approved actions (MCP)</h2>
      <BoolField label="Enabled" path="mcp.enabled" draft={draft} set={set} hint="Requires Telegram and an approver. Email never approves." />
      <br />
      <BoolField label="Require a Telegram tap to approve" path="mcp.requireSecondChannelApproval" draft={draft} set={set} locked />
      <NumberField label="Approval timeout (s), then deny" path="mcp.approvalTimeoutSec" draft={draft} set={set} />

      <h2>Extension-only mode (T0)</h2>
      <p class="muted">Without a backend, alerts go straight from this browser. Telegram via your bot token; email via the Resend HTTP API. No acknowledge or live view in this mode.</p>
      <BoolField label="Direct Telegram" path="direct.telegram" draft={{ direct: { telegram: getPath(draft, 'direct.telegram') !== null && getPath(draft, 'direct.telegram') !== undefined } }} set={(_p, on) => set('direct.telegram', on ? { botTokenRef: 'key_telegram_bot', chatIds: {} } : null)} />
      {getPath(draft, 'direct.telegram') ? (
        <div class="card">
          <SecretField label="Bot token" refName="key_telegram_bot" secrets={secrets} onSet={(r, v) => void (async () => {
            await requestHost('https://api.telegram.org');
            await storeSecret(r, v);
          })()} />
          {Object.keys(contactsCfg).map((cid) => (
            <TextField key={cid} label={`Chat ID for ${cid}`} path={`direct.telegram.chatIds.${cid}`} draft={draft} set={set} size={16} />
          ))}
          <p class="muted">Ask each contact to send /start to your bot in a private chat, then use the chat IDs shown by the Bot API getUpdates call. Group chats are not supported.</p>
        </div>
      ) : null}
      <BoolField label="Direct email (Resend)" path="direct.email" draft={{ direct: { email: Boolean(getPath(draft, 'direct.email')) } }} set={(_p, on) => set('direct.email', on ? { provider: 'resend', apiKeyRef: 'key_resend', from: 'alerts@example.org', addresses: {} } : null)} />
      {getPath(draft, 'direct.email') ? (
        <div class="card">
          <SecretField label="Resend API key" refName="key_resend" secrets={secrets} onSet={(r, v) => void (async () => {
            await requestHost('https://api.resend.com');
            await storeSecret(r, v);
          })()} />
          <TextField label="From address (a domain verified in Resend)" path="direct.email.from" draft={draft} set={set} />
          {Object.keys(contactsCfg).map((cid) => (
            <TextField key={cid} label={`Email for ${cid}`} path={`direct.email.addresses.${cid}`} draft={draft} set={set} />
          ))}
        </div>
      ) : null}

      <h2>Backend</h2>
      {device ? (
        <p>
          Paired as <code>{device.deviceId}</code> with <code>{device.backendUrl}</code>.{' '}
          <button onClick={() => void chrome.storage.local.remove('device').then(() => setDevice(null))}>Unpair</button>
        </p>
      ) : (
        <p>
          Not paired. <a href={chrome.runtime.getURL('src/onboarding/pair-backend/index.html')} target="_blank" rel="noreferrer">Pair a backend</a> for acknowledgements, routing, SMTP email, clips, live view and the dead-man alert.
        </p>
      )}

      <h2>Import, export and raw JSON</h2>
      <div class="row">
        <button onClick={() => {
          const r = parseConfig(draft);
          if (!r.ok) {
            setErrors(r.errors);
            return;
          }
          const blob = new Blob([exportConfig(r.config)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'survey-anything-config.json';
          a.click();
        }}>Export (never includes keys)</button>
        <input type="file" accept=".json,application/json" onChange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (!f) return;
          void f.text().then((t) => {
            const r = importConfigJson(t);
            if (!r.ok) setErrors(r.errors);
            else {
              setDraft(r.raw);
              setRaw(JSON.stringify(r.raw, null, 2));
              setSaved('Imported. Press Save: the Vision provider is probed again.');
            }
          });
        }} />
      </div>
      <details>
        <summary>Edit every key as JSON</summary>
        <textarea rows={24} value={raw} onInput={(e) => setRaw((e.target as HTMLTextAreaElement).value)} />
        <button onClick={() => {
          const r = importConfigJson(raw);
          if (!r.ok) setErrors(r.errors);
          else setDraft(r.raw);
        }}>Apply JSON</button>
      </details>

      <div class="card" style="position:sticky;bottom:0">
        <button class="primary" onClick={() => void save()}>Save</button> {saved && <span class="ok">{saved}</span>}
        {errors.length > 0 && <div class="error">{errors.join('\n')}</div>}
      </div>
    </div>
  );
}

const root = document.getElementById('app');
if (root) render(<Options />, root);
