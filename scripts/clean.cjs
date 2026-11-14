const { rmSync } = require('node:fs');
const { resolve } = require('node:path');

// Fixed project-relative build outputs only; no user-supplied deletion paths.
const builds = [
  'packages/workflow-core/dist',
  'packages/http-adapter/dist',
  'tools/fixture-api/dist',
  'tools/runner/dist',
];
const paths = process.argv.includes('--build-only')
  ? builds
  : [...builds, 'coverage', 'test-results'];
for (const path of paths) {
  rmSync(resolve(__dirname, '..', path), { recursive: true, force: true });
}
