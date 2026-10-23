// Turn the batched Gemini reply into scored rows, matched by id (never by position).
const resp = $input.first()?.json ?? {};
const finishReason = resp.candidates?.[0]?.finishReason ?? 'none';
// Throwing turns the execution red (Gemini Score continues on error, so nothing else would).
// The rows stay unscored and the SQL claim picks them up again on the next run.
const fail = (why) => {
  throw new Error(`Gemini scoring failed: ${why}`);
};
if (resp.error) fail(resp.error.message ?? JSON.stringify(resp.error));
const text = (resp.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text || '').join('');
const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
let results = parse(body);
if (!Array.isArray(results) && finishReason === 'MAX_TOKENS') {
  // A reply cut mid-array: keep the longest prefix that closes into a valid array.
  // ponytail: one JSON.parse per '}' from the end, quadratic but bounded by maxOutputTokens.
  for (let i = body.lastIndexOf('}'); i > 0 && !Array.isArray(results); i = body.lastIndexOf('}', i - 1)) {
    results = parse(body.slice(0, i + 1) + ']');
  }
  if (Array.isArray(results)) console.log(`Gemini reply cut by MAX_TOKENS: kept its first ${results.length} results`);
}
if (!Array.isArray(results)) fail(`unusable reply, finishReason ${finishReason}`);
const sent = new Set($('Claim Unscored').all().map(({ json }) => Number(json.id)));

// Text lands in Discord embeds: no clickable links, no bare URLs, no mention pings.
// Mentions go first (one hidden inside a link would rebuild it), and the passes repeat until
// nothing changes, so no removal can splice a new link, URL or ping together.
const strip = (s) => s
  .replace(/<[@#][^>]*>/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/\S+|www\.\S+/gi, '')
  .replace(/@(everyone|here)/gi, '');
const clean = (v, cap) => {
  let s = String(v ?? '');
  for (let prev; prev !== s;) {
    prev = s;
    s = strip(s);
  }
  // Leftover delimiters cannot open a masked link or a mention any more.
  s = s.replace(/[[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > cap ? chars.slice(0, cap - 1).join('') + '…' : s;
};

// A Map, not a plain object, so topics like 'constructor' cannot hit Object.prototype.
const CATEGORY = new Map([
  ['LLM', '🧠 LLM'], ['Agents', '🤖 Agents'], ['Vision', '🎨 Vision'],
  ['Coding', '💻 Coding'], ['Research', '🔬 Research'], ['RAG', '📚 RAG'],
]);

const TAGS = ['🔥', '📊', '🔬', '💡'];

const clamp = (v) => {
  const n = Math.round(Number(v));
  return Number.isNaN(n) ? 0 : Math.min(100, Math.max(0, n));
};

const seen = new Set();
const out = [];
for (const r of results) {
  const id = Number(r?.id);
  if (!sent.has(id) || seen.has(id)) continue;
  seen.add(id);
  const confidence = clamp(r.confidence);
  const score = clamp(r.score);
  const gated = confidence >= 85 && score >= 60;
  out.push({ json: {
    id,
    confidence,
    score,
    category: CATEGORY.get(r.topic) ?? '🤖 AI General',
    tag: TAGS.includes(r.tag) ? r.tag : '',
    summary: gated ? clean(r.summary, 300) : '',
    takeaway: gated ? clean(r.takeaway, 150) : '',
  } });
}
return out;
