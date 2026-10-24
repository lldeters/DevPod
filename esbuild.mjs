// Bundles the extension into dist/extension.js.
// `vscode` is provided by the host; `@devcontainers/cli` is a pre-bundled CLI
// that is shipped as-is inside the VSIX and spawned as a child process.
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Short commit hash, so a log or a diagnostics report says which build produced it. */
function buildId() {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA.slice(0, 7);
  }
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // jsonc-parser's UMD entry (`main`) uses require() calls esbuild cannot follow; its ESM build
  // (`module`) bundles cleanly.
  mainFields: ['module', 'main'],
  external: ['vscode', '@devcontainers/cli'],
  sourcemap: !production,
  minify: production,
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
