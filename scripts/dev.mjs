/**
 * Desarrollo local: compila el frontend en modo observación y arranca el
 * servidor Node con recarga automática.
 *
 * Se ejecuta tsx directamente con Node (sin npx ni shell) para que funcione
 * igual en Windows, macOS y Linux, y se muestra cualquier error al arrancar.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

const children = [
  { name: 'frontend', process: spawn(process.execPath, ['scripts/build-frontend.mjs', '--watch'], { stdio: 'inherit' }) },
  { name: 'servidor', process: spawn(process.execPath, [tsxCli, 'watch', '--clear-screen=false', 'src/node/server.ts'], { stdio: 'inherit' }) },
];

for (const child of children) {
  child.process.on('error', (error) => {
    console.error(`\n✘ No se pudo iniciar el ${child.name}: ${error.message}`);
    stopAll(1);
  });
  child.process.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n✘ El ${child.name} terminó con código ${code}. Revisa el mensaje de arriba.`);
      stopAll(code);
    }
  });
}

function stopAll(exitCode = 0) {
  for (const child of children) child.process.kill();
  process.exit(exitCode);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
