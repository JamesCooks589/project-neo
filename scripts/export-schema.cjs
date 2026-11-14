const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { bundleJsonSchema } = require('../packages/workflow-core/dist/src');

const target = resolve(__dirname, '../schemas/workflow-bundle.schema.json');
const content = JSON.stringify(bundleJsonSchema(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== content) {
    console.error(
      'Workflow JSON Schema is out of date. Run npm run schema:export.',
    );
    process.exitCode = 1;
  }
} else {
  mkdirSync(resolve(__dirname, '../schemas'), { recursive: true });
  writeFileSync(target, content);
}
