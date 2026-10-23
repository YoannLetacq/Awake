// Seams: n8n/code/authorize-mention.js and n8n/code/format-embeds.js, run through the harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeOf, runCode } from './harness.mjs';

// Pin the host zone to UTC so the Paris-time footer assertion can only pass through the explicit timeZone option.
// Node's test runner runs this file in its own process, so the change stays local to it.
process.env.TZ = 'UTC';

const AsyncFunction = (async () => {}).constructor;

// harness.runCode discards console output. The warn assertions run the same node source with a recording console.
async function runRecording(name, { input = [], env = {} } = {}) {
  const warnings = [];
  const recorder = { log() {}, error() {}, warn: (msg) => warnings.push(String(msg)) };
  const $ = () => {
    throw new Error('$() is not mocked in this test');
  };
  const fn = new AsyncFunction('$input', '$', '$env', 'console', codeOf(name));
  const items = await fn.call({ helpers: {} }, { all: () => input, first: () => input[0] }, $, env, recorder);
  return { items, warnings };
}

const mention = (id, authorId) => ({ json: { id, authorId, channelId: 'chan-1', content: 'hey @bot' } });

test('authorize: an empty, unset or comma-only allow-list denies every mention and warns', async () => {
  // Fails if the deny-by-default gate is removed: mutation `return $input.all();` returns both mentions.
  // Fails if the warning is dropped: mutation deletes the console.warn line, so warnings stays empty.
  for (const DISCORD_ALLOWED_AUTHORS of [undefined, '', ' , ,']) {
    const { items, warnings } = await runRecording('authorize-mention', {
      input: [mention('m1', '1'), mention('m2', '2')],
      env: { DISCORD_ALLOWED_AUTHORS },
    });
    assert.deepEqual(items, []);
    assert.deepEqual(warnings, ['DISCORD_ALLOWED_AUTHORS is empty: all mentions are ignored']);
  }
});

test('authorize: keeps only mentions whose author is in the trimmed allow-list', async () => {
  // Fails if the gate is removed: mutation `return $input.all();` keeps author 3.
  // Fails if the list is not trimmed: ' 2' never matches '2', so m2 is dropped.
  // Fails if authorId is not stringified: numeric author 2 never matches '2', so m2 is dropped.
  const items = await runCode('authorize-mention', {
    input: [mention('m1', '1'), mention('m2', 2), mention('m3', '3')],
    env: { DISCORD_ALLOWED_AUTHORS: '1, 2' },
  });
  assert.deepEqual(items, [mention('m1', '1'), mention('m2', 2)]);
});

const WEBHOOKS = {
  DISCORD_WEBHOOK_TECH_NEWS: 'https://discord.test/tech',
  DISCORD_WEBHOOK_COMPANIES: 'https://discord.test/companies',
  DISCORD_WEBHOOK_REDDIT: 'https://discord.test/reddit',
  DISCORD_WEBHOOK_OTHERS: 'https://discord.test/others',
};

const article = (n, overrides = {}) => ({
  id: n,
  url: `https://example.com/${n}`,
  title: `Article ${n}`,
  source: 'TechCrunch',
  source_type: 'Tech News',
  category: 'LLM',
  published_at: '2026-10-22T10:00:00Z',
  gemini_score: 50,
  ai_tag: '🧠',
  ai_summary: 'Résumé.',
  ai_takeaway: 'Retenir.',
  ...overrides,
});

const rowsOf = (...rows) => rows.map((json) => ({ json }));

// Embed URLs per webhook, merged across messages that share a webhook.
const urlsByWebhook = (items) => {
  const byHook = {};
  for (const { json } of items) {
    byHook[json.webhook_url] = [...(byHook[json.webhook_url] || []), ...json.payload.embeds.map((e) => e.url)];
  }
  return byHook;
};

test('format: each source_type posts to its own webhook, one message per group', async () => {
  // Fails if the mapping is swapped: mutation exchanges the TECH_NEWS and REDDIT env names in the group table.
  // Fails if every group shares one webhook: mutation sends all groups to DISCORD_WEBHOOK_OTHERS.
  const items = await runCode('format-embeds', {
    input: rowsOf(article(1, { source_type: 'Tech News' }), article(2, { source_type: 'Reddit Communities' })),
    env: WEBHOOKS,
  });
  assert.equal(items.length, 2);
  assert.deepEqual(urlsByWebhook(items), {
    'https://discord.test/tech': ['https://example.com/1'],
    'https://discord.test/reddit': ['https://example.com/2'],
  });
});

test('format: an unknown source_type falls back to the Other webhook', async () => {
  // Fails if unknown types are dropped: mutation matches the raw source_type, so 'Podcast' joins no group.
  // Fails if the fallback is wrong: mutation maps unknown types to the Company Blogs group.
  const items = await runCode('format-embeds', {
    input: rowsOf(article(1, { source_type: 'Podcast' }), article(2, { source_type: 'Company Blogs' })),
    env: WEBHOOKS,
  });
  assert.deepEqual(urlsByWebhook(items), {
    'https://discord.test/others': ['https://example.com/1'],
    'https://discord.test/companies': ['https://example.com/2'],
  });
});

test('format: a group whose webhook is empty or unset is skipped with a warning and never throws', async () => {
  // Fails if the skip becomes an error: mutation replaces the warning and `continue` with a throw, so the run rejects.
  // Fails if the empty check is removed: mutation drops the `if (!webhook)` guard, so an empty url gets posted.
  const { items, warnings } = await runRecording('format-embeds', {
    input: rowsOf(
      article(1, { source_type: 'Tech News' }),
      article(2, { source_type: 'Reddit Communities' }),
      article(3, { source_type: 'Podcast' }),
    ),
    env: { ...WEBHOOKS, DISCORD_WEBHOOK_REDDIT: undefined, DISCORD_WEBHOOK_OTHERS: '   ' },
  });
  assert.deepEqual(
    items.map(({ json }) => json.webhook_url),
    ['https://discord.test/tech'],
  );
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes('DISCORD_WEBHOOK_REDDIT')));
  assert.ok(warnings.some((w) => w.includes('DISCORD_WEBHOOK_OTHERS')));
});

test('format: embed carries the French title, description, colour and footer, with the date in Paris time', async () => {
  // Fails if the title loses its tag or category: mutation drops the `${r.ai_tag} ${r.category} |` prefix.
  // Fails if the summary or takeaway block is dropped: mutation removes the 📝 or 💡 line from the description.
  // Fails if the score is not /100: mutation removes the '/100' suffix.
  // Fails if the date ignores Europe/Paris: mutation drops timeZone, and 10:00Z then shows as 10:00 on a UTC machine.
  // Fails if the default icon changes: mutation uses '🧠' instead of '💡' when ai_tag is empty.
  const [item] = await runCode('format-embeds', {
    input: rowsOf(article(1, { title: 'Hello', gemini_score: 80 })),
    env: WEBHOOKS,
  });
  assert.deepEqual(item.json.payload.embeds, [
    {
      title: '🧠 LLM | Hello',
      url: 'https://example.com/1',
      color: 15844367,
      description: '📝 **Résumé :** Résumé.\n\n💡 **À retenir :** Retenir.\n\n**Score : 80/100**',
      footer: { text: '📍 TechCrunch | ⏰ 22 oct., 12:00' },
    },
  ]);

  const [bare] = await runCode('format-embeds', {
    input: rowsOf(article(2, { ai_tag: '', category: '', ai_summary: '', ai_takeaway: null, gemini_score: 7 })),
    env: WEBHOOKS,
  });
  assert.equal(bare.json.payload.embeds[0].title, '💡 🤖 AI General | Article 2');
  assert.equal(bare.json.payload.embeds[0].description, '**Score : 7/100**');
});

test('format: title is cut to 256 and description to 1000, never leaving half an emoji', async () => {
  // Fails if the title is not cut: mutation removes cut() around the title, so it runs past 256 units.
  // Fails if the cut is a plain slice: mutation `slice(0, 256)` keeps the high half of the 😀 at index 255.
  // Fails if the description is not cut: mutation skips the cut for the description, so it runs past 1000.
  const prefix = '🧠 LLM | '; // 9 UTF-16 units, so the emoji starts at index 255 of the title
  const title = 'a'.repeat(256 - prefix.length - 1) + '😀' + 'b'.repeat(40);
  const [item] = await runCode('format-embeds', {
    input: rowsOf(article(1, { title, ai_summary: 'x'.repeat(1500), ai_takeaway: null })),
    env: WEBHOOKS,
  });
  const [embed] = item.json.payload.embeds;
  assert.equal(embed.title.length, 255);
  assert.doesNotMatch(embed.title, /[\uD800-\uDBFF]$/);
  assert.equal(embed.description.length, 1000);
  assert.ok(embed.description.startsWith('📝 **Résumé :** xxx'));
});

test('format: more than 10 articles in one group become messages of 10 then 2, with none dropped', async () => {
  // Fails if the overflow is dropped: mutation `articles.slice(0, 10)` loses articles 11 and 12.
  // Fails if the overflow is dropped another way: mutation stops adding articles once 10 are in, without a new message.
  // Fails if the count in content is wrong: mutation writes a fixed '10 article(s)' into every message.
  // Scores fall with the index, so input order is already score order and this test isolates the split.
  const rows = Array.from({ length: 12 }, (_, k) => article(k + 1, { gemini_score: 12 - k }));
  const items = await runCode('format-embeds', { input: rowsOf(...rows), env: WEBHOOKS });
  assert.deepEqual(
    items.map(({ json }) => json.payload.embeds.length),
    [10, 2],
  );
  assert.deepEqual(
    items.flatMap(({ json }) => json.payload.embeds.map((e) => e.url)),
    Array.from({ length: 12 }, (_, k) => `https://example.com/${k + 1}`),
  );
  assert.ok(items[0].json.payload.content.startsWith('📰 Tech News IA — 10 article(s)\n📅 '));
  assert.ok(items[1].json.payload.content.startsWith('📰 Tech News IA — 2 article(s)\n📅 '));
});

test('format: every message stays within 5800 chars of embed text and no article is lost', async () => {
  // Fails if the char budget is removed: mutation keeps only the 10-embed cap, so the 8 long embeds share one message over 5800.
  // Fails if overflow is dropped: mutation drops the embed that would break the budget instead of starting a message.
  const rows = Array.from({ length: 8 }, (_, k) =>
    article(k + 1, { gemini_score: 90 - k, ai_summary: 'é'.repeat(900), ai_takeaway: null }),
  );
  const items = await runCode('format-embeds', { input: rowsOf(...rows), env: WEBHOOKS });
  for (const { json } of items) {
    const total = json.payload.embeds.reduce(
      (sum, e) => sum + e.title.length + e.description.length + e.footer.text.length,
      0,
    );
    assert.ok(total <= 5800, `message total is ${total} chars`);
  }
  assert.ok(items.length >= 2, 'eight long articles must be split across messages');
  assert.deepEqual(
    items.flatMap(({ json }) => json.payload.embeds.map((e) => e.url)),
    Array.from({ length: 8 }, (_, k) => `https://example.com/${k + 1}`),
  );
});

test('format: every payload disables mentions, and embeds run from highest to lowest score', async () => {
  // Fails if mentions are enabled: mutation sets allowed_mentions to { parse: ['everyone'] } or omits it.
  // Fails if the order is wrong: mutation sorts ascending, or drops the sort so input order is kept.
  // Fails if only the first payload of a split gets allowed_mentions: mutation writes it when out.length === 0 alone.
  const scores = [5, 91, 40, 77, 12, 63, 88, 30, 99, 21, 54, 70]; // article n carries scores[n - 1]
  const rows = scores.map((score, k) => article(k + 1, { gemini_score: score }));
  const items = await runCode('format-embeds', { input: rowsOf(...rows), env: WEBHOOKS });
  assert.equal(items.length, 2);
  for (const { json } of items) {
    assert.deepEqual(json.payload.allowed_mentions, { parse: [] });
  }
  // Scores in descending order: 99, 91, 88, 77, 70, 63, 54, 40, 30, 21, 12, 5.
  assert.deepEqual(
    items.flatMap(({ json }) => json.payload.embeds.map((e) => e.url)),
    [9, 2, 7, 4, 12, 6, 11, 3, 8, 10, 5, 1].map((n) => `https://example.com/${n}`),
  );
});
