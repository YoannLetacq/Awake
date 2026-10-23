// Prepare Candidates: raw feed items -> candidate rows for rss_articles.
// Run Once for All Items mode. Pure: no network, no require.

const SOURCE_TYPE = new Map([
  ['AI Companies', 'Company Blogs'],
  ['AI Research', 'Company Blogs'],
  ['Tech News', 'Tech News'],
  ['Tech Community', 'Tech News'],
  ['Development', 'Tech News'],
  ['Mainstream Media', 'Tech News'],
  ['French Tech', 'Tech News'],
  ['Reddit Communities', 'Reddit Communities'],
]);
const PRIO = new Map([['high', 10], ['medium', 0], ['low', -10]]);

const cfg = $('Load Config').first()?.json ?? {};
const feeds = $('Expand Feeds').all().map((i) => i.json ?? {});

const HOUR_MS = 3600 * 1000;
const NOW = Date.now();
// Published within the last 48h, and at most 1h ahead of now (clock skew tolerance).
const inWindow = (ms) => Number.isFinite(ms) && ms >= NOW - 48 * HOUR_MS && ms <= NOW + HOUR_MS;

const TITLE_MAX = 1000;
const DESC_MAX = 500;
const URL_MAX = 2048;
const RSS_CAP = 20;
const REDDIT_CAP = 50;
const REDDIT_KEY = 'reddit';
const REDDIT_BASE = 'https://www.reddit.com';
const SOURCE_MAX = 255;
const ENTITIES = [['&nbsp;', ' '], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"]];

// HTML to plain text. Tags become spaces (so words on either side stay apart); the listed
// entities are decoded, &amp; last so that "&amp;lt;" stays the literal text "&lt;".
const clean = (raw) => {
  let s = String(raw ?? '').replace(/<\/?[a-zA-Z!][^<>]*>/g, ' ');
  for (const [entity, char] of ENTITIES) s = s.replaceAll(entity, char);
  // U+0000 is rejected by Postgres and would abort the whole insert batch.
  return s.replaceAll('&amp;', '&').replaceAll('\u0000', '').replace(/\s+/g, ' ').trim();
};

const isTracking = (key) => {
  const k = key.toLowerCase();
  return k.startsWith('utm_') || k === 'ref' || k === 'fbclid' || k === 'gclid';
};

// Canonical link used for dedupe and storage: http(s) only; lowercase host without a leading
// 'www.'; no utm_*/ref/fbclid/gclid parameters; no #fragment; no trailing '/' except the root.
// Returns null for anything that is not a usable link.
const normalizeUrl = (raw) => {
  let u;
  try {
    u = new URL(String(raw ?? ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  u.search = new URLSearchParams([...u.searchParams].filter(([k]) => !isTracking(k))).toString();
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  const s = u.toString();
  return s.length <= URL_MAX ? s : null;
};

// Prefilter (feeds with prefilter=true only): a configured keyword as a whole word (plural 's'
// allowed), matched case-insensitively, or an AI/IA/ML acronym in capitals (also 'A.I.'). Word edges are Unicode letters,
// digits and '_', so keywords with '-', spaces or '+' still match; keywords are regex-escaped.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = '[\\p{L}\\p{N}_]';
const keywords = (Array.isArray(cfg.keywords) ? cfg.keywords : []).map((k) => String(k).trim()).filter(Boolean);
const keywordRe = keywords.length
  ? new RegExp(`(?<!${WORD})(?:${keywords.map(escapeRe).join('|')})s?(?!${WORD})`, 'iu')
  : null;
const ACRONYM_RE = /\b(?:AI|IA|ML)\b|\bA\.I\./;
const passesPrefilter = (text) => ACRONYM_RE.test(text) || (keywordRe !== null && keywordRe.test(text));

// Index into Expand Feeds of the feed an RSS item came from, or -1. Never defaults to 0.
const feedIndex = (item) => {
  const p = item.pairedItem;
  const k = (Array.isArray(p) ? p[0] : p)?.item;
  return Number.isInteger(k) && k >= 0 && k < feeds.length ? k : -1;
};

const cands = [];
for (const item of $input.all()) {
  const k = feedIndex(item);
  if (k < 0) {
    console.warn('Prepare Candidates: RSS item without a valid feed pairing, skipped');
    continue;
  }
  const feed = feeds[k];
  const json = item.json ?? {};
  if ('error' in json) {
    console.warn(`Prepare Candidates: feed failed, skipped: ${feed.name}`);
    continue;
  }
  const t = Date.parse(String(json.pubDate || json.isoDate || ''));
  if (!inWindow(t)) continue;
  const title = clean(json.title).slice(0, TITLE_MAX);
  const url = normalizeUrl(json.link);
  if (!title || !url) continue;
  const description = clean(json.description || json.contentSnippet || json.content).slice(0, DESC_MAX);
  if (feed.prefilter && !passesPrefilter(`${title} ${description}`)) continue;
  cands.push({
    key: k,
    t,
    row: {
      url,
      title,
      description,
      source: String(feed.name ?? '').slice(0, SOURCE_MAX),
      source_type: SOURCE_TYPE.get(feed.category) ?? 'Other',
      prio: PRIO.get(feed.priority) ?? 0,
      published_at: new Date(t).toISOString(),
    },
  });
}

// Reddit: one feed (key 'reddit'), read only when reddit.active is true. A failed fetch (error
// object or anything that is not a listing) is skipped with a warning; RSS rows are unaffected.
const redditCfg = cfg.reddit ?? {};
if (redditCfg.active) {
  const listing = $('Reddit Fetch').first()?.json;
  if (listing?.kind !== 'Listing' || !Array.isArray(listing.data?.children)) {
    console.warn('Prepare Candidates: Reddit Fetch returned no listing, Reddit skipped');
  } else {
    for (const child of listing.data.children) {
      const d = child?.data ?? {};
      if (d.stickied || d.over_18) continue;
      const title = clean(d.title).slice(0, TITLE_MAX);
      const url = typeof d.permalink === 'string' && d.permalink ? normalizeUrl(REDDIT_BASE + d.permalink) : null;
      const t = Number(d.created_utc) * 1000;
      if (!title || !url || !inWindow(t)) continue;
      const description = clean(d.selftext || d.url).slice(0, DESC_MAX);
      cands.push({
        key: REDDIT_KEY,
        t,
        row: {
          url,
          title,
          description,
          source: String(d.subreddit_name_prefixed || redditCfg.name || 'Reddit').slice(0, SOURCE_MAX),
          source_type: SOURCE_TYPE.get(redditCfg.category) ?? 'Other',
          prio: PRIO.get(redditCfg.priority) ?? 0,
          published_at: new Date(t).toISOString(),
        },
      });
    }
  }
}

// Per-source cap: the newest 20 items of each RSS feed, or the newest 50 Reddit posts, survive.
const byFeed = new Map();
for (const c of cands) {
  if (!byFeed.has(c.key)) byFeed.set(c.key, []);
  byFeed.get(c.key).push(c);
}
const capped = new Set();
for (const [key, list] of byFeed) {
  const cap = key === REDDIT_KEY ? REDDIT_CAP : RSS_CAP;
  for (const c of list.sort((a, b) => b.t - a.t).slice(0, cap)) capped.add(c);
}

// Dedupe within the run by normalized URL; the first row seen wins.
const seen = new Set();
const out = [];
for (const c of cands) {
  if (!capped.has(c) || seen.has(c.row.url)) continue;
  seen.add(c.row.url);
  out.push({ json: c.row });
}
return out;
