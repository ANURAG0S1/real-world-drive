// Bundles the TypeScript sim with esbuild (shipped with Vite) and runs it in Node.
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outfile = join(mkdtempSync(join(tmpdir(), 'rwd-')), 'physics.mjs');
await build({ entryPoints: ['tests/physics.sim.ts'], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' });
await import(pathToFileURL(outfile).href);
