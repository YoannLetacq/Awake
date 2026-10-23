// Load rss_sources.json (mounted at /home/node/rss_sources.json).
// Edit that file to add/remove/toggle feeds — no workflow change needed.
const buffer = await this.helpers.getBinaryDataBuffer(0, 'data');
if (!buffer || buffer.length === 0) {
  throw new Error('rss_sources.json is missing or empty at /home/node/rss_sources.json');
}

let parsed;
try {
  parsed = JSON.parse(buffer.toString('utf8'));
} catch (e) {
  throw new Error('rss_sources.json is not valid JSON: ' + e.message);
}

if (!parsed || !Array.isArray(parsed.sources)) {
  throw new Error('rss_sources.json must contain a top-level "sources" array');
}

const feeds = parsed.sources
  .filter(s => s && s.active && s.url)
  .map(s => ({ name: s.name, url: s.url, category: s.category, priority: s.priority, prefilter: Boolean(s.prefilter) }));
if (feeds.length === 0) {
  throw new Error('rss_sources.json has no active sources with a url');
}

const r = parsed.reddit || {};
const subs = (r.subreddits || []).filter(s => /^[A-Za-z0-9_]+$/.test(s));
const redditActive = Boolean(r.active) && subs.length > 0;
const reddit_url = redditActive
  ? `https://oauth.reddit.com/r/${subs.join('+')}/${r.listing || 'top'}?t=${r.t || 'day'}&limit=${Number(r.limit) || 50}&raw_json=1`
  : '';

console.log(`📡 Loaded ${feeds.length} active RSS feeds, Reddit ${redditActive ? 'on' : 'off'}`);
return [{
  json: {
    feeds,
    keywords: Array.isArray(parsed.keywords_ai) ? parsed.keywords_ai : [],
    reddit: { active: redditActive, name: r.name || 'Reddit', category: r.category || 'Reddit Communities', priority: r.priority || 'medium' },
    reddit_url
  }
}];
