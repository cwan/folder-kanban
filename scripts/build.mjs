// Bundles the extension host code and the webview script with esbuild.
import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const configs = args.has('--tests')
  ? [
      {
        ...common,
        entryPoints: readdirSync('test')
          .filter((f) => f.endsWith('.test.ts'))
          .map((f) => `test/${f}`),
        outdir: 'out/test',
        platform: 'node',
        format: 'cjs',
        target: 'node20',
      },
    ]
  : [
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['vscode'],
      },
      {
        ...common,
        entryPoints: ['src/webview/main.ts'],
        outfile: 'dist/webview.js',
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
      },
    ];

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
