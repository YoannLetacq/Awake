// Seam: n8n/code/load-config.js, run through tests/harness.mjs (runCode). The binary helper
// double asserts it is read as item 0, property 'data' (the Read File node's output).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeOf, runCode } from './harness.mjs';

const NODE = 'load-config';

const helpersFor = (buffer) => ({
  async getBinaryDataBuffer(itemIndex, propertyName) {
    assert.deepEqual([itemIndex, propertyName], [0, 'data']);
    return buffer;
  },
});

const load = (buffer) => runCode(NODE, { helpers: helpersFor(buffer) });
const loadJson = (obj) => load(Buffer.from(JSON.stringify(obj), 'utf8'));

test('refuses an empty rss_sources.json', async () => {
  // Fails if: the empty-buffer guard is removed (JSON.parse('') then throws a different message).
  await assert.rejects(load(Buffer.alloc(0)), { message: /missing or empty/ });
});

test('refuses rss_sources.json that is not valid JSON', async () => {
  // Fails if: the parse error is not wrapped with the file name.
  await assert.rejects(load(Buffer.from('{ not json', 'utf8')), { message: /rss_sources\.json is not valid JSON/ });
});

test('refuses rss_sources.json without a top-level sources array', async () => {
  // Fails if: the Array.isArray(parsed.sources) guard is removed (then .filter throws a TypeError).
  await assert.rejects(loadJson({ sources: 'nope' }), { message: /must contain a top-level "sources" array/ });
});

test('refuses rss_sources.json with no active source that has a url', async () => {
  // Fails if: the run goes on with zero feeds (mutation: drop the feeds.length === 0 throw).
  const sources = [{ name: 'Off', url: 'https://off.example/rss', active: false }, { name: 'No url', active: true }];
  await assert.rejects(loadJson({ sources }), { message: /no active sources with a url/ });
});

test('passes the prefilter flag and the AI keywords through to the output', async () => {
  // Fails if: the prefilter flag is dropped or not coerced to a boolean, or keywords_ai does not
  // reach `keywords` (the Prepare Candidates prefilter would then match acronyms only).
  const out = await loadJson({
    sources: [
      { name: 'Filtered', url: 'https://a.example/rss', category: 'Tech News', priority: 'high', active: true, prefilter: true },
      { name: 'Open', url: 'https://b.example/rss', category: 'AI Research', priority: 'low', active: true },
    ],
    keywords_ai: ['LLM', 'RAG'],
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].json.feeds.map((f) => [f.name, f.prefilter]), [['Filtered', true], ['Open', false]]);
  assert.deepEqual(out[0].json.keywords, ['LLM', 'RAG']);
});

test('diagnostics use console.log, the only console method the n8n 2.1.4 task runner does not drop', () => {
  // Fails if: any console use other than console.log appears (mutation: console.log -> console.warn,
  // error, info or debug), since the runner drops those and the loaded-count line never reaches stdout.
  // Fails if: the loaded-count line is not logged with console.log.
  const src = codeOf(NODE);
  assert.deepEqual(src.split('\n').filter((line) => /\bconsole\b(?!\.log\b)/.test(line)), []);
  assert.match(src, /console\.log\(`📡 Loaded \$\{feeds\.length\} active RSS feeds/);
});
