// Structural checks on workflow-simplified.json and its config files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runCode } from './harness.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const wf = JSON.parse(read('workflow-simplified.json'));
const node = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  assert.ok(n, `node '${name}' missing`);
  return n;
};
const next = (name, output = 0) => (wf.connections[name]?.main?.[output] || []).map((c) => c.node);

test('workflow JSON is in sync with n8n/code and n8n/sql', () => {
  // fails if a source file is edited without running the build
  execFileSync('node', [new URL('../scripts/build-workflow.mjs', import.meta.url).pathname, '--check']);
});

test('no lock, webdis or dead node left', () => {
  const text = JSON.stringify(wf);
  assert.doesNotMatch(text, /webdis|veille_lock/);
  // every node except triggers is reachable from a trigger (no orphan like the old Gemini Summarize)
  const reached = new Set();
  const walk = (n) => {
    if (reached.has(n)) return;
    reached.add(n);
    for (const out of wf.connections[n]?.main || []) for (const c of out || []) walk(c.node);
  };
  wf.nodes.filter((n) => /trigger/i.test(n.type)).forEach((n) => walk(n.name));
  assert.deepEqual(wf.nodes.map((n) => n.name).filter((n) => !reached.has(n)), []);
});

test('every Postgres query is parameterized', () => {
  const pg = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres');
  assert.ok(pg.length >= 5);
  for (const n of pg) {
    // fails if SQL is built by string interpolation again
    assert.doesNotMatch(n.parameters.query, /\{\{/, n.name);
    if (/\$1\b/.test(n.parameters.query)) {
      assert.match(n.parameters.options?.queryReplacement || '', /^=\{\{ \[.*\] \}\}$/s, n.name);
    }
  }
});

test('scheduled branch collects, scores in one call, and purges', () => {
  const trig = node('Every 30 Minutes');
  assert.equal(trig.parameters.rule.interval[0].minutesInterval, 30);
  assert.deepEqual(next('Every 30 Minutes').sort(), ['Claim Unscored', 'Purge Old Articles', 'Read Sources File']);
  assert.deepEqual(next('Read Sources File'), ['Load Config']);
  assert.deepEqual(next('Load Config'), ['Reddit Fetch']);
  assert.deepEqual(next('Reddit Fetch'), ['Expand Feeds']);
  assert.deepEqual(next('Expand Feeds'), ['RSS Read']);
  assert.deepEqual(next('RSS Read'), ['Prepare Candidates']);
  assert.deepEqual(next('Prepare Candidates'), ['Insert Candidates']);
  assert.deepEqual(next('Claim Unscored'), ['Build Gemini Request']);
  assert.deepEqual(next('Build Gemini Request'), ['Gemini Score']);
  assert.deepEqual(next('Gemini Score'), ['Parse Scores']);
  assert.deepEqual(next('Parse Scores'), ['Save Scores']);
  // fails if Gemini is called per article again: its only input is the single-item Build node
  const gem = node('Gemini Score');
  assert.equal(gem.parameters.jsonBody, '={{ JSON.stringify($json.body) }}');
  assert.equal(gem.onError, 'continueRegularOutput');
  assert.equal(node('Reddit Fetch').onError, 'continueRegularOutput');
  assert.equal(node('RSS Read').onError, 'continueRegularOutput');
  // fails if one bad row can abort the whole ingest (single-query batching rolls everything back)
  assert.equal(node('Insert Candidates').onError, 'continueRegularOutput');
  assert.equal(node('Insert Candidates').parameters.options.queryBatching, 'independently');
  // collection must run before scoring (v1 order = top branch first)
  assert.ok(node('Read Sources File').position[1] < node('Claim Unscored').position[1]);
});

test('mention branch only reads the DB and always answers', () => {
  assert.deepEqual(next('Discord Bot mention1'), ['Authorize Mention']);
  assert.deepEqual(next('Authorize Mention'), ['Claim Top Articles']);
  assert.equal(node('Claim Top Articles').alwaysOutputData, true);
  assert.deepEqual(next('Claim Top Articles'), ['Has Articles?']);
  assert.deepEqual(next('Has Articles?', 0), ['Format Embeds']);
  assert.deepEqual(next('Has Articles?', 1), ['Reply Nothing New']);
  assert.deepEqual(next('Format Embeds'), ['Send to Discord']);
  assert.equal(node('Send to Discord').parameters.jsonBody, '={{ JSON.stringify($json.payload) }}');
  // fails if rows of a channel without webhook can be claimed (marked sent, never posted)
  assert.match(node('Claim Top Articles').parameters.options.queryReplacement, /DISCORD_WEBHOOK_OTHERS/);
});

test('mention branch claims only channels whose webhook is a real Discord URL', () => {
  // Fails if a placeholder counts as configured: mutation keeps only the truthiness check, so 'Company Blogs' is claimed and its POST later fails.
  // Fails if an empty value counts as configured: mutation tests presence only (`$env[k] !== undefined`), so the empty REDDIT value claims 'Reddit Communities'.
  const expr = node('Claim Top Articles').parameters.options.queryReplacement;
  const body = expr.replace(/^=\{\{ /, '').replace(/ \}\}$/, '');
  const env = {
    DISCORD_WEBHOOK_TECH_NEWS: 'https://discord.com/api/webhooks/123/abc-DEF_1',
    DISCORD_WEBHOOK_COMPANIES: 'https://discord.com/api/webhooks/YOUR_COMPANIES_WEBHOOK',
    DISCORD_WEBHOOK_REDDIT: '',
  };
  const replacement = new Function('$env', 'return ' + body)(env);
  assert.deepEqual(replacement[2], ['Tech News']);
});

const sourcesFile = (obj) => ({ helpers: { getBinaryDataBuffer: async () => Buffer.from(JSON.stringify(obj)) } });

test('load-config builds a sanitized Reddit URL', async () => {
  const [out] = await runCode('load-config', sourcesFile({
    sources: [{ name: 'A', url: 'https://a/feed', category: 'Tech News', active: true }, { name: 'B', url: 'https://b', active: false }],
    keywords_ai: ['llm'],
    reddit: { active: true, subreddits: ['OpenAI', 'cursor', 'bad/../x'] },
  }));
  assert.deepEqual(out.json.feeds.map((f) => f.name), ['A']);
  // fails if subreddit names are not validated (path injection into the OAuth URL)
  assert.equal(out.json.reddit_url, 'https://oauth.reddit.com/r/OpenAI+cursor/top?t=day&limit=50&raw_json=1');
  const [off] = await runCode('load-config', sourcesFile({ sources: [{ url: 'u', active: true }], reddit: { active: false, subreddits: ['x'] } }));
  assert.equal(off.json.reddit_url, '');
});

test('rss_sources.json has no known-dead feed and Reddit goes through OAuth', () => {
  const cfg = JSON.parse(read('rss_sources.json'));
  const active = cfg.sources.filter((s) => s.active).map((s) => s.url);
  for (const dead of ['ai.googleblog.com', 'blogs.microsoft.com/ai', 'paperswithcode.com', 'deeplearning.ai/the-batch', 'rss.arxiv.org', 'reddit.com']) {
    assert.ok(!active.some((u) => u.includes(dead)), dead);
  }
  assert.equal(cfg.reddit.active, true);
  assert.equal(cfg.reddit.subreddits.length, 6);
});

test('compose no longer ships redis, webdis or rsshub', () => {
  assert.doesNotMatch(read('docker-compose.yml'), /redis|webdis|rsshub/i);
});

test('no $n placeholder inside an SQL comment', () => {
  // n8n formats parameters with pg-promise over the whole text, comments included:
  // a value with a newline substituted into a "-- $1 ..." comment escapes the comment.
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.postgres')) {
    for (const line of n.parameters.query.split('\n')) {
      const comment = line.includes('--') ? line.slice(line.indexOf('--')) : '';
      assert.doesNotMatch(comment, /\$\d/, `${n.name}: ${line}`);
    }
  }
});
