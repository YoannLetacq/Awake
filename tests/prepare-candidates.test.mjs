// Seam: n8n/code/prepare-candidates.js, run through tests/harness.mjs (runCode).
// Expected values are literals or are read back from the input; the node's own
// helpers are never reused to compute them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeOf, runCode } from './harness.mjs';

const NODE = 'prepare-candidates';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

const feed = (over = {}) => ({
  name: 'Example Feed',
  url: 'https://feed.example/rss.xml',
  category: 'Tech News',
  priority: 'medium',
  prefilter: false,
  ...over,
});

const config = (over = {}) => ({
  keywords: ['LLM', 'GPT', 'RAG', 'machine learning', 'fine-tuning', 'C++'],
  reddit: { active: false, name: 'Reddit', category: 'Reddit Communities', priority: 'medium' },
  ...over,
});

// RSS Read item paired to Expand Feeds[k]. Defaults: clean, fresh (one hour old).
const rss = (k, over = {}) => ({
  json: { title: 'Fresh title', link: 'https://example.com/a', isoDate: iso(Date.now() - HOUR), ...over },
  pairedItem: { item: k },
});

const rows = (items) => items.map((i) => i.json);

async function prepare({ input = [], feeds = [feed()], cfg = config(), reddit } = {}) {
  const nodes = {
    'Expand Feeds': feeds.map((json) => ({ json })),
    'Load Config': [{ json: cfg }],
  };
  if (reddit !== undefined) nodes['Reddit Fetch'] = [{ json: reddit }];
  return runCode(NODE, { input, nodes });
}

test('maps a fresh RSS item to one candidate row', async () => {
  // Fails if: the node file is absent, or any output field comes from the wrong
  // source (source from the title, source_type ignoring the category, prio not
  // mapped from priority, published_at not an ISO-8601 UTC string).
  const published = Date.now() - HOUR;
  const out = await prepare({
    feeds: [feed({ name: 'TechCrunch AI', category: 'Tech News', priority: 'high' })],
    input: [rss(0, {
      title: 'AI startup raises $50M',
      link: 'https://techcrunch.example/ai-startup',
      description: 'Round led by Sequoia',
      isoDate: iso(published),
    })],
  });
  assert.deepEqual(out, [{
    json: {
      url: 'https://techcrunch.example/ai-startup',
      title: 'AI startup raises $50M',
      description: 'Round led by Sequoia',
      source: 'TechCrunch AI',
      source_type: 'Tech News',
      prio: 10,
      published_at: iso(published),
    },
  }]);
});

test('takes source and source_type from the feed at pairedItem.item, not from feed 0', async () => {
  // Fails if: the feed is looked up by position 0 (or any fixed index) instead of
  // pairedItem.item, so the row is credited to 'Wrong Feed'.
  const feeds = [
    feed({ name: 'Wrong Feed', category: 'Mainstream Media' }),
    feed({ name: 'Also Wrong', category: 'Tech News' }),
    feed({ name: 'Also Wrong 2', category: 'Development' }),
    feed({ name: 'Right Feed', category: 'AI Research', priority: 'low' }),
  ];
  const out = await prepare({ feeds, input: [rss(3, { link: 'https://lab.example/post-1' })] });
  assert.deepEqual(rows(out).map((r) => [r.source, r.source_type, r.prio]), [['Right Feed', 'Company Blogs', -10]]);
});

test('drops an item with no pairedItem instead of defaulting to feed 0', async () => {
  // Fails if: a missing pairedItem falls back to index 0, keeping the item under feeds[0].
  const out = await prepare({
    feeds: [feed({ name: 'Feed Zero' })],
    input: [{ json: { title: 'Orphan', link: 'https://example.com/orphan', isoDate: iso(Date.now() - HOUR) } }],
  });
  assert.deepEqual(out, []);
});

test('accepts pairedItem as a one-element array and drops out-of-range indexes', async () => {
  // Fails if: [{item}] arrays are ignored (the item is lost), or index 9 (beyond the
  // 1 feed) is defaulted to feed 0 or throws instead of being skipped.
  const out = await prepare({
    feeds: [feed({ name: 'Only Feed' })],
    input: [
      { json: { title: 'Paired by array', link: 'https://example.com/array', isoDate: iso(Date.now() - HOUR) }, pairedItem: [{ item: 0 }] },
      { json: { title: 'Out of range', link: 'https://example.com/range', isoDate: iso(Date.now() - HOUR) }, pairedItem: { item: 9 } },
    ],
  });
  assert.deepEqual(rows(out).map((r) => r.url), ['https://example.com/array']);
});

test('keeps items up to 48h old and up to 1h ahead; drops older or further-ahead items', async () => {
  // Fails if: the 48h age cap is missing (the 3-day-old item is kept), the cap is
  // tighter than 48h (the 47h item is dropped), or the 1h future guard is missing
  // (the item 2h ahead is kept).
  const out = await prepare({
    input: [
      rss(0, { title: 'Three days old', link: 'https://example.com/3d', isoDate: iso(Date.now() - 3 * DAY) }),
      rss(0, { title: 'Forty-seven hours old', link: 'https://example.com/47h', isoDate: iso(Date.now() - 47 * HOUR) }),
      rss(0, { title: 'Two hours ahead', link: 'https://example.com/2h-ahead', isoDate: iso(Date.now() + 2 * HOUR) }),
      rss(0, { title: 'Half an hour ahead', link: 'https://example.com/30m-ahead', isoDate: iso(Date.now() + 30 * MIN) }),
    ],
  });
  assert.deepEqual(rows(out).map((r) => r.title), ['Forty-seven hours old', 'Half an hour ahead']);
});

test('the 48h window is exact: an item 47h59 old is kept, one 48h01 old is dropped', async () => {
  // Fails if: the window is wider than 48h, which keeps the 48h01 item (mutation: the
  // `NOW - 48 * HOUR_MS` bound in n8n/code/prepare-candidates.js set to 49 hours); or narrower,
  // which drops the 47h59 item (mutation: 47 hours).
  const out = await prepare({
    input: [
      rss(0, { title: 'Forty-seven hours fifty-nine', link: 'https://example.com/47h59', isoDate: iso(Date.now() - 47 * HOUR - 59 * MIN) }),
      rss(0, { title: 'Forty-eight hours one', link: 'https://example.com/48h01', isoDate: iso(Date.now() - 48 * HOUR - MIN) }),
    ],
  });
  assert.deepEqual(rows(out).map((r) => r.title), ['Forty-seven hours fifty-nine']);
});

test('skips items with no usable date and takes published_at from pubDate before isoDate', async () => {
  // Fails if: an item without a parseable date is kept (mutation: remove the window check, so
  // NaN reaches toISOString and the run throws 'Invalid time value'), or isoDate wins over a
  // present pubDate. Dropping only Number.isFinite is an equivalent mutant: NaN already fails
  // both bound comparisons.
  const pub = Date.now() - 2 * HOUR;
  const out = await prepare({
    input: [
      rss(0, { title: 'No date', link: 'https://example.com/nodate', isoDate: undefined }),
      rss(0, { title: 'Garbage date', link: 'https://example.com/garbage', pubDate: 'not a date', isoDate: undefined }),
      rss(0, { title: 'RFC 822 wins', link: 'https://example.com/rfc822', pubDate: new Date(pub).toUTCString(), isoDate: iso(Date.now() - HOUR) }),
    ],
  });
  // toUTCString() drops milliseconds, so the expected instant is the whole second.
  assert.deepEqual(rows(out).map((r) => [r.title, r.published_at]), [
    ['RFC 822 wins', iso(Math.floor(pub / 1000) * 1000)],
  ]);
});

test('strips tags, decodes the listed entities with &amp; last, and collapses whitespace', async () => {
  // Fails if: tags survive; whitespace is not collapsed and trimmed; or &amp; is decoded
  // before &lt;, so the literal text "&amp;lt;" turns into "<" (double decoding).
  const out = await prepare({
    input: [rss(0, {
      title: '  <b>Big</b>&nbsp;news &amp; &quot;hi&quot;  ',
      description: '<p>Tom &amp;lt;3 &#39;yo&#39;</p>\n\n<p>done &gt; x</p>',
    })],
  });
  assert.deepEqual(rows(out).map((r) => [r.title, r.description]), [
    ['Big news & "hi"', "Tom &lt;3 'yo' done > x"],
  ]);
});

test('decodes numeric entities for valid code points only, before &amp;', async () => {
  // Fails if: &#N; / &#xH; stay encoded (the title keeps '&#8217;' and the title dedupe sees two
  // spellings of one headline); an entity is decoded twice ('&amp;#38;' or '&#38;amp;' turns into '&'); or
  // invalid code points (0, a surrogate, above 0x10FFFF) are decoded instead of left as written.
  const out = await prepare({
    input: [rss(0, {
      title: 'OpenAI&#8217;s new model &#x27;o5&#x27; &#038; more',
      description: 'lit &amp;#38; &#38;amp; bad &#0; &#xD800; &#1114112;',
    })],
  });
  assert.deepEqual(rows(out).map((r) => [r.title, r.description]), [
    ['OpenAI\u2019s new model \'o5\' & more', 'lit &#38; &amp; bad &#0; &#xD800; &#1114112;'],
  ]);
});

test('caps title at 1000 and description at 500 characters', async () => {
  // Fails if: either field is left uncapped (the output would be 1100 and 600 characters).
  const out = await prepare({ input: [rss(0, { title: 'T'.repeat(1100), description: 'D'.repeat(600) })] });
  assert.deepEqual(rows(out).map((r) => [r.title.length, r.description.length]), [[1000, 500]]);
});

test('skips items whose title is empty after cleaning, or that have no link', async () => {
  // Fails if: a title that cleans to '' (tags and whitespace only) is emitted, or an
  // item with no link is emitted.
  const out = await prepare({
    input: [
      rss(0, { title: '<b> </b>&nbsp;', link: 'https://example.com/empty-title' }),
      rss(0, { title: 'No link here', link: undefined }),
      rss(0, { title: 'Kept', link: 'https://example.com/kept' }),
    ],
  });
  assert.deepEqual(rows(out).map((r) => r.title), ['Kept']);
});

test('uses contentSnippet, then content, when description is empty', async () => {
  // Fails if: the fallback order is wrong (content beats contentSnippet), or an empty
  // description does not trigger the fallback.
  const out = await prepare({
    input: [
      rss(0, { title: 'Snippet wins', link: 'https://example.com/s', description: '', contentSnippet: 'From snippet', content: 'From content' }),
      rss(0, { title: 'Content last', link: 'https://example.com/c', contentSnippet: '', content: '<p>From content</p>' }),
    ],
  });
  assert.deepEqual(rows(out).map((r) => [r.title, r.description]), [
    ['Snippet wins', 'From snippet'],
    ['Content last', 'From content'],
  ]);
});

test('prefilter feeds keep AI-relevant titles; feeds without prefilter keep everything', async () => {
  // Fails if: keyword matching ignores the right word edge ('RAG' matches inside 'RAGged') or
  // the left one ('LLM' matches inside 'megaLLM'; mutation: drop the (?<!WORD) lookbehind);
  // the AI/IA/ML check is case-insensitive ('ai' in "J'ai" or 'rainfall' passes); keywords
  // are matched case-sensitively ('gpt-based' is dropped); keywords with '-' or spaces never
  // match; regex specials are not escaped ('C++' throws); or prefilter also runs on a feed
  // with prefilter=false (the dropped titles would vanish from the unfiltered run).
  const kept = [
    'AI startup raises $50M',
    "L'IA chez Mistral",
    'New LLM benchmark',
    'Shipping a gpt-based tool',
    'Notes on fine-tuning',
    'Intro to machine learning',
    'C++ tips for devs',
    // Fails if the dotted acronym (NYT house style) or plural keywords are not matched.
    'A.I. Discovered a Critical Vulnerability in PHP',
    'Les LLMs locaux sur votre Mac',
    'Why RAGs still matter',
  ];
  const dropped = ["J'ai testé Docker", 'Storage with RAGged arrays', 'Average rainfall in Paris', 'megaLLM launch'];
  const input = [...kept, ...dropped].map((title, i) => rss(0, { title, link: `https://example.com/t${i}` }));

  const filtered = await prepare({ feeds: [feed({ prefilter: true })], input });
  assert.deepEqual(rows(filtered).map((r) => r.title), kept);

  const unfiltered = await prepare({ feeds: [feed({ prefilter: false })], input });
  assert.deepEqual(rows(unfiltered).map((r) => r.title), [...kept, ...dropped]);
});

test('keeps meaningful query params and drops tracking params, the fragment and a trailing slash', async () => {
  // Fails if: every query param is dropped (id is lost), a tracking param survives (utm_*,
  // ref, fbclid, gclid), the #fragment is kept, or the trailing '/' is kept.
  const out = await prepare({
    input: [rss(0, { link: 'https://example.com/watch/?v=abc&utm_medium=email&fbclid=zz&ref=home&gclid=yy&id=7#top' })],
  });
  assert.deepEqual(rows(out).map((r) => r.url), ['https://example.com/watch?v=abc&id=7']);
});

test('lowercases the host, strips a leading www., and keeps the scheme and path case as written', async () => {
  // Fails if: the host keeps its case or its www. label, the path is lowercased, or http
  // is upgraded to https.
  const out = await prepare({ input: [rss(0, { link: 'HTTP://WWW.Example.COM/Path' })] });
  assert.deepEqual(rows(out).map((r) => r.url), ['http://example.com/Path']);
});

test('skips links that are not URLs, not http(s), or longer than 2048 characters', async () => {
  // Fails if: an unparseable link, a javascript: link, or an over-long link becomes a candidate.
  const out = await prepare({
    input: [
      rss(0, { title: 'Not a URL', link: 'not a url' }),
      rss(0, { title: 'Script link', link: 'javascript:alert(1)' }),
      rss(0, { title: 'Too long', link: `https://example.com/${'a'.repeat(2100)}` }),
      rss(0, { title: 'Fine', link: 'https://example.com/ok' }),
    ],
  });
  assert.deepEqual(rows(out).map((r) => r.title), ['Fine']);
});

test('URL variants that differ only by www, utm_source, trailing slash and #fragment give one candidate', async () => {
  // Fails if: the variants are not merged (no dedupe), or any one of the four normalizations
  // is missing, so the two strings still differ and two rows are emitted.
  const out = await prepare({
    input: [
      rss(0, { title: 'Variant A', link: 'https://www.Example.com/post/42/?utm_source=newsletter#comments' }),
      rss(0, { title: 'Variant B', link: 'https://example.com/post/42' }),
    ],
  });
  assert.deepEqual(rows(out).map((r) => r.url), ['https://example.com/post/42']);
});

test('dedupes by normalized URL across feeds, keeping the first seen', async () => {
  // Fails if: the last occurrence wins (the source would be 'Second Feed'), or the
  // duplicate from the second feed is kept.
  const out = await prepare({
    feeds: [feed({ name: 'First Feed' }), feed({ name: 'Second Feed' })],
    input: [
      rss(0, { title: 'Story', link: 'https://example.com/story' }),
      rss(1, { title: 'Story again', link: 'https://example.com/story?utm_campaign=x' }),
    ],
  });
  assert.deepEqual(rows(out).map((r) => [r.source, r.url]), [['First Feed', 'https://example.com/story']]);
});

test('keeps only the 20 newest items of an RSS feed', async () => {
  // Fails if: the cap keeps the first 20 in input order rather than the newest (ages are
  // shuffled, so the first 20 items include ages 21 to 25), or the cap is off by one.
  // Item n is n minutes old, n = 1..25, in shuffled input order.
  const items = Array.from({ length: 25 }, (_, i) => {
    const age = ((i * 7) % 25) + 1;
    return rss(0, { title: `Item ${age}`, link: `https://example.com/cap/${age}`, isoDate: iso(Date.now() - age * MIN) });
  });
  const out = await prepare({ input: items });
  const newest20 = Array.from({ length: 20 }, (_, n) => `Item ${n + 1}`);
  assert.deepEqual(rows(out).map((r) => r.title).sort(), newest20.sort());
});

test('caps each RSS feed separately: two feeds of 25 fresh items keep 20 each', async () => {
  // Fails if: the cap is global rather than per feed (mutation: group every candidate under
  // one key), which keeps 20 rows in total instead of 40.
  const feeds = [feed({ name: 'Feed A' }), feed({ name: 'Feed B' })];
  const input = [0, 1].flatMap((k) => Array.from({ length: 25 }, (_, i) =>
    rss(k, { title: `F${k} item ${i}`, link: `https://example.com/f${k}/${i}`, isoDate: iso(Date.now() - (i + 1) * MIN) })));
  const out = await prepare({ feeds, input });
  const perFeed = Object.groupBy(rows(out), (r) => r.source);
  assert.deepEqual([perFeed['Feed A']?.length, perFeed['Feed B']?.length], [20, 20]);
});

const redditCfg = (over = {}) => ({ active: true, name: 'Reddit', category: 'Reddit Communities', priority: 'medium', ...over });

test('maps Reddit listing posts to candidates and skips stickied and over_18 posts', async () => {
  // Fails if: the url is not built from permalink on www.reddit.com (then normalized), the
  // source is not subreddit_name_prefixed, the external url is not used when selftext is
  // empty, or stickied / over_18 posts are kept.
  const created = Math.floor(Date.now() / 1000) - 600;
  const out = await prepare({
    cfg: config({ reddit: redditCfg() }),
    reddit: {
      kind: 'Listing',
      data: {
        children: [
          { data: { title: 'Fresh post', permalink: '/r/OpenAI/comments/abc123/fresh_post/', url: 'https://external.example/article', selftext: '', created_utc: created, subreddit_name_prefixed: 'r/OpenAI', stickied: false, over_18: false } },
          { data: { title: 'Pinned', permalink: '/r/OpenAI/comments/pin1/pinned/', url: 'https://www.reddit.com/r/OpenAI/comments/pin1/pinned/', selftext: 'Mod note', created_utc: created, subreddit_name_prefixed: 'r/OpenAI', stickied: true, over_18: false } },
          { data: { title: 'Adult', permalink: '/r/OpenAI/comments/nsfw1/adult/', url: 'https://external.example/x', selftext: '', created_utc: created, subreddit_name_prefixed: 'r/OpenAI', stickied: false, over_18: true } },
        ],
      },
    },
  });
  assert.deepEqual(out, [{
    json: {
      url: 'https://reddit.com/r/OpenAI/comments/abc123/fresh_post',
      title: 'Fresh post',
      description: 'https://external.example/article',
      source: 'r/OpenAI',
      source_type: 'Reddit Communities',
      prio: 0,
      published_at: iso(created * 1000),
    },
  }]);
});

test('ignores a Reddit error object without throwing, and keeps the RSS rows', async () => {
  // Fails if: the error object is read as a listing (TypeError on data.children) and aborts
  // the run, or the RSS row is lost with it.
  const out = await prepare({
    cfg: config({ reddit: redditCfg() }),
    reddit: { error: 'HTTP 429 Too Many Requests' },
    input: [rss(0, { title: 'Still here', link: 'https://example.com/rss-ok' })],
  });
  assert.deepEqual(rows(out).map((r) => r.title), ['Still here']);
});

test('ignores the Reddit listing when reddit.active is false', async () => {
  // Fails if: reddit.active is not honored, so the posts of a listing are emitted while
  // Reddit is switched off.
  const created = Math.floor(Date.now() / 1000) - 600;
  const out = await prepare({
    cfg: config({ reddit: redditCfg({ active: false }) }),
    reddit: {
      kind: 'Listing',
      data: {
        children: [
          { data: { title: 'Should not appear', permalink: '/r/OpenAI/comments/x1/y/', url: 'https://external.example/z', selftext: '', created_utc: created, subreddit_name_prefixed: 'r/OpenAI', stickied: false, over_18: false } },
        ],
      },
    },
  });
  assert.deepEqual(out, []);
});

test('caps Reddit at 50 posts as one feed, not at the RSS cap of 20', async () => {
  // Fails if: Reddit is capped like an RSS feed (20 rows), or not capped at all (55 rows).
  // Post n is n minutes old, n = 1..55, so the 50 newest are posts 1..50.
  const children = Array.from({ length: 55 }, (_, i) => ({
    data: {
      title: `Post ${i + 1}`,
      permalink: `/r/OpenAI/comments/p${i + 1}/post/`,
      url: `https://external.example/${i + 1}`,
      selftext: '',
      created_utc: Math.floor((Date.now() - (i + 1) * MIN) / 1000),
      subreddit_name_prefixed: 'r/OpenAI',
      stickied: false,
      over_18: false,
    },
  }));
  const out = await prepare({ cfg: config({ reddit: redditCfg() }), reddit: { kind: 'Listing', data: { children } } });
  const newest50 = Array.from({ length: 50 }, (_, n) => `Post ${n + 1}`);
  assert.deepEqual(rows(out).map((r) => r.title).sort(), newest50.sort());
});

test('drops Reddit posts older than 48h or more than 1h ahead, like RSS items', async () => {
  // Fails if: the date guard on Reddit posts is removed (mutation: drop `!inWindow(t)` from the
  // Reddit skip condition), so the 49h-old post and the post 2h ahead are kept.
  const post = (title, ms) => ({
    data: { title, permalink: `/r/OpenAI/comments/${title.replaceAll(' ', '_')}/x/`, url: 'https://external.example/w', selftext: '', created_utc: Math.floor(ms / 1000), subreddit_name_prefixed: 'r/OpenAI', stickied: false, over_18: false },
  });
  const out = await prepare({
    cfg: config({ reddit: redditCfg() }),
    reddit: {
      kind: 'Listing',
      data: {
        children: [
          post('Forty-nine hours old', Date.now() - 49 * HOUR),
          post('Two hours ahead', Date.now() + 2 * HOUR),
          post('Fresh', Date.now() - HOUR),
        ],
      },
    },
  });
  assert.deepEqual(rows(out).map((r) => r.title), ['Fresh']);
});

test('uses Reddit selftext as the description when present, cleaned', async () => {
  // Fails if: the external url is used even when selftext is set, or selftext is not cleaned.
  const created = Math.floor(Date.now() / 1000) - 600;
  const out = await prepare({
    cfg: config({ reddit: redditCfg() }),
    reddit: {
      kind: 'Listing',
      data: {
        children: [
          { data: { title: 'Text post', permalink: '/r/LocalLLaMA/comments/t1/text_post/', url: 'https://www.reddit.com/r/LocalLLaMA/comments/t1/text_post/', selftext: 'Long <b>body</b> text', created_utc: created, subreddit_name_prefixed: 'r/LocalLLaMA', stickied: false, over_18: false } },
        ],
      },
    },
  });
  assert.deepEqual(rows(out).map((r) => [r.source, r.description]), [['r/LocalLLaMA', 'Long body text']]);
});

test('maps each feed category to a source_type, with unknown and inherited-key names giving Other', async () => {
  // Fails if: a listed category maps to the wrong type (e.g. 'French Tech' -> 'Other'); an
  // unknown category falls back to 'Tech News' instead of 'Other'; or an inherited Object key
  // ('constructor', '__proto__') yields a function or prototype value instead of 'Other'.
  const table = [
    ['AI Companies', 'Company Blogs'],
    ['AI Research', 'Company Blogs'],
    ['Tech News', 'Tech News'],
    ['Tech Community', 'Tech News'],
    ['Development', 'Tech News'],
    ['Mainstream Media', 'Tech News'],
    ['French Tech', 'Tech News'],
    ['Newsletters', 'Other'],
    ['constructor', 'Other'],
    ['__proto__', 'Other'],
  ];
  const feeds = table.map(([category]) => feed({ name: `Feed ${category}`, category }));
  const input = table.map((_, k) => rss(k, { title: `Item ${k}`, link: `https://example.com/cat/${k}` }));
  const out = await prepare({ feeds, input });
  assert.deepEqual(rows(out).map((r) => r.source_type), table.map(([, type]) => type));
});

test('maps priority high, medium and low to 10, 0 and -10; missing or unknown priority to 0', async () => {
  // Fails if: a priority maps to the wrong value (e.g. low -> 10), or a missing or unknown
  // priority does not give 0.
  const table = [['high', 10], ['medium', 0], ['low', -10], [undefined, 0], ['urgent', 0]];
  const feeds = table.map(([priority], k) => feed({ name: `P${k}`, priority }));
  const input = table.map((_, k) => rss(k, { title: `Prio ${k}`, link: `https://example.com/prio/${k}` }));
  const out = await prepare({ feeds, input });
  assert.deepEqual(rows(out).map((r) => r.prio), table.map(([, prio]) => prio));
});

test('caps the source name at 255 characters', async () => {
  // Fails if: a long feed name is stored untrimmed (the column is varchar(255)).
  const out = await prepare({
    feeds: [feed({ name: 'N'.repeat(300) })],
    input: [rss(0, { title: 'Long source', link: 'https://example.com/long-source' })],
  });
  assert.equal(rows(out)[0].source.length, 255);
});

test('returns an empty array when nothing survives', async () => {
  // Fails if: the node returns anything other than [] (undefined, null or a placeholder row)
  // when there is no input.
  assert.deepEqual(await prepare({ input: [] }), []);
});

test('skips a failed-feed item (has an error key) without throwing, and keeps other feeds', async () => {
  // Fails if: items with an 'error' key are not skipped (the error item has a valid title,
  // link and date, so only the error check can drop it), or the run throws instead.
  const out = await prepare({
    feeds: [feed({ name: 'Broken Feed' }), feed({ name: 'Healthy Feed' })],
    input: [
      { json: { error: 'ETIMEDOUT', title: 'Stale headline', link: 'https://broken.example/x', isoDate: iso(Date.now() - HOUR) }, pairedItem: { item: 0 } },
      rss(1, { title: 'Healthy headline', link: 'https://healthy.example/y' }),
    ],
  });
  assert.deepEqual(rows(out).map((r) => [r.source, r.url]), [['Healthy Feed', 'https://healthy.example/y']]);
});

test('a NUL character is stripped from text fields', async () => {
  // Fails if clean() keeps U+0000: Postgres rejects it and the whole Insert Candidates batch aborts.
  const out = await prepare({ input: [rss(0, { title: 'Bad\u0000Title', description: 'x\u0000y', link: 'https://example.com/nul' })] });
  assert.deepEqual(rows(out).map((r) => [r.title, r.description]), [['BadTitle', 'xy']]);
});

test('diagnostics use console.log, the only console method the n8n 2.1.4 task runner does not drop', () => {
  // Fails if: any console use other than console.log appears (mutation: console.log -> console.warn,
  // error, info or debug), since the runner drops those and the skip diagnostics never reach stdout.
  // Fails if: the failed-feed diagnostic is not logged with console.log.
  const src = codeOf(NODE);
  assert.deepEqual(src.split('\n').filter((line) => /\bconsole\b(?!\.log\b)/.test(line)), []);
  assert.match(src, /console\.log\(`Prepare Candidates: feed failed, skipped: /);
});
