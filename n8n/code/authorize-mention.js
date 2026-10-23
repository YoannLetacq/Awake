// Only mentions from authors listed in DISCORD_ALLOWED_AUTHORS (comma-separated user IDs) are processed.
// Deny by default: an empty or missing list ignores every mention.
const allowed = String($env.DISCORD_ALLOWED_AUTHORS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

if (allowed.length === 0) {
  console.warn('DISCORD_ALLOWED_AUTHORS is empty: all mentions are ignored');
  return [];
}

return $input.all().filter(item => allowed.includes(String(item.json.authorId)));
