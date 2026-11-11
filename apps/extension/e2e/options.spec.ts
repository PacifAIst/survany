// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M3: walks the whole Options page in a real browser, against local model servers:
 *  - per-provider Test Connection runs the C26 vision probe (a model that reads the code passes; a
 *    text-only model that cannot see the image fails, showing what it read), without saving the draft;
 *  - a local server entered without /v1 (as LM Studio shows it) is called under /v1;
 *  - a missing API key is named instead of sending a request the provider would answer with 401, and a
 *    key typed into the field is stored when the field is left, without pressing Store;
 *  - API keys are stored without clobbering each other or the backend device token;
 *  - failover chain editor: add, reorder with the move buttons, remove;
 *  - the one-time "not redundant" acknowledgement when one alert channel remains (asked once);
 *  - Save runs the probe; budget usage and the hard-stop banner are shown;
 *  - export never contains keys and re-imports; import refuses zero channels and embedded keys, and
 *    asks for the acknowledgement for a single-channel file;
 *  - mcp.enabled without Telegram is refused at save;
 *  - watch rules: open a rule to see its JSON, copy it in one click, use it as a template, add a rule
 *    typed into the editor (a built-in id is refused), and remove it again.
 * Needs `pnpm build:e2e` (loopback hosts pre-granted, see manifest.config.ts).
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { parseConfig } from '@survey-anything/shared';
import { acceptConsentAndCamera, DIST_E2E, type Harness, launch } from './harness';
import { type ModelMock, startModelMock } from './model-mock';

let h: Harness;
let vision: ModelMock;
let textOnly: Server;
let textOnlyUrl = '';
const textOnlyCalls: string[] = [];

test.beforeAll(async () => {
  vision = await startModelMock({ confirm: () => '{"event":"none","confidence":0.1,"reason":"nothing"}', reason: () => '{"tool":"none"}' });
  // A text-only model: it answers, but cannot see the image, so it guesses a code.
  textOnly = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      textOnlyCalls.push(req.url ?? '');
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('content-type', 'application/json');
      // The ids it serves, which the page lists when the probe fails with a model id it does not serve.
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'qwen3-vl-4b-instruct' }, { id: 'text-embed' }] }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: '{"code":"ACDEFH"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>((r) => textOnly.listen(0, '127.0.0.1', r));
  textOnlyUrl = `http://127.0.0.1:${(textOnly.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await h?.close();
  await vision?.close();
  await new Promise<void>((r) => textOnly.close(() => r()));
});

const card = (page: Page, id: string): Locator => page.locator('div.card', { has: page.locator('strong', { hasText: new RegExp(`^${id}$`) }) });
const storage = async <T,>(page: Page, key: string): Promise<T> => page.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key) as Promise<T>;
const chainOrder = async (page: Page): Promise<string[]> => page.locator('[data-testid=chain] li').evaluateAll((els) => els.map((e) => e.getAttribute('data-provider') ?? ''));
/** Polls the JSON view (it mirrors the draft after render) until it shows `want`. */
const expectChannels = async (page: Page, want: string[]): Promise<void> => {
  await expect.poll(async () => (JSON.parse(await page.getByLabel('Configuration JSON').inputValue()) as { alerts: { channels: string[] } }).alerts.channels).toEqual(want);
};

test('M3: the whole Options page, end to end', async () => {
  h = await launch({ dist: DIST_E2E });
  await acceptConsentAndCamera(h);
  // A paired backend's token is already stored; the page must never overwrite it.
  await h.page.evaluate(async () => chrome.storage.local.set({ secrets: { key_device_token: 'device_token_test_not_real' } }));

  const page = await h.context.newPage();
  await page.goto(`chrome-extension://${h.extId}/src/options/index.html`);
  await expect(page.getByRole('heading', { name: 'Survey Anything settings' })).toBeVisible();
  await page.locator('details', { hasText: 'Edit every key as JSON' }).evaluate((d) => ((d as HTMLDetailsElement).open = true));

  // --- Vision provider: local model that can read the probe -----------------------------------
  const local = card(page, 'local');
  // One click fills the usual local server addresses and asks the server for its vision model. Whatever runs
  // on this machine's 1234 and 11434, wait for each answer before going on.
  const detected = page.getByTestId('detect-local');
  await local.getByRole('button', { name: /^LM Studio/ }).click();
  await expect(local.getByLabel('Base URL')).toHaveValue('http://127.0.0.1:1234/v1');
  await expect(detected).toContainText(/nothing answered at http:\/\/127\.0\.0\.1:1234\/v1|Model set to|LM Studio is running/);
  await local.getByRole('button', { name: /^Ollama/ }).click();
  await expect(local.getByLabel('Base URL')).toHaveValue('http://127.0.0.1:11434/v1');
  await expect(detected).toContainText(/nothing answered at http:\/\/127\.0\.0\.1:11434\/v1|This server has|lists no models/);
  // Nothing listening: the page names the address and the usual servers instead of "Failed to fetch".
  await local.getByLabel('Base URL').fill('http://127.0.0.1:9');
  await local.getByLabel('Model', { exact: true }).fill('mock-vision');
  await local.getByRole('button', { name: 'Test connection: local' }).click();
  await expect(page.getByTestId('probe-local')).toContainText('nothing answered at http://127.0.0.1:9/v1: is the server running?');
  await expect(page.getByTestId('probe-local')).toContainText('LM Studio: Developer tab → Start server; address http://127.0.0.1:1234');
  // Entered as LM Studio shows it, without /v1: the page says what it will use, and the call goes to /v1.
  await local.getByLabel('Base URL').fill(vision.url);
  await expect(local).toContainText(`this will use ${vision.url}/v1`);
  // "Find the vision model" reads LM Studio's model list and picks the loaded model that can see.
  await local.getByLabel('Model', { exact: true }).fill('qwen2.5vl');
  await local.getByRole('button', { name: 'Find the vision model on this server' }).click();
  await expect(detected).toContainText('Model set to mock-vision: it can see images and is loaded in LM Studio.');
  await expect(local.getByLabel('Model', { exact: true })).toHaveValue('mock-vision');
  // A wrong model name still passes on LM Studio (it answers with its loaded model): the page says so.
  await local.getByLabel('Model', { exact: true }).fill('qwen2.5vl');
  await local.getByRole('button', { name: 'Test connection: local' }).click();
  await expect(page.getByTestId('probe-local')).toContainText(/Vision OK: read the code back in \d+ ms.*Press Save at the bottom of the page to use it\./);
  await expect(page.getByTestId('served-model')).toContainText('The server answered with mock-vision, not "qwen2.5vl"');
  await page.getByTestId('served-model').getByRole('button', { name: 'Use mock-vision' }).click();
  await expect(local.getByLabel('Model', { exact: true })).toHaveValue('mock-vision');
  expect(vision.calls.filter((c) => c.kind === 'probe').map((c) => c.path)).toEqual(['/v1/chat/completions']);
  // Testing did not save anything.
  expect(await storage(page, 'config')).toBeUndefined();

  // --- A text-only model fails the probe and the page shows what it read ----------------------
  await page.getByRole('button', { name: 'openai', exact: true }).click();
  const openai = card(page, 'openai');
  await openai.getByLabel('Base URL').fill(`${textOnlyUrl}/v1`);
  await openai.getByLabel('Model', { exact: true }).fill('text-only-model');
  await openai.getByPlaceholder('paste key').fill('test_openai_key_not_real');
  await openai.getByRole('button', { name: 'Store' }).click();
  await expect(openai.getByText('(key_openai: set)')).toBeVisible();
  await openai.getByRole('button', { name: 'Test connection: openai' }).click();
  await expect(page.getByTestId('probe-openai')).toContainText(/Failed: .*read ACDEFH/);
  // A misread earns one fresh code; a model that cannot see fails both. Then the page asks which models the server has.
  expect(textOnlyCalls).toEqual(['/v1/chat/completions', '/v1/chat/completions', '/v1/models']);
  await expect(page.getByTestId('probe-openai')).toContainText('This server serves: qwen3-vl-4b-instruct, text-embed. Copy one of these ids into Model exactly.');

  // --- A second key does not clobber the first or the device token ----------------------------
  await page.getByRole('button', { name: 'openrouter', exact: true }).click();
  const openrouter = card(page, 'openrouter');
  // No key yet: the test names what is missing and sends nothing.
  await openrouter.getByLabel('Base URL').fill(`${textOnlyUrl}/v1`);
  await openrouter.getByLabel('Model', { exact: true }).fill('text-only-model');
  await openrouter.getByRole('button', { name: 'Test connection: openrouter' }).click();
  await expect(page.getByTestId('probe-openrouter')).toContainText('no API key is stored under key_openrouter');
  expect(textOnlyCalls).toHaveLength(3);
  // Typed and left (Tab), not stored with the button: it is saved anyway.
  await openrouter.getByPlaceholder('paste key').fill('test_openrouter_key_not_real');
  await openrouter.getByPlaceholder('paste key').press('Tab');
  await expect(openrouter.getByText('(key_openrouter: set)')).toBeVisible();
  expect(await storage(page, 'secrets')).toEqual({
    key_device_token: 'device_token_test_not_real',
    key_openai: 'test_openai_key_not_real',
    key_openrouter: 'test_openrouter_key_not_real',
  });

  // --- Failover chain: add, reorder, remove ---------------------------------------------------
  expect(await chainOrder(page)).toEqual(['local']);
  await page.getByRole('button', { name: 'Add openai to chain' }).click();
  await page.getByRole('button', { name: 'Add openrouter to chain' }).click();
  expect(await chainOrder(page)).toEqual(['local', 'openai', 'openrouter']);
  await expect(page.getByRole('button', { name: 'Move local up' })).toBeDisabled();
  await page.getByRole('button', { name: 'Move openrouter up' }).click();
  expect(await chainOrder(page)).toEqual(['local', 'openrouter', 'openai']);
  await page.getByRole('button', { name: 'Move local down' }).click();
  expect(await chainOrder(page)).toEqual(['openrouter', 'local', 'openai']);
  await page.getByRole('button', { name: 'Remove openrouter from chain' }).click();
  await page.getByRole('button', { name: 'Move openai up' }).click();
  expect(await chainOrder(page)).toEqual(['openai', 'local']);
  // The text-only model must not lead the chain; put local first again and drop openai.
  await page.getByRole('button', { name: 'Remove openai from chain' }).click();
  expect(await chainOrder(page)).toEqual(['local']);

  // --- One click, two updates: removing a profile also drops it from the chain; a rule its routing ----
  await page.getByRole('button', { name: 'Add openrouter to chain' }).click();
  await openrouter.getByRole('button', { name: 'Remove', exact: true }).click();
  const draftNow = async () => JSON.parse(await page.getByLabel('Configuration JSON').inputValue()) as { providerProfiles: Record<string, unknown>; failoverChain: string[]; rules: string[]; routing: Record<string, string[]> };
  // The JSON view mirrors the draft after render, so poll it.
  await expect.poll(async () => Object.keys((await draftNow()).providerProfiles)).toEqual(['openai']);
  await expect.poll(async () => (await draftNow()).failoverChain).toEqual(['local']);
  await page.getByRole('checkbox', { name: /^Fire or smoke/ }).uncheck();
  await expect.poll(async () => (await draftNow()).rules).toEqual(['other']);
  await expect.poll(async () => Object.keys((await draftNow()).routing)).toEqual(['other']);
  await page.getByRole('checkbox', { name: /^Fire or smoke/ }).check();
  await expect.poll(async () => (await draftNow()).rules).toEqual(['other', 'fire']);

  // --- Watch rules: see a rule's JSON, copy it, start a new rule from it ----------------------
  // Record what the page copies; the real clipboard write still runs (and must succeed for "Copied").
  await page.evaluate(() => {
    const w = window as unknown as { copied: string[] };
    w.copied = [];
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (t: string) => {
      w.copied.push(t);
      return real(t);
    };
  });
  const zoneTitle = page.getByRole('button', { name: 'Person in restricted zone', exact: true });
  await expect(zoneTitle).toHaveAttribute('aria-expanded', 'false');
  await zoneTitle.click();
  await expect(zoneTitle).toHaveAttribute('aria-expanded', 'true');
  const zoneJson = page.getByTestId('recipe-json-person-in-restricted-zone');
  await expect(zoneJson).toContainText('"region"');
  await expect(zoneJson).toContainText('outlined restricted area');
  const recipes = page.getByTestId('recipes');
  await recipes.getByRole('button', { name: 'Copy JSON' }).click();
  await expect(recipes.getByRole('button', { name: 'Copied' })).toBeVisible();
  const clip = (await page.evaluate(() => (window as unknown as { copied: string[] }).copied))[0] ?? '';
  expect(JSON.parse(clip)).toMatchObject({ id: 'person-in-restricted-zone', gate: { type: 'detector', region: { x: 0.5 } } });
  await recipes.getByRole('button', { name: 'Use as template' }).click();
  const editor = page.getByLabel('New rule JSON');
  await expect(editor).toHaveValue(/"id": "person-in-restricted-zone-custom"/);
  await expect(editor).toHaveValue(/"title": "Person in restricted zone \(custom\)"/);
  await recipes.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByTestId('recipe-result')).toContainText('Added "Person in restricted zone (custom)" (person-in-restricted-zone-custom)');
  await expect(editor).toHaveValue('');
  expect((await storage<{ id: string }[]>(page, 'importedRecipes')).map((r) => r.id)).toEqual(['person-in-restricted-zone-custom']);
  const custom = page.getByRole('checkbox', { name: 'Person in restricted zone (custom)', exact: true });
  await expect(custom).not.toBeChecked();
  await custom.check();
  await expect.poll(async () => (await draftNow()).rules).toEqual(['other', 'fire', 'person-in-restricted-zone-custom']);

  // A rule typed into the editor is validated like a file; a built-in id is refused.
  await editor.fill(clip);
  await recipes.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByTestId('recipe-result')).toContainText('is a built-in rule: choose another id');
  await editor.fill(JSON.stringify({ id: 'typed-rule', title: 'Typed rule', gate: { type: 'sampled', everyMinutes: 10 }, confirm: { prompt: 'Is anything unusual happening?' }, severity: 'catastrophic' }));
  await recipes.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByTestId('recipe-result')).toContainText('Editor: not added');
  await expect(page.getByTestId('recipe-result')).toContainText('severity');

  // Removing an added rule also takes it out of the draft's rules.
  await page.getByRole('button', { name: 'Remove rule: Person in restricted zone (custom)' }).click();
  await expect(custom).toHaveCount(0);
  expect(await storage<unknown[]>(page, 'importedRecipes')).toEqual([]);
  await expect.poll(async () => (await draftNow()).rules).toEqual(['other', 'fire']);

  // --- One-time "not redundant" acknowledgement ------------------------------------------------
  // The checkbox is controlled: it stays ticked until the acknowledgement is given, so click, not uncheck().
  const email = page.getByRole('checkbox', { name: 'Email', exact: true });
  await email.click();
  const ack = page.getByRole('alertdialog', { name: 'Alerts will not be redundant' });
  await expect(ack).toBeVisible();
  await expect(email).toBeChecked();
  await ack.getByRole('button', { name: 'Keep both' }).click();
  await expect(ack).toBeHidden();
  await expectChannels(page, ['telegram', 'email']);
  await email.click();
  await ack.getByRole('button', { name: 'I understand, use one channel' }).click();
  await expect(email).not.toBeChecked();
  await expectChannels(page, ['telegram']);
  await email.check();
  await expectChannels(page, ['telegram', 'email']);
  await email.uncheck();
  await expect(ack).toBeHidden(); // asked once only
  await expectChannels(page, ['telegram']);
  await email.check();

  // --- Save runs the probe; budget shows usage ------------------------------------------------
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('saved')).toContainText('Saved at');
  expect(vision.calls.filter((c) => c.kind === 'probe')).toHaveLength(2);
  await expect(page.getByTestId('budget')).toContainText(/Today \(UTC \d{4}-\d{2}-\d{2}\): 0 of 500 cloud AI calls/);
  await expect(page.getByTestId('budget').getByRole('alert')).toHaveCount(0);

  // Hard stop: today's calls at the limit.
  await page.evaluate(async () => {
    const day = new Date().toISOString().slice(0, 10);
    await chrome.storage.local.set({ budget: { day, dayCalls: 500, dayTokens: 1234, minute: [], noticeDay: day, freeDayCalls: 0 } });
  });
  await page.getByTestId('budget').getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByTestId('budget').getByRole('alert')).toContainText('Hard stop: the daily call limit is reached');
  await expect(page.getByTestId('budget')).toContainText('500 of 500 cloud AI calls, 1234 of 200000 tokens');

  // --- Export: no keys, and it validates ---------------------------------------------------
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export (never includes keys)' }).click()]);
  const exported = readFileSync((await download.path())!, 'utf8');
  expect(exported).not.toMatch(/not_real|device_token|secrets/);
  expect(parseConfig(JSON.parse(exported)).ok).toBe(true);

  // --- Import: refusals and the acknowledgement -----------------------------------------------
  const importInput = page.getByLabel('Import configuration');
  const base = JSON.parse(exported) as Record<string, unknown> & { alerts: Record<string, unknown> };
  const file = (name: string, obj: unknown) => ({ name, mimeType: 'application/json', buffer: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)) });

  await importInput.setInputFiles(file('zero-channels.json', { ...base, alerts: { ...base.alerts, channels: [] } }));
  await expect(page.getByTestId('import-status')).toContainText('zero-channels.json: refused, nothing changed.');
  await expect(page.getByTestId('errors')).toContainText('alerts.channels');
  await expectChannels(page, ['telegram', 'email']);

  await importInput.setInputFiles(file('with-key.json', JSON.stringify(base).replace('"schemaVersion":1', '"schemaVersion":1,"apiKey":"sk-ant-api03-notarealkeynotarealkeynotarealkey"')));
  await expect(page.getByTestId('import-status')).toContainText('with-key.json: refused');

  await importInput.setInputFiles(file('email-only.json', { ...base, alerts: { ...base.alerts, channels: ['email'], nonRedundantAck: false } }));
  await expect(ack).toBeVisible();
  await ack.getByRole('button', { name: 'I understand, use one channel' }).click();
  await expect(page.getByTestId('import-status')).toContainText('Loaded with one alert channel');
  await expectChannels(page, ['email']);

  // --- MCP without Telegram is refused at save --------------------------------------------------
  await page.locator('h2', { hasText: 'Human-approved actions (MCP)' }).locator('xpath=following-sibling::label[1]').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('errors')).toContainText('mcp.enabled requires telegram in alerts.channels');
  await expect(page.getByText('Pair a backend with a gate to see its tools.')).toBeVisible();

  // Saving a valid email-only config works and keeps the acknowledgement.
  await page.locator('h2', { hasText: 'Human-approved actions (MCP)' }).locator('xpath=following-sibling::label[1]').getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('saved')).toContainText('Saved at');
  const stored = await storage<{ alerts: { channels: string[]; nonRedundantAck: boolean } }>(page, 'config');
  expect(stored.alerts).toMatchObject({ channels: ['email'], nonRedundantAck: true });
});
