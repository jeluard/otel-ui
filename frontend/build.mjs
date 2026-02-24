// ── esbuild build script ──────────────────────────────────────────────────────
// Usage:
//   node build.mjs          → production bundle → dist/
//   node build.mjs --dev    → dev server with live-reload on http://localhost:$FRONTEND_DEV_PORT (default 8080)
//   node build.mjs --watch  → watch mode, rebuild on change (no server)

import * as esbuild from 'esbuild';
import { cp, mkdir } from 'fs/promises';

const dev   = process.argv.includes('--dev');
const watch = process.argv.includes('--watch');

// ── Shared esbuild options ────────────────────────────────────────────────────
const BRIDGE_IMAGE = process.env.BRIDGE_IMAGE;
if (!BRIDGE_IMAGE) {
  console.error('Error: BRIDGE_IMAGE environment variable is required');
  process.exit(1);
}

const buildOptions = {
  entryPoints: ['src/main.tsx'],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'esm',
  outfile: 'dist/bundle.js',
  sourcemap: dev || watch,
  minify: !dev && !watch,
  // Support both .ts/.tsx extension imports
  resolveExtensions: ['.tsx', '.ts', '.js'],
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
  define: {
    '__BRIDGE_IMAGE__': JSON.stringify(BRIDGE_IMAGE),
  },
  jsx: 'automatic',
};

// ── Copy static assets to dist/ ───────────────────────────────────────────────
async function copyStatics() {
  await mkdir('dist', { recursive: true });
  await cp('public', 'dist', { recursive: true });
  await cp('index.html', 'dist/index.html');
}

// ── Dev mode: esbuild serve + watch ──────────────────────────────────────────
if (dev) {
  await copyStatics();

  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();

  const devPort = parseInt(process.env.FRONTEND_DEV_PORT ?? '8080', 10);
  const { host, port } = await ctx.serve({
    servedir: 'dist',
    port: devPort,
    host: '0.0.0.0',
  });

  const addr = `http://localhost:${port}`;
  console.log(`\n  ➜  UI:          ${addr}`);
  console.log(`     WS backend:  ws://localhost:8081/ws`);
  console.log(`\n  (override WS endpoint via URL hash: ${addr}#ws=ws://host:port)`);
  console.log('\n  Watching for changes…\n');

// ── Watch mode: rebuild on change, no server ─────────────────────────────────
} else if (watch) {
  await copyStatics();
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes — output → dist/bundle.js');

// ── Production build ─────────────────────────────────────────────────────────
} else {
  await copyStatics();
  const result = await esbuild.build({
    ...buildOptions,
    metafile: true,
  });

  const text = await esbuild.analyzeMetafile(result.metafile, { verbose: false });
  console.log(text);
  console.log('Build complete → dist/');
}
