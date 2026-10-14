/**
 * Compila el frontend (TypeScript) a public/assets/app.js con esbuild.
 * Uso: node scripts/build-frontend.mjs [--watch]
 */
import * as esbuild from 'esbuild';

const isWatchMode = process.argv.includes('--watch');

const options = {
  entryPoints: ['frontend/main.ts'],
  outdir: 'public/assets',
  entryNames: 'app',
  chunkNames: 'chunk-[hash]',
  splitting: true,
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: !isWatchMode,
  sourcemap: isWatchMode ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
};

if (isWatchMode) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('Observando cambios del frontend…');
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  const outputBytes = Object.values(result.metafile.outputs).reduce((total, output) => total + output.bytes, 0);
  console.log(`✔ Frontend compilado (${(outputBytes / 1024).toFixed(0)} KB)`);
}
