// Turn the batched Gemini reply into scored rows, matched by id (never by position).
const resp = $input.first()?.json ?? {};
const text = (resp.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text || '').join('');
let results = null;
try {
  results = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
} catch {
  results = null;
}
if (!Array.isArray(results)) {
  // Rows stay unscored and the SQL claim picks them up again on the next run.
  console.warn('Gemini batch dropped:', resp.error ?? resp.candidates?.[0]?.finishReason ?? 'no usable text');
  return [];
}
const sent = new Set($('Claim Unscored').all().map(({ json }) => Number(json.id)));

// Text lands in Discord embeds: no clickable links, no bare URLs, no mention pings.
const clean = (v, cap) => {
  const s = String(v ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/@(everyone|here)|<[@#][^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
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
