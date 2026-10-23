const GROUPS = {
  'Tech News': { env: 'DISCORD_WEBHOOK_TECH_NEWS', color: 15844367, label: '📰 Tech News IA' },
  'Company Blogs': { env: 'DISCORD_WEBHOOK_COMPANIES', color: 10181046, label: '💬 Companies Blog IA' },
  'Reddit Communities': { env: 'DISCORD_WEBHOOK_REDDIT', color: 10181046, label: '💬 Reddit Communities IA' },
  'Other': { env: 'DISCORD_WEBHOOK_OTHERS', color: 7506394, label: '🔗 Other Sources IA' },
};

// A webhook is configured only if its trimmed value is a Discord webhook URL: placeholders and empty values fail it.
// The Claim Top Articles expression in workflow-simplified.json applies the same test.
const WEBHOOK_URL = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

const MAX_EMBEDS = 10;
const MAX_CHARS = 5800;

// Cut to n UTF-16 units without splitting an emoji: a lone surrogate is not valid Unicode text for Discord.
const cut = (s, n) => {
  const head = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
};

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

const embedOf = (r, color) => ({
  title: cut(`${r.ai_tag || '💡'} ${r.category || '🤖 AI General'} | ${r.title}`, 256),
  url: r.url,
  color,
  description: cut(
    (r.ai_summary ? '📝 **Résumé :** ' + r.ai_summary + '\n\n' : '') +
      (r.ai_takeaway ? '💡 **À retenir :** ' + r.ai_takeaway + '\n\n' : '') +
      '**Score : ' + r.gemini_score + '/100**',
    1000,
  ),
  footer: { text: `📍 ${r.source} | ⏰ ${fmtDate(r.published_at)}` },
});

// Split embeds into messages of at most 10 embeds and 5800 chars (title + description + footer.text).
const chunk = (embeds) => {
  const messages = [];
  let current = [];
  let size = 0;
  for (const e of embeds) {
    const cost = e.title.length + e.description.length + e.footer.text.length;
    if (current.length && (current.length === MAX_EMBEDS || size + cost > MAX_CHARS)) {
      messages.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += cost;
  }
  if (current.length) messages.push(current);
  return messages;
};

const now = new Date().toLocaleDateString('fr-FR', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
});
const rows = $input.all().map((item) => item.json);
const out = [];

for (const [type, group] of Object.entries(GROUPS)) {
  const articles = rows
    .filter((r) => (Object.hasOwn(GROUPS, r.source_type) ? r.source_type : 'Other') === type)
    .sort((a, b) => b.gemini_score - a.gemini_score);
  if (articles.length === 0) continue;

  const webhook = String($env[group.env] || '').trim();
  if (!WEBHOOK_URL.test(webhook)) {
    console.warn(`${group.env} is unset or not a Discord webhook URL: skipping ${articles.length} article(s)`);
    continue;
  }

  for (const embeds of chunk(articles.map((r) => embedOf(r, group.color)))) {
    out.push({
      json: {
        webhook_url: webhook,
        payload: {
          content: `${group.label} — ${embeds.length} article(s)\n📅 ${now}`,
          embeds,
          allowed_mentions: { parse: [] },
        },
      },
    });
  }
}

return out;
