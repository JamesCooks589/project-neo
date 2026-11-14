const { rmSync } = require('node:fs');
const { resolve } = require('node:path');

// Fixed project-relative build outputs only; no user-supplied deletion paths.
const paths = process.argv.includes('--build-only')
  ? ['packages/workflow-core/dist']
  : ['packages/workflow-core/dist', 'coverage', 'test-results'];
for (const path of paths) {
  rmSync(resolve(__dirname, '..', path), { recursive: true, force: true });
}
