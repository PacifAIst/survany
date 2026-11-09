import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';
import { buildManifest } from './manifest.config';

const root = __dirname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

/** Writes manifest.json and fails the build if a bundled model or WASM file does not match its pinned SHA-256 (SG-26). */
function extensionPlugin(): Plugin {
  return {
    name: 'survey-anything-extension',
    apply: 'build',
    closeBundle() {
      const out = join(root, 'dist');
      writeFileSync(join(out, 'manifest.json'), JSON.stringify(buildManifest({ version: pkg.version }), null, 2));
      const sums = JSON.parse(readFileSync(join(root, '..', '..', 'models', 'checksums.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
      for (const f of sums.files) {
        const p = join(out, f.path);
        if (!existsSync(p)) {
          if (process.env['SA_ALLOW_MISSING_ASSETS'] === '1') {
            this.warn(`bundled asset missing (allowed by SA_ALLOW_MISSING_ASSETS): ${f.path}`);
            continue;
          }
          throw new Error(`bundled asset missing: ${f.path}. Run: pnpm --filter @survey-anything/extension fetch-assets`);
        }
        const got = createHash('sha256').update(readFileSync(p)).digest('hex');
        if (got !== f.sha256) throw new Error(`SG-26: ${f.path} sha256 ${got} != pinned ${f.sha256}`);
      }
    },
  };
}

export default defineConfig({
  root,
  base: '/',
  publicDir: resolve(root, 'public'),
  plugins: [preact(), extensionPlugin()],
  // ORT's extern-WASM entry loads its glue and WASM only from ort.env.wasm.wasmPaths, i.e. the
  // checksummed files in public/ort (SG-26), instead of Vite emitting a second, unchecked copy.
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'production'] },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: false,
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        sw: resolve(root, 'src/sw/index.ts'),
        offscreen: resolve(root, 'src/offscreen/offscreen.html'),
        popup: resolve(root, 'src/popup/index.html'),
        options: resolve(root, 'src/options/index.html'),
        consent: resolve(root, 'src/onboarding/consent/index.html'),
        grantCamera: resolve(root, 'src/onboarding/grant-camera/index.html'),
        pairBackend: resolve(root, 'src/onboarding/pair-backend/index.html'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js' } },
  },
});
