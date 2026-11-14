const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run([resolve(__dirname, 'clean.cjs'), '--build-only']);
// Build in dependency order, including the fixture used by transport tests.
for (const workspace of [
  'workflow-core',
  'fixture-api',
  'http-adapter',
  'runner',
]) {
  run([
    process.env.npm_execpath,
    'run',
    'build',
    '--workspace',
    '@project-neo/' + workspace,
  ]);
}
