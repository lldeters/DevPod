// Bundles the extension into dist/extension.js.
// `vscode` is provided by the host; `@devcontainers/cli` is a pre-bundled CLI
// that is shipped as-is inside the VSIX and spawned as a child process.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
