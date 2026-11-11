// Copyright (C) 2026 PacifAIst
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Watch rules in the Options page: turn rules on and off, open any rule to see its JSON, copy it in one
 * click or start a new rule from it, and add a rule typed or pasted into the editor (validated exactly like
 * an imported file, SG-18).
 */
import { useState } from 'preact/hooks';
import { BUILTIN_RECIPES, importRecipe, type Recipe } from '@survey-anything/recipes';
import { checkNewRecipe, recipeTemplate } from './model';

const BUILTIN_IDS = BUILTIN_RECIPES.map((r) => r.id);

export function RecipeLibrary(p: {
  recipes: Recipe[];
  imported: Recipe[];
  enabled: string[];
  onToggle: (id: string, on: boolean) => void;
  onImported: (next: Recipe[]) => Promise<void>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null);

  const add = async (text: string, source: string): Promise<void> => {
    const r = checkNewRecipe(text, BUILTIN_IDS, importRecipe);
    if (!r.ok) {
      setResult({ ok: false, lines: [`${source}: not added`, ...r.errors] });
      return;
    }
    await p.onImported([...p.imported.filter((x) => x.id !== r.recipe.id), r.recipe]);
    setResult({ ok: true, lines: [`Added "${r.recipe.title}" (${r.recipe.id}). Tick it above to use it, then Save.`] });
    if (source === 'Editor') setDraft('');
  };

  const copy = async (r: Recipe): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
      setCopied(r.id);
    } catch {
      setCopied(null);
      setResult({ ok: false, lines: ['The browser refused clipboard access; select the JSON and copy it by hand.'] });
    }
  };

  return (
    <div data-testid="recipes">
      <p class="muted">Click a rule's name to see how it is written. Copy it, or use it as a template for your own.</p>
      {p.recipes.map((r) => {
        const isImported = p.imported.some((x) => x.id === r.id);
        const isOpen = open === r.id;
        return (
          <div key={r.id} class="recipe" data-recipe={r.id}>
            <label class="inline">
              <input type="checkbox" aria-label={r.title} checked={p.enabled.includes(r.id)} onChange={(e) => p.onToggle(r.id, (e.target as HTMLInputElement).checked)} />
            </label>
            <button class="link" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
              <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> {r.title}
            </button>{' '}
            <span class="muted">({r.gate.type}, {r.severity}{isImported ? ', yours' : ''})</span>
            {isImported && (
              <button aria-label={`Remove rule: ${r.title}`} onClick={() => void p.onImported(p.imported.filter((x) => x.id !== r.id))}>
                Remove
              </button>
            )}
            {isOpen && (
              <div class="card">
                {r.description && <p>{r.description}</p>}
                <pre data-testid={`recipe-json-${r.id}`}>{JSON.stringify(r, null, 2)}</pre>
                <div class="row">
                  <button onClick={() => void copy(r)}>{copied === r.id ? 'Copied' : 'Copy JSON'}</button>
                  <button
                    onClick={() => {
                      setDraft(recipeTemplate(r as unknown as { id: string; title: string } & Record<string, unknown>, p.recipes.map((x) => x.id)));
                      setResult(null);
                    }}
                  >
                    Use as template
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div class="card">
        <strong>Add your own rule</strong> <span class="muted">Rules are data only: they cannot change who is alerted, what leaves this computer, or which actions exist.</span>
        <textarea aria-label="New rule JSON" rows={14} placeholder='Paste a rule here, or open a rule above and press "Use as template".' value={draft} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} />
        <div class="row">
          <button class="primary" onClick={() => void add(draft, 'Editor')}>Add rule</button>
          <label>
            or import a file{' '}
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Import a rule file"
              onChange={(e) => {
                const input = e.target as HTMLInputElement;
                const f = input.files?.[0];
                if (!f) return;
                void f.text().then(async (t) => {
                  await add(t, f.name);
                  input.value = '';
                });
              }}
            />
          </label>
        </div>
        {result && (
          <ul class={result.ok ? 'ok' : 'error'} data-testid="recipe-result" role="status">
            {result.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
        <details>
          <summary>Field guide</summary>
          <ul>
            <li><code>id</code>: lowercase letters, digits and dashes, up to 48. <code>title</code>: up to 80 characters. <code>description</code>: optional, up to 300.</li>
            <li><code>gate</code>: what runs on this computer on every frame, for free. One of:
              <ul>
                <li><code>{'{"type":"detector","model":"yolox-tiny-coco","classes":["person"],"minConfidence":0.6}'}</code>: objects the COCO detector knows (person, car, dog, …); optional <code>region</code>, <code>minCount</code>, <code>requireClasses</code>, <code>requireMotion</code>. Model <code>fire-smoke-yolox-tiny</code> has classes <code>fire</code> and <code>smoke</code>.</li>
                <li><code>{'{"type":"motion","pixelDelta":25,"threshold":0.05}'}</code>: share of pixels that changed between scans; optional <code>region</code>.</li>
                <li><code>{'{"type":"region-diff","region":{…},"mode":"any-change","threshold":0.2}'}</code>: a region differs from the frame at arm time; <code>"mode":"color-shift"</code> with <code>targetColor</code> (red, green, blue, yellow, orange) for dashboards.</li>
                <li><code>{'{"type":"sampled","everyMinutes":10}'}</code>: no visual trigger; ask the model on a timer, under the budget.</li>
              </ul>
            </li>
            <li><code>region</code>: fractions of the frame, <code>{'{"x":0.5,"y":0,"w":0.5,"h":1}'}</code> is the right half. The model is shown this area outlined with a dashed rectangle.</li>
            <li><code>confirm.prompt</code>: a yes/no question about the scene (10–600 characters). Questions about who someone is, faces or emotions are refused. <code>confirm.framesPerCheck</code>: 1–4 (more frames make a montage, for intent).</li>
            <li><code>severity</code>: <code>info</code>, <code>warning</code> or <code>critical</code>.</li>
          </ul>
        </details>
      </div>
    </div>
  );
}
