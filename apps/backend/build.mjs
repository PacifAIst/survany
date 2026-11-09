// Bundles the backend into dist/ with workspace packages inlined and npm dependencies external.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@survey-anything/'));

await build({
  entryPoints: ['src/server.ts', 'src/cli.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: [...external, 'node:*'],
  sourcemap: true,
  banner: { js: '// Survey Anything backend. AGPL-3.0-only. Source: https://github.com/PacifAIst/survany' },
  logLevel: 'info',
});

mkdirSync('dist', { recursive: true });
copyFileSync('src/db/schema.sql', 'dist/schema.sql');
