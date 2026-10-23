#!/usr/bin/env node
// Inlines n8n/code/<slug>.js into the matching Code node's jsCode and
// n8n/sql/<slug>.sql into the matching Postgres node's query, where
// slug = node name in kebab-case. Edit the source files, then run this.
//   node scripts/build-workflow.mjs          rewrite workflow-simplified.json
//   node scripts/build-workflow.mjs --check  exit 1 if the JSON is out of date
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const wfPath = new URL('workflow-simplified.json', root);
const current = readFileSync(wfPath, 'utf8');
const wf = JSON.parse(current);

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

for (const node of wf.nodes) {
  const code = new URL(`n8n/code/${slug(node.name)}.js`, root);
  const sql = new URL(`n8n/sql/${slug(node.name)}.sql`, root);
  if (existsSync(code)) node.parameters.jsCode = readFileSync(code, 'utf8');
  if (existsSync(sql)) node.parameters.query = readFileSync(sql, 'utf8');
}

const built = `${JSON.stringify(wf, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (built !== current) {
    console.error('workflow-simplified.json is out of date: run node scripts/build-workflow.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(wfPath, built);
}
