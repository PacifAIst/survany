import { readFileSync } from 'node:fs';

/**
 * Resolved relative to the running module: src/db/schema.sql in development and tests,
 * dist/schema.sql in the bundled build (build.mjs copies it).
 */
export const SCHEMA_SQL: string = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
