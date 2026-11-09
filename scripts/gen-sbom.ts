#!/usr/bin/env node
/**
 * M8: writes release/sbom.cdx.json, a CycloneDX 1.5 SBOM of what a release ships and runs: every production
 * npm package (from pnpm's own data), the files bundled in the extension (models and WASM, with SHA-256),
 * and the container images the deploy stack pins by digest. Deterministic for a given commit (serial number
 * and timestamp come from the commit). Run: pnpm sbom.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedImages } from './gen-image-digests.ts';

interface PnpmLicenseEntry {
  name: string;
  versions: string[];
  license: string;
}

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function uuidFrom(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function npmComponents(byLicense: Record<string, PnpmLicenseEntry[]>) {
  return Object.entries(byLicense)
    .flatMap(([license, pkgs]) =>
      pkgs.flatMap((p) =>
        p.versions.map((v) => ({
          type: 'library',
          'bom-ref': `pkg:npm/${p.name}@${v}`,
          name: p.name,
          version: v,
          purl: `pkg:npm/${p.name.startsWith('@') ? `%40${p.name.slice(1)}` : p.name}@${v}`,
          licenses: [/^[A-Za-z0-9.+-]+$/.test(license) ? { license: { id: license } } : { expression: license }],
        })),
      ),
    )
    .sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
}

function main(): void {
  const commit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  const when = new Date(Number(execSync('git log -1 --format=%ct', { cwd: root, encoding: 'utf8' }).trim()) * 1000).toISOString();
  const version = (JSON.parse(readFileSync(join(root, 'apps', 'extension', 'package.json'), 'utf8')) as { version: string }).version;
  const byLicense = JSON.parse(execSync('pnpm licenses list --json --prod --recursive', { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) || '{}') as Record<string, PnpmLicenseEntry[]>;
  const bundled = (JSON.parse(readFileSync(join(root, 'models', 'checksums.json'), 'utf8')) as { files: { name: string; path: string; license: string; sha256: string; source: string }[] }).files;
  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${uuidFrom(commit)}`,
    version: 1,
    metadata: {
      timestamp: when,
      tools: { components: [{ type: 'application', name: 'scripts/gen-sbom.ts', version: commit.slice(0, 12) }] },
      component: { type: 'application', 'bom-ref': 'survey-anything', name: 'survey-anything', version, licenses: [{ license: { id: 'AGPL-3.0-only' } }], purl: `pkg:github/PacifAIst/survany@${commit}` },
    },
    components: [
      ...bundled.map((f) => ({
        type: f.name.endsWith('.onnx') ? 'machine-learning-model' : 'file',
        'bom-ref': `bundled:${f.path}`,
        name: f.name,
        hashes: [{ alg: 'SHA-256', content: f.sha256 }],
        licenses: [{ license: { id: f.license } }],
        externalReferences: f.source.startsWith('http') ? [{ type: 'distribution', url: f.source }] : [],
        properties: [{ name: 'survey-anything:path-in-extension', value: f.path }, { name: 'survey-anything:source', value: f.source }],
      })),
      ...npmComponents(byLicense),
      ...pinnedImages(root).map((i) => ({
        type: 'container',
        'bom-ref': `image:${i.image}`,
        name: i.image.split('@')[0],
        version: i.image.split('@')[1] ?? 'unpinned',
        properties: [{ name: 'survey-anything:used-by', value: i.usedBy.join(', ') }],
      })),
    ],
  };
  mkdirSync(join(root, 'release'), { recursive: true });
  writeFileSync(join(root, 'release', 'sbom.cdx.json'), JSON.stringify(bom, null, 2) + '\n');
  console.info(`release/sbom.cdx.json: ${bom.components.length} components (commit ${commit.slice(0, 12)})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
