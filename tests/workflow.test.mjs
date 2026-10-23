// Structural checks on workflow-simplified.json and its config files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runCode, sqlOf } from './harness.mjs';

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
  // v1 order = top branch first: collection, then purge, then scoring.
  // Fails if Purge sits below scoring: a Gemini failure that stops the run would skip the purge.
  assert.ok(node('Read Sources File').position[1] < node('Purge Old Articles').position[1]);
  assert.ok(node('Purge Old Articles').position[1] < node('Claim Unscored').position[1]);
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

// Fails if Load Config reads another item or binary property: the double only answers (0, 'data').
const sourcesFile = (obj) => ({
  helpers: {
    getBinaryDataBuffer: async (...args) => {
      assert.deepEqual(args, [0, 'data']);
      return Buffer.from(JSON.stringify(obj));
    },
  },
});

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

test('compose lets Code node console.log reach the logs and has no fake env whitelist', () => {
  const compose = read('docker-compose.yml');
  // Fails if the flag is dropped: the n8n task runner discards Code node console output without it.
  assert.match(compose, /^\s*- CODE_ENABLE_STDOUT=true$/m);
  // Fails if N8N_ENV_VARS comes back: it restricts nothing and suggests $env is whitelisted.
  assert.doesNotMatch(compose, /N8N_ENV_VARS/);
});

test('n8n image is pinned to the version whose quirks the tests encode', () => {
  // Fails if the pin moves: mutation 2.1.4 -> 2.1.5, or 2.1.4 -> 2.1.45 (the match is exact).
  // Before any bump, re-verify the {success:true} empty-result shape, the pg-promise $n substitution
  // in comments and the console no-ops, then update this pin.
  assert.match(read('docker-compose.yml'), /^\s*image: n8nio\/n8n:2\.1\.4\s*$/m, 'n8n image must be pinned to n8nio/n8n:2.1.4 exactly');
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

const evalReplacement = (name, scope) => {
  const body = node(name).parameters.options.queryReplacement.replace(/^=\{\{ /, '').replace(/ \}\}$/, '');
  return new Function(...Object.keys(scope), 'return ' + body)(...Object.values(scope));
};

// Each column of the SQL, with the 1-based $n placeholder that fills it, read from the SQL text.
const insertColumns = (sql) => {
  const [, cols, select] = sql.match(/INSERT INTO \w+ \(([^)]+)\)\s*SELECT ([^\n]+)/);
  const nums = [...select.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  return cols.split(',').map((c, i) => [c.trim(), nums[i]]);
};
const assignedColumns = (sql) => [...sql.matchAll(/(\w+) = \$(\d+)/g)].map((m) => [m[1], Number(m[2])]);

test('Insert Candidates and Save Scores bind each value to its own column', () => {
  // Fails if two values are swapped: mutation exchanges title and description (or confidence and score)
  // in the queryReplacement array, so a column receives another column's distinct value.
  const cases = [
    ['Insert Candidates', insertColumns(sqlOf('insert-candidates')), {
      url: 'url', title: 'title', description: 'description', source: 'source', source_type: 'source_type', prio: 'prio', published_at: 'published_at',
    }],
    ['Save Scores', assignedColumns(sqlOf('save-scores')), {
      id: 'id', gemini_confidence: 'confidence', gemini_score: 'score', category: 'category', ai_tag: 'tag', ai_summary: 'summary', ai_takeaway: 'takeaway',
    }],
  ];
  for (const [name, columns, fieldOf] of cases) {
    assert.deepEqual(columns.map(([c]) => c).sort(), Object.keys(fieldOf).sort(), name);
    const json = Object.fromEntries(Object.values(fieldOf).map((f) => [f, `v:${f}`]));
    const values = evalReplacement(name, { $json: json });
    assert.equal(values.length, columns.length, name);
    for (const [column, n] of columns) assert.equal(values[n - 1], `v:${fieldOf[column]}`, `${name}: ${column} = $${n}`);
  }
});

test('Claim Unscored sends at most 25 articles to one Gemini call', () => {
  // Fails if the spend guard moves: mutation [25] -> [250].
  assert.equal(node('Claim Unscored').parameters.options.queryReplacement, '={{ [25] }}');
});

test('Claim Top Articles keeps the score floor 60 and 5 articles per channel', () => {
  // Fails if a threshold moves: mutation [60, 5] -> [0, 5] or [60, 50].
  const [min, cap] = evalReplacement('Claim Top Articles', { $env: {} });
  assert.deepEqual([min, cap], [60, 5]);
});

test('every field Format Embeds reads from a row is returned by claim-top-articles.sql', async () => {
  // Fails if the claim stops returning a field the embed shows (e.g. ai_takeaway dropped from the final SELECT),
  // or Format Embeds reads a field the claim never returns (mutation r.ai_takeaway -> r.takeaway).
  const [, list] = sqlOf('claim-top-articles').match(/SELECT([^;]*?)FROM claimed[^;]*;\s*$/);
  const returned = new Set(list.split(',').map((c) => c.trim()));
  const read = new Set();
  const row = (json) => new Proxy(json, { get: (t, k) => (typeof k === 'string' && read.add(k), t[k]) });
  const items = await runCode('format-embeds', {
    input: [{ json: row({
      id: 1, url: 'https://e/1', title: 'T', source: 'S', source_type: 'Tech News', category: 'LLM',
      published_at: '2026-10-22T10:00:00Z', gemini_score: 70, ai_tag: 't', ai_summary: 's', ai_takeaway: 'k',
    }) }],
    env: { DISCORD_WEBHOOK_TECH_NEWS: 'https://discord.com/api/webhooks/1/a' },
  });
  assert.equal(items.length, 1);
  assert.ok(read.size > 0);
  assert.deepEqual([...read].filter((k) => !returned.has(k)), []);
});

test('Claim Top Articles claims exactly the channels Format Embeds posts to', async () => {
  // Fails if the two webhook checks drift: mutation drops trim() or the ^ anchor in either one,
  // so a padded valid URL or 'xhttps://...' lookalike is accepted by one side only.
  const env = {
    DISCORD_WEBHOOK_TECH_NEWS: '  https://discord.com/api/webhooks/1/a  ',
    DISCORD_WEBHOOK_COMPANIES: 'https://discord.com/api/webhooks/YOUR_COMPANIES_WEBHOOK',
    DISCORD_WEBHOOK_REDDIT: '',
    DISCORD_WEBHOOK_OTHERS: 'xhttps://discord.com/api/webhooks/1/a',
  };
  const claimed = evalReplacement('Claim Top Articles', { $env: env })[2];
  const types = ['Tech News', 'Company Blogs', 'Reddit Communities', 'Other'];
  const items = await runCode('format-embeds', {
    input: types.map((t, i) => ({ json: {
      id: i, url: `https://e/${i}`, title: t, source: 'S', source_type: t, category: 'LLM',
      published_at: '2026-10-22T10:00:00Z', gemini_score: 70,
    } })),
    env,
  });
  const posted = items.flatMap(({ json }) => json.payload.embeds.map((e) => types[Number(e.url.split('/').pop())]));
  assert.deepEqual([...claimed].sort(), [...posted].sort());
  assert.deepEqual(claimed, ['Tech News']);
});

// One source of truth for the channel decision: the four channels and their env keys (env.template).
const CHANNELS = [
  ['Tech News', 'DISCORD_WEBHOOK_TECH_NEWS'],
  ['Company Blogs', 'DISCORD_WEBHOOK_COMPANIES'],
  ['Reddit Communities', 'DISCORD_WEBHOOK_REDDIT'],
  ['Other', 'DISCORD_WEBHOOK_OTHERS'],
];

// Channels Format Embeds posts to for one row of every source_type, under env.
const postedChannels = async (env) => {
  const types = CHANNELS.map(([t]) => t);
  const items = await runCode('format-embeds', {
    input: types.map((t, i) => ({ json: {
      id: i, url: `https://e/${i}`, title: t, source: 'S', source_type: t, category: 'LLM',
      published_at: '2026-10-22T10:00:00Z', gemini_score: 70,
    } })),
    env,
  });
  return [...new Set(items.flatMap(({ json }) => json.payload.embeds.map((e) => types[Number(e.url.split('/').pop())])))].sort();
};

for (const [channel, key] of CHANNELS) {
  test(`only ${key} set: Claim Top Articles and Format Embeds both pick '${channel}' alone`, async () => {
    // Fails if a channel is bound to the wrong env key or misnamed in the claim expression:
    // mutation swaps the Reddit/Other keys, or renames 'Company Blogs' to 'Company Blog'.
    const env = { [key]: 'https://discord.com/api/webhooks/123/abc-DEF_1' };
    const claimed = evalReplacement('Claim Top Articles', { $env: env })[2];
    assert.deepEqual(claimed, [channel]);
    assert.deepEqual(await postedChannels(env), [channel]);
  });

  test(`a suffixed lookalike in ${key} is rejected by both Claim Top Articles and Format Embeds`, async () => {
    // Fails if either webhook regex loses its trailing $ anchor: 'https://.../1/a/extra' is then accepted by one side.
    const env = { [key]: 'https://discord.com/api/webhooks/1/a/extra' };
    assert.deepEqual(evalReplacement('Claim Top Articles', { $env: env })[2], []);
    assert.deepEqual(await postedChannels(env), []);
  });
}
