// Runs an n8n Code node source (n8n/code/<name>.js) outside n8n, with mocked
// $input, $('Node'), $env and this.helpers — the subset our nodes use.
import { readFileSync } from 'node:fs';

const AsyncFunction = (async () => {}).constructor;

const wrap = (items) => ({ all: () => items, first: () => items[0] });

export function codeOf(name) {
  return readFileSync(new URL(`../n8n/code/${name}.js`, import.meta.url), 'utf8');
}

export function sqlOf(name) {
  return readFileSync(new URL(`../n8n/sql/${name}.sql`, import.meta.url), 'utf8');
}

export async function runCode(name, { input = [], nodes = {}, env = {}, helpers = {} } = {}) {
  const $ = (node) => {
    if (!(node in nodes)) throw new Error(`Node '${node}' not mocked`);
    return wrap(nodes[node]);
  };
  const quiet = { log() {}, warn() {}, error() {} };
  const fn = new AsyncFunction('$input', '$', '$env', 'console', codeOf(name));
  return fn.call({ helpers }, wrap(input), $, env, quiet);
}
