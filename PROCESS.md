# VeilleIA Workflow Optimization - Implementation Guide

This document contains all instructions to optimize the VeilleIA n8n workflow.

---

## Table of Contents

1. [Overview](#overview)
2. [Priority 1: Duplicate Filtering Before Gemini](#priority-1-duplicate-filtering-before-gemini-scoring)
3. [Priority 2: AI Intelligent Filtering](#priority-2-replace-keyword-filtering-with-ai-intelligent-filtering)
4. [Priority 3: Single Dynamic RSS Node](#priority-3-optimize-rss-flow---single-dynamic-node)
5. [Priority 4: NotebookLM Podcast Format](#priority-4-notebooklm-podcastnewsletter-format)
6. [Priority 5: Google Search Style Output](#priority-5-google-search-page-style-output)
7. [Priority 6: Redis Lock for Concurrency](#priority-6-redis-lock-for-concurrent-execution-prevention)
8. [Summary & Implementation Order](#summary)

---

## Overview

### Current Problems

```
Current Flow (WASTEFUL):
+-----------------------------------------------------------------------------+
| 11 RSS Nodes (hardcoded) -> Merge -> Keyword Filter -> Gemini Score -> DB   |
|                                          ^              ^                   |
|                                    Destructive    Tokens wasted on          |
|                                    filtering      duplicates!               |
+-----------------------------------------------------------------------------+
```

### Target Flow

```
+------------------------------------------------------------------------------+
| Single HTTP Node    ->  DB Duplicate  ->  AI Filter  ->  Gemini  ->  DB      |
| (reads from file)       Check FIRST      (Gemini)       Score      (new only)|
|       |                    |                |                                |
| rss_sources.json    Saves tokens!    Smart filtering                         |
+------------------------------------------------------------------------------+
```

### Expected Improvements

| Priority | Task | Token Impact |
|----------|------|--------------|
| 1 | Duplicate filtering before Gemini | **-60% API calls** |
| 2 | AI intelligent filtering | Smarter filtering |
| 3 | Single RSS node from file | Scalable, cleaner |
| 4 | NotebookLM podcast format | Weekly digest |
| 5 | Google search style output | New display option |

---

## Priority 1: Duplicate Filtering Before Gemini Scoring

### Step 1.1: Workflow Flow Change

**Current Flow:**
```
Global merge -> Filter AI Keywords & Date -> Categorize & Validate -> Escape SQL Values -> Gemini Score ALL
```

**New Flow:**
```
Global merge -> Filter AI Keywords & Date -> Categorize & Validate -> [NEW: Check Duplicates DB] -> [NEW: Filter New Only] -> Escape SQL Values -> Gemini Score ALL
```

### Step 1.2: Add Node "Collect URLs for DB Check"

**Position:** After `Categorize & Validate`, BEFORE `Escape SQL Values`

| Setting | Value |
|---------|-------|
| **Node Type** | Code |
| **Name** | `Collect URLs for DB Check` |

**Code:**
```javascript
// Collect all URLs from incoming items for batch DB check
const items = $input.all();
const urls = items.map(item => item.json.url).filter(url => url && url.trim() !== '');

// Store items for later filtering - keep URLs as simple array
return [{
  json: {
    urls: urls,
    items: items.map(i => i.json)
  }
}];
```

### Step 1.3: Add Node "Check Existing in DB"

**Position:** After `Collect URLs for DB Check`

| Setting | Value |
|---------|-------|
| **Node Type** | Postgres |
| **Name** | `Check Existing in DB` |
| **Credential** | Your Postgres account |
| **Operation** | Execute Query |

**Query (use this exact expression):**
```
SELECT url FROM rss_articles WHERE url IN ({{ $json.urls.map(u => "'" + u.replace(/'/g, "''") + "'").join(', ') }})
```

This dynamically builds a query like:
```sql
SELECT url FROM rss_articles WHERE url IN ('https://example1.com/article', 'https://example2.com/post', ...)
```

**Note:** The `.replace(/'/g, "''")` escapes single quotes in URLs to prevent SQL errors.

### Step 1.4: Add Node "Filter New Articles Only"

**Position:** After `Check Existing in DB`

| Setting | Value |
|---------|-------|
| **Node Type** | Code |
| **Name** | `Filter New Articles Only` |

**Code:**
```javascript
// Get the original items from the first input
const collectedData = $('Collect URLs for DB Check').first().json;
const originalItems = collectedData.items;

// Get existing URLs from database query result
const dbResults = $input.all();
const existingUrls = new Set(dbResults.map(item => item.json.url));

// Filter to keep only NEW articles (not in database)
const newArticles = originalItems.filter(item => !existingUrls.has(item.url));

// Log stats for debugging
console.log(`Total articles: ${originalItems.length}`);
console.log(`Already in DB: ${existingUrls.size}`);
console.log(`New articles to process: ${newArticles.length}`);

// Return new articles in n8n format
if (newArticles.length === 0) {
  return []; // No new articles - stops the flow here
}

return newArticles.map(item => ({ json: item }));
```

### Step 1.5: Update Connections

1. **Disconnect** `Categorize & Validate` from `Escape SQL Values`
2. **Connect:**
   - `Categorize & Validate` -> `Collect URLs for DB Check`
   - `Collect URLs for DB Check` -> `Check Existing in DB`
   - `Check Existing in DB` -> `Filter New Articles Only`
   - `Filter New Articles Only` -> `Escape SQL Values`

### Step 1.6: Visual Diagram

```
BEFORE:
Categorize & Validate -> Escape SQL Values -> Gemini Score ALL -> Parse Score -> ...

AFTER:
Categorize & Validate
       |
Collect URLs for DB Check
       |
Check Existing in DB (Postgres)
       |
Filter New Articles Only
       |
Escape SQL Values -> Gemini Score ALL -> Parse Score -> ...
```

### Expected Token Savings

If you typically have:
- 50 articles from RSS feeds
- 30 already in database (duplicates)
- Only 20 are new

**Before:** 50 Gemini API calls for scoring
**After:** 20 Gemini API calls for scoring = **60% token savings**

---

## Priority 2: Replace Keyword Filtering with AI Intelligent Filtering

### Current Problem

The node `Filter AI Keywords & Date` uses a hardcoded keyword list:
```javascript
const aiKeywords = ['llm', 'gpt', 'claude', ...];
```

This is **destructive** - articles without exact keywords get dropped even if relevant.

### Solution: Combined Filter + Score in One Gemini Call

More token-efficient - one call handles both relevance filtering AND scoring.

**Key benefit:** Articles with confidence < 85 are automatically excluded (not AI-relevant).

#### Step 2.1: Modified "Gemini Score ALL" Prompt

Replace the current `Gemini Score ALL` body with:

```javascript
={{
  JSON.stringify({
    contents: [{
      parts: [{
        text: `You are an AI content analyst for technical AI/ML monitoring.

Analyze this article and provide TWO separate evaluations:

Title: ${$json.title}
Description: ${$json.description}
Source: ${$json.source}

1. CONFIDENCE (0-100): How relevant is this article to AI/ML?
   - 85-100: Clearly about AI/ML (LLMs, neural networks, AI companies, AI tools, AI research, AI finTech, AI conTech)
   - 50-84: Partially related to AI
   - 0-49: Not AI-related (general tech, crypto without AI, non-AI programming)

2. SCORE (0-100): How important is this for AI practitioners?
   - Breaking News (30pts): Model releases, major announcements
   - Technical Depth (25pts): Code, tutorials, implementation details
   - Novelty (25pts): New research, breakthroughs
   - Impact (20pts): Industry significance

Respond ONLY with JSON:
{
  "confidence": 0-100,
  "score": 0-100,
  "reason": "Brief explanation"
}`
      }]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 150
    }
  })
}}
```

#### Step 2.2: Add "Merge Original Data" Node

**Position:** After `Gemini Score ALL`, BEFORE `Parse Score`

| Setting | Value |
|---------|-------|
| **Node Type** | Merge |
| **Name** | `Merge Original Data` |
| **Mode** | Combine |
| **Combination Mode** | Merge By Position |

**Inputs:**
- Input 1: Connect from `Escape SQL Values` (original articles)
- Input 2: Connect from `Gemini Score ALL` (Gemini responses)

This merges each original article with its corresponding Gemini response by position.

#### Step 2.3: Modified "Parse Score" Node

**Position:** After `Merge Original Data`

```javascript
const items = $input.all();
const output = [];

for (let i = 0; i < items.length; i++) {
  const item = items[i].json;
  let score = 0;
  let confidence = 0;
  let reason = 'Parsing error';

  try {
    if (item.candidates?.[0]) {
      let text = item.candidates[0].content.parts[0].text;

      // Remove markdown code blocks if present
      text = text.replace(/```json/gi, '').replace(/```/g, '').trim();

      // Parse JSON response
      const parsed = JSON.parse(text);
      score = parsed.score || 0;           // Importance for user (display only)
      confidence = parsed.confidence || 0;  // AI relevance (used for filtering)
      reason = parsed.reason || 'No reason provided';
    }
  } catch (error) {
    console.log(`Parse error for article ${i}: ${error.message}`);
  }

  // Combine original article data with Gemini scores
  output.push({
    json: {
      url: item.url,
      title: item.title,
      description: item.description,
      content: item.content,
      source: item.source,
      source_type: item.source_type,
      category: item.category,
      published_at: item.published_at,
      gemini_score: score,
      gemini_confidence: confidence,
      gemini_reason: reason
    }
  });
}

// Filter by CONFIDENCE >= 85 (AI relevance threshold)
const filtered = output.filter(item => item.json.gemini_confidence >= 85);

console.log(`AI-relevant articles (confidence >= 85): ${filtered.length} / ${output.length}`);
return filtered;
```

---

## Priority 3: Optimize RSS Flow - Single Dynamic Node

### Current Problem

11 individual RSS nodes hardcoded:
- RSS TechCrunch AI, RSS Hacker News AI, RSS OpenAI, RSS Hugging Face, etc.

**Problems:**
- Adding a new source = edit workflow + add node + rewire connections
- Not scalable
- Clutters the workflow visually

### Step 3.1: Host rss_sources.json

#### Option A: Use Local File (via n8n volume)

Add to `docker-compose.yml`:

```yaml
n8n:
  volumes:
    - ./data/n8n:/home/node/.n8n
    - ./rss_sources.json:/home/node/rss_sources.json:ro  # Add this line
```

#### Option B: Use HTTP URL

Upload `rss_sources.json` to GitHub raw, Google Drive, or your server.

### Step 3.2: Add "Load RSS Sources" Node

**Position:** After `Send processing message` (replaces all RSS nodes)

| Setting | Value |
|---------|-------|
| **Node Type** | Code |
| **Name** | `Load RSS Sources` |

**Code (Option A - Local File):**
```javascript
// Read RSS sources from local file
const fs = require('fs');
const path = '/home/node/rss_sources.json';

try {
  const data = fs.readFileSync(path, 'utf8');
  const config = JSON.parse(data);

  // Filter only active sources
  const activeSources = config.sources.filter(s => s.active === true);

  console.log(`Loaded ${activeSources.length} active RSS sources`);

  // Return each source as separate item for looping
  return activeSources.map(source => ({
    json: {
      name: source.name,
      url: source.url,
      category: source.category,
      priority: source.priority
    }
  }));
} catch (error) {
  console.error('Error loading RSS sources:', error);
  return [];
}
```

**Code (Option B - HTTP URL):**
```javascript
// RSS sources loaded via HTTP Request node before this
const config = $input.first().json;

const activeSources = config.sources.filter(s => s.active === true);

console.log(`Loaded ${activeSources.length} active RSS sources`);

return activeSources.map(source => ({
  json: {
    name: source.name,
    url: source.url,
    category: source.category,
    priority: source.priority
  }
}));
```

If using Option B, add HTTP Request node before:

| Setting | Value |
|---------|-------|
| **Node Type** | HTTP Request |
| **Name** | `Fetch RSS Config` |
| **Method** | GET |
| **URL** | Your URL to rss_sources.json |

### Step 3.3: Add "Fetch RSS Feed" Node

**Position:** After `Load RSS Sources`

| Setting | Value |
|---------|-------|
| **Node Type** | HTTP Request |
| **Name** | `Fetch RSS Feed` |
| **Method** | GET |
| **URL** | `={{ $json.url }}` |
| **Response Format** | String |

**Options:**
- **Batching:** Enable (to process sources in parallel)
- **Batch Size:** 5
- **Continue On Fail:** Enable

### Step 3.4: Add "Parse RSS Feed" Node

**Position:** After `Fetch RSS Feed`

| Setting | Value |
|---------|-------|
| **Node Type** | Code |
| **Name** | `Parse RSS Feed` |

**Code:**
```javascript
const xml2js = require('xml2js');
const parser = new xml2js.Parser({ explicitArray: false });

const items = $input.all();
const allArticles = [];

for (const item of items) {
  try {
    const sourceInfo = $('Load RSS Sources').all().find(
      s => s.json.url === item.json.url ||
           item.json.responseUrl?.includes(new URL(s.json.url).hostname)
    )?.json || { name: 'Unknown', category: 'Other' };

    const xmlData = item.json.data || item.json.body || item.json;

    if (typeof xmlData !== 'string') {
      continue;
    }

    // Parse XML
    const result = await new Promise((resolve, reject) => {
      parser.parseString(xmlData, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    // Extract items from RSS or Atom format
    let feedItems = [];

    if (result.rss?.channel?.item) {
      // RSS 2.0 format
      feedItems = Array.isArray(result.rss.channel.item)
        ? result.rss.channel.item
        : [result.rss.channel.item];
    } else if (result.feed?.entry) {
      // Atom format
      feedItems = Array.isArray(result.feed.entry)
        ? result.feed.entry
        : [result.feed.entry];
    } else if (result.rdf?.item) {
      // RDF format
      feedItems = Array.isArray(result.rdf.item)
        ? result.rdf.item
        : [result.rdf.item];
    }

    for (const feedItem of feedItems) {
      const link = feedItem.link?.href || feedItem.link?._ || feedItem.link || '';
      const title = feedItem.title?._ || feedItem.title || '';
      const description = feedItem.description?._ || feedItem.description ||
                         feedItem.summary?._ || feedItem.summary ||
                         feedItem.content?._ || feedItem.content || '';
      const pubDate = feedItem.pubDate || feedItem.published ||
                     feedItem.updated || feedItem['dc:date'] || '';

      if (link && title) {
        allArticles.push({
          json: {
            url: typeof link === 'string' ? link : link[0],
            
            title: typeof title === 'string' ? title : JSON.stringify(title),
            description: typeof description === 'string'
              ? description.replace(/<[^>]*>/g, '').substring(0, 500)
              : '',
            source: sourceInfo.name,
            source_category: sourceInfo.category,
            priority: sourceInfo.priority,
            pubDate: pubDate,
            isoDate: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString()
          }
        });
      }
    }
  } catch (error) {
    console.error(`Error parsing feed: ${error.message}`);
    continue;
  }
}

console.log(`Parsed ${allArticles.length} articles from RSS feeds`);
return allArticles;
```

### Step 3.5: Alternative - Use Built-in RSS Node with Loop

#### Node: "Split RSS Sources"

| Setting | Value |
|---------|-------|
| **Node Type** | SplitInBatches |
| **Batch Size** | 1 |

#### Node: "RSS Feed Read Dynamic"

| Setting | Value |
|---------|-------|
| **Node Type** | RSS Feed Read |
| **URL** | `={{ $json.url }}` |

#### Node: "Add Source Info"

| Setting | Value |
|---------|-------|
| **Node Type** | Code |

```javascript
const sourceInfo = $('Split RSS Sources').first().json;
const articles = $input.all();

return articles.map(article => ({
  json: {
    ...article.json,
    source_name: sourceInfo.name,
    source_category: sourceInfo.category,
    source_priority: sourceInfo.priority
  }
}));
```

Then loop back to `Split RSS Sources` until all sources are processed.

### Step 3.6: Delete Old RSS Nodes

Remove these nodes:
- RSS TechCrunch AI
- RSS Hacker News AI
- RSS OpenAI
- RSS Hugging Face
- RSS Google AI Blog
- RSS r/MachineLearning
- RSS ClaudeCode
- RSS cursor
- RSS Artificialinteligence
- RSS ClaudeAI
- RSS aiagent
- Merge (9 inputs)
- Merge1
- Global merge

### Step 3.7: Update Connections

```
Send processing message
       |
Load RSS Sources (or Fetch RSS Config -> Load RSS Sources)
       |
Fetch RSS Feed
       |
Parse RSS Feed
       |
Filter Date Only (modified Filter AI Keywords & Date)
       |
Categorize & Validate
       |
... (rest of workflow)
```

### Adding New RSS Sources (After Implementation)

**Before:** Edit workflow, add node, rewire connections

**After:** Edit `rss_sources.json`, add one line:

```json
{
  "name": "New AI Blog",
  "url": "https://example.com/feed.xml",
  "category": "AI Companies",
  "active": true,
  "priority": "high"
}
```

No workflow changes needed!

---

## Priority 4: NotebookLM Podcast/Newsletter Format

Create a separate weekly workflow for digest generation.

### Step 4.1: Create New Workflow

**Name:** `VeilleIA-Weekly-Digest`

### Step 4.2: Add Schedule Trigger

| Setting | Value |
|---------|-------|
| **Node Type** | Schedule Trigger |
| **Name** | `Weekly Trigger` |
| **Rule** | Cron |
| **Cron Expression** | `0 18 * * 0` (Every Sunday at 6 PM) |

### Step 4.3: Add "Fetch Week Articles" Node

| Setting | Value |
|---------|-------|
| **Node Type** | Postgres |
| **Name** | `Fetch Week Articles` |
| **Operation** | Execute Query |

**Query:**
```sql
SELECT
  title,
  description,
  url,
  source,
  source_type,
  category,
  published_at,
  created_at
FROM rss_articles
WHERE sent_at >= NOW() - INTERVAL '7 days'
  AND sent_at IS NOT NULL
ORDER BY
  CASE
    WHEN source_type = 'Company Blogs' THEN 1
    WHEN source_type = 'Tech News' THEN 2
    WHEN source_type = 'Reddit Communities' THEN 3
    ELSE 4
  END,
  published_at DESC
LIMIT 100
```

### Step 4.4: Add "Prepare Newsletter Data" Node

| Setting | Value |
|---------|-------|
| **Node Type** | Code |
| **Name** | `Prepare Newsletter Data` |

**Code:**
```javascript
const articles = $input.all();

// Group articles by source_type
const grouped = {
  'Company Blogs': [],
  'Tech News': [],
  'Reddit Communities': [],
  'Other': []
};

for (const article of articles) {
  const type = article.json.source_type || 'Other';
  if (grouped[type]) {
    grouped[type].push(article.json);
  } else {
    grouped['Other'].push(article.json);
  }
}

// Create a structured summary for Gemini
const articleSummary = Object.entries(grouped)
  .filter(([_, items]) => items.length > 0)
  .map(([type, items]) => {
    const itemList = items.slice(0, 15).map((a, i) =>
      `${i + 1}. "${a.title}" (${a.source}) - ${a.description?.substring(0, 150) || 'No description'}`
    ).join('\n');
    return `## ${type} (${items.length} articles)\n${itemList}`;
  }).join('\n\n');

const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const weekEnd = new Date();

return [{
  json: {
    total_articles: articles.length,
    grouped: grouped,
    article_summary: articleSummary,
    week_start: weekStart.toLocaleDateString('fr-FR'),
    week_end: weekEnd.toLocaleDateString('fr-FR'),
    company_count: grouped['Company Blogs'].length,
    tech_count: grouped['Tech News'].length,
    reddit_count: grouped['Reddit Communities'].length,
    other_count: grouped['Other'].length
  }
}];
```

### Step 4.5: Add "Gemini Generate Newsletter" Node

| Setting | Value |
|---------|-------|
| **Node Type** | HTTP Request |
| **Name** | `Gemini Generate Newsletter` |
| **Method** | POST |
| **URL** | `https://generativelanguage.googleapis.com/v1beta/models/{{ $env.GEMINI_MODEL }}:generateContent` |

**Headers:**

| Header | Value |
|--------|-------|
| Content-Type | `application/json` |
| x-goog-api-key | `={{ $env.GEMINI_API_KEY }}` |

**Body:**
```javascript
={{
  JSON.stringify({
    contents: [{
      parts: [{
        text: `You are an AI tech journalist creating a weekly newsletter digest.

Week: ${$json.week_start} - ${$json.week_end}
Total Articles: ${$json.total_articles}

ARTICLES THIS WEEK:
${$json.article_summary}

Create a newsletter with:

1. **EXECUTIVE SUMMARY** (3-4 sentences)
   - What were the biggest AI developments this week?

2. **TOP 5 HIGHLIGHTS**
   - Most important announcements/releases
   - Include source and why it matters

3. **TRENDING TOPICS**
   - What themes dominated the week?
   - Any emerging patterns?

4. **COMPANY SPOTLIGHT**
   - Notable moves from major AI companies

5. **COMMUNITY BUZZ**
   - What's the developer community discussing?

6. **LOOKING AHEAD**
   - What to watch for next week

Write in an engaging, conversational tone suitable for a podcast script.
Use markdown formatting.
Keep it under 1500 words.`
      }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2000
    }
  })
}}
```

### Step 4.6: Add "Parse Newsletter" Node

| Setting | Value |
|---------|-------|
| **Node Type** | Code |
| **Name** | `Parse Newsletter` |

**Code:**
```javascript
const response = $input.first().json;
const originalData = $('Prepare Newsletter Data').first().json;

let newsletter = '';

if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
  newsletter = response.candidates[0].content.parts[0].text;
}

const weekStart = originalData.week_start;
const weekEnd = originalData.week_end;

// Create NotebookLM-friendly format (plain text with structure)
const notebookLMFormat = `
# AI Weekly Digest
## Week of ${weekStart} - ${weekEnd}

${newsletter}

---
## SOURCE ARTICLES

### Company Announcements
${originalData.grouped['Company Blogs'].slice(0, 10).map(a =>
  `- ${a.title} (${a.source})\n  ${a.url}`
).join('\n')}

### Tech News
${originalData.grouped['Tech News'].slice(0, 10).map(a =>
  `- ${a.title} (${a.source})\n  ${a.url}`
).join('\n')}

### Community Discussions
${originalData.grouped['Reddit Communities'].slice(0, 10).map(a =>
  `- ${a.title} (${a.source})\n  ${a.url}`
).join('\n')}
`;

return [{
  json: {
    newsletter_markdown: newsletter,
    notebooklm_format: notebookLMFormat,
    week_start: weekStart,
    week_end: weekEnd,
    stats: {
      total: originalData.total_articles,
      companies: originalData.company_count,
      tech: originalData.tech_count,
      reddit: originalData.reddit_count
    }
  }
}];
```

### Step 4.7: Add "Send to Discord" Node

| Setting | Value |
|---------|-------|
| **Node Type** | HTTP Request |
| **Name** | `Send Weekly Newsletter` |
| **Method** | POST |
| **URL** | `={{ $env.DISCORD_WEBHOOK_URL }}` |

**Body:**
```javascript
={{
  JSON.stringify({
    content: `Weekly AI Digest - ${$json.week_start} to ${$json.week_end}\n\n` +
             `Stats: ${$json.stats.total} articles | ` +
             `${$json.stats.companies} Company | ` +
             `${$json.stats.tech} Tech | ` +
             `${$json.stats.reddit} Reddit\n\n`,
    embeds: [{
      title: "Full Newsletter",
      description: $json.newsletter_markdown.substring(0, 4000),
      color: 5814783
    }]
  })
}}
```

### Step 4.8: Add "Save to File" Node (For NotebookLM)

Add a Code node to convert text to binary:

**Code (Convert to Binary):**
```javascript
const data = $input.first().json;
const content = data.notebooklm_format;

// Convert string to binary
const binaryData = Buffer.from(content, 'utf-8');

return [{
  json: data,
  binary: {
    data: {
      data: binaryData.toString('base64'),
      mimeType: 'text/markdown',
      fileName: `newsletter_${data.week_start.replace(/\//g, '-')}.md`
    }
  }
}];
```

Then add Write Binary File node:

| Setting | Value |
|---------|-------|
| **Node Type** | Write Binary File |
| **Name** | `Save Newsletter File` |
| **File Name** | `=newsletter_${$json.week_start.replace(/\//g, '-')}.md` |
| **Property Name** | `data` |

### Step 4.9: Optional - Upload to Google Drive

| Setting | Value |
|---------|-------|
| **Node Type** | Google Drive |
| **Name** | `Upload to Drive` |
| **Operation** | Upload |
| **Binary Property** | `data` |
| **Folder ID** | Your Google Drive folder ID |

### Weekly Digest Flow Diagram

```
Weekly Trigger (Sunday 6PM)
       |
Fetch Week Articles (PostgreSQL)
       |
Prepare Newsletter Data
       |
Gemini Generate Newsletter
       |
Parse Newsletter
       |
   +---+---+
   |       |
Discord   Save to File / Google Drive
         (for NotebookLM import)
```

---

## Priority 5: Google Search Page Style Output

### Add "Format Google Style" Node

| Setting | Value |
|---------|-------|
| **Node Type** | Code |
| **Name** | `Format Google Style` |

**Code (Single Embed with All Results):**
```javascript
const items = $input.all();

if (items.length === 0) {
  return [];
}

const now = new Date();
const dateStr = now.toLocaleDateString('fr-FR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

// Function to extract domain from URL
function getDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace('www.', '');
  } catch {
    return 'unknown';
  }
}

// Function to create breadcrumb-style URL display
function formatUrl(url) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.split('/').filter(p => p).slice(0, 2).join(' > ');
    return `${urlObj.hostname.replace('www.', '')}${path ? ' > ' + path : ''}`;
  } catch {
    return url.substring(0, 50);
  }
}

// Function to clean HTML and truncate description
function cleanDescription(desc) {
  if (!desc) return 'No description available.';
  return desc
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 200) + (desc.length > 200 ? '...' : '');
}

// Build Google-style search results
const results = items.slice(0, 10).map((item, index) => {
  const data = item.json;
  const domain = getDomain(data.url);
  const urlDisplay = formatUrl(data.url);
  const description = cleanDescription(data.description || data.ai_summary);

  // Calculate relative time
  const pubDate = new Date(data.published_at);
  const hoursAgo = Math.floor((Date.now() - pubDate.getTime()) / (1000 * 60 * 60));
  const timeAgo = hoursAgo < 24
    ? `${hoursAgo}h ago`
    : `${Math.floor(hoursAgo / 24)}d ago`;

  return {
    title: data.title.substring(0, 100),
    url: data.url,
    urlDisplay: urlDisplay,
    description: description,
    source: data.source,
    category: data.category,
    score: data.gemini_score || 0,
    timeAgo: timeAgo,
    domain: domain
  };
});

// Create Discord message with Google-style formatting
let description = '';

results.forEach((result, index) => {
  // Score indicator
  const scoreEmoji = result.score >= 80 ? '🔥' :
                     result.score >= 60 ? '⭐' :
                     result.score >= 40 ? '📰' : '📄';

  description += `**${index + 1}. [${result.title}](${result.url})**\n`;
  description += `\`${result.urlDisplay}\` - ${result.timeAgo}\n`;
  description += `${result.description}\n`;
  description += `${scoreEmoji} Score: ${result.score} | ${result.category}\n\n`;
});

// Truncate if too long for Discord (6000 char limit for embeds)
if (description.length > 3900) {
  description = description.substring(0, 3900) + '\n\n*... more results truncated*';
}

return [{
  json: {
    content: `🔍 **AI News Search Results** - ${items.length} articles found\n📅 ${dateStr}\n`,
    embeds: [{
      description: description,
      color: 4437377, // Google blue
      footer: {
        text: `Showing ${results.length} of ${items.length} results - Sorted by AI relevance score`
      }
    }]
  }
}];
```

### Alternative: Individual Embeds (More Visual)

```javascript
const items = $input.all();

if (items.length === 0) {
  return [];
}

const now = new Date();
const dateStr = now.toLocaleDateString('fr-FR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric'
});

function getDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return 'unknown';
  }
}

function formatUrl(url) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.split('/').filter(p => p).slice(0, 2).join(' > ');
    return `${urlObj.hostname.replace('www.', '')}${path ? ' > ' + path : ''}`;
  } catch {
    return url.substring(0, 60);
  }
}

function cleanDescription(desc) {
  if (!desc) return 'No description available.';
  return desc
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 180) + (desc.length > 180 ? '...' : '');
}

// Create embeds that mimic Google search results
const embeds = items.slice(0, 8).map((item, index) => {
  const data = item.json;
  const urlDisplay = formatUrl(data.url);
  const description = cleanDescription(data.description || data.ai_summary);

  const pubDate = new Date(data.published_at);
  const hoursAgo = Math.floor((Date.now() - pubDate.getTime()) / (1000 * 60 * 60));
  const timeAgo = hoursAgo < 24 ? `${hoursAgo}h` : `${Math.floor(hoursAgo / 24)}d`;

  const score = data.gemini_score || 0;
  const scoreBar = '█'.repeat(Math.floor(score / 20)) + '░'.repeat(5 - Math.floor(score / 20));

  return {
    title: data.title.substring(0, 100),
    url: data.url,
    description: `\`📍 ${urlDisplay}\`\n\n${description}\n\n` +
                 `${data.category} - ${data.source} - ${timeAgo} ago\n` +
                 `Score: ${scoreBar} ${score}/100`,
    color: index === 0 ? 5814783 : 9807270, // First result highlighted
  };
});

return [{
  json: {
    content: `🔍 **AI Search Results** - ${items.length} articles\n📅 ${dateStr}`,
    embeds: embeds
  }
}];
```

### Integration Options

#### Option A: Add as New Discord Channel

1. Add to `.env`: `DISCORD_WEBHOOK_SEARCH=your_webhook_url`
2. Add to docker-compose.yml env whitelist
3. Add new branch after `Parse Score`:

```
Parse Score
    |
Preserve Data
    |
    +-- Filter Tech News -> ... -> Send Tech News
    +-- Filter Companies -> ... -> Send Companies
    +-- Filter Reddit -> ... -> Send Reddit
    +-- [NEW] Format Google Style -> Send Search Style
```

#### Option B: Replace Existing Format

Replace one of your existing format nodes with the Google style.

#### Option C: Discord Command Selection

Add parameter to Discord trigger for format selection:

- `@bot veille` -> Default embeds
- `@bot veille search` -> Google search style
- `@bot veille compact` -> Compact list

Add Switch node after Discord trigger to route based on message content.

### Visual Comparison

**Current Format (Rich Embeds):**
```
+------------------------------------------+
| 🔥 🧠 LLM | Claude 3.5 Sonnet Released   |
|                                          |
| 📝 AI Summary: Anthropic released...     |
| 💡 Key Takeaway: Faster and cheaper...   |
| Score: 95/100 - Major release...         |
|                                          |
| 📍 anthropic.com | ⏰ 2h ago             |
+------------------------------------------+
```

**Google Search Style:**
```
🔍 AI Search Results - 25 articles

1. Claude 3.5 Sonnet Released
   anthropic.com > news > releases - 2h ago
   Anthropic released the new Claude 3.5 Sonnet model
   with improved performance and lower costs...
   🔥 Score: 95 | 🧠 LLM

2. GPT-5 Rumors Surface Online
   techcrunch.com > ai > openai - 5h ago
   New leaks suggest OpenAI is preparing...
   ⭐ Score: 72 | 🧠 LLM
```

---

## Priority 6: Redis Lock for Concurrent Execution Prevention

### Overview

Prevent multiple workflow executions from running simultaneously using Redis atomic locks.

**Problem:** When multiple users ping the bot, each triggers a separate workflow execution. Without locking, they all run in parallel, wasting resources.

**Solution:** Use Redis `SET NX EX` (atomic "set if not exists" with expiry) to acquire a lock before execution.

### Step 6.1: Docker Services (Already Added)

Redis and Webdis are added to `docker-compose.yml`. Restart services:

```bash
docker compose up -d
```

Test Redis:
```bash
curl http://localhost:7379/PING
# Returns: {"PING":"PONG"}
```

### Step 6.2: Add "Acquire Lock" Node

**Position:** Right after `Discord Bot mention` trigger

| Setting | Value |
|---------|-------|
| **Node Type** | HTTP Request |
| **Name** | `Acquire Lock` |
| **Method** | GET |
| **URL** | `http://webdis:7379/SET/veille_lock/{{ Date.now() }}/NX/EX/300` |

**Note:**
- Key uses underscores (`veille_lock`) not colons (avoids URL encoding issues)
- Value is timestamp from `Date.now()` (for debugging which execution holds lock)
- `NX` = only set if Not eXists (atomic lock)
- `EX/300` = expires after 300 seconds (5 min safety timeout)

**Response:**
- `{"SET":"OK"}` → Lock acquired successfully
- `{"SET":null}` → Another execution already has the lock

### Step 6.3: Add "Check Lock Result" Node

**Position:** After `Acquire Lock`

| Setting | Value |
|---------|-------|
| **Node Type** | If |
| **Name** | `Check Lock Result` |

**Condition:**

Webdis returns an array: `[true, "OK"]` on success, `[false, null]` on failure.

- **Value 1:** `{{ $json.SET[0] }}`
- **Operation:** `equals`
- **Value 2:** `true`

**Alternative (check string value):**
- **Value 1:** `{{ $json.SET[1] }}`
- **Operation:** `equals`
- **Value 2:** `OK`

### Step 6.4: False Branch - Already Running

#### Node: "Send Already Running"

| Setting | Value |
|---------|-------|
| **Node Type** | HTTP Request |
| **Name** | `Send Already Running` |
| **Method** | POST |
| **URL** | `https://discord.com/api/v10/channels/{{ $('Discord Bot mention').item.json.channelId }}/messages` |

**Headers:**

| Header | Value |
|--------|-------|
| Authorization | `Bot {{ $env.DISCORD_BOT_TOKEN }}` |
| Content-Type | `application/json` |

**Body:**
```json
{
  "content": "⏳ <@{{ $('Discord Bot mention').item.json.authorId }}> Workflow already running, please wait...",
  "message_reference": {
    "message_id": "{{ $('Discord Bot mention').item.json.id }}"
  }
}
```

#### Node: "Wait 5s"

| Setting | Value |
|---------|-------|
| **Node Type** | Wait |
| **Name** | `Wait 5s` |
| **Wait Time** | 5 seconds |

#### Node: "Delete Already Running Msg"

| Setting | Value |
|---------|-------|
| **Node Type** | HTTP Request |
| **Name** | `Delete Already Running Msg` |
| **Method** | DELETE |
| **URL** | `https://discord.com/api/v10/channels/{{ $json.channel_id }}/messages/{{ $json.id }}` |

**Note:** `$json.channel_id` and `$json.id` come from the `Send Already Running` response (Discord returns the created message).

**Headers:**

| Header | Value |
|--------|-------|
| Authorization | `Bot {{ $env.DISCORD_BOT_TOKEN }}` |

**→ This branch ends here (no further connections)**

### Step 6.5: True Branch - Continue Workflow

Connect `Check Lock Result` TRUE output to `Send processing message` and continue with the normal workflow.

### Step 6.6: Add "Release Lock" Node

**Position:** At the END of workflow, after all Discord messages sent, BEFORE `Delete processing message`

| Setting | Value |
|---------|-------|
| **Node Type** | HTTP Request |
| **Name** | `Release Lock` |
| **Method** | GET |
| **URL** | `http://webdis:7379/DEL/veille_lock` |

**Options:**
- **Continue On Fail:** Enable (workflow continues even if Redis fails)
- **Execute Once:** Enable (only release once, not per item)

**Connection in Current Workflow:**

Your workflow already has `Get bot info message data` node that collects from all 4 Format branches. Connect like this:

```
Format Tech News ──→ Send Tech News ──────┐
Format Companies ─→ Send Companies ───────┤
Format Reddit ────→ Send Reddit ──────────┼─→ Get bot info message data
Format Other ─────→ Send Others ──────────┘            |
                                                       v
                                               Release Lock (NEW)
                                                       |
                                                       v
                                          DELETE processing message
```

### Step 6.7: Updated Flow Diagram

```
Discord Bot mention
       |
Acquire Lock (HTTP -> Webdis SET NX EX)
       |
Check Lock Result (If)
       |
   +---+-------------------+
   |                       |
TRUE (OK)              FALSE (null)
   |                       |
   v                       v
Send Processing      Send Already Running
   |                       |
... workflow ...         Wait 5s
   |                       |
Format & Send        Delete Already Running Msg
   |                       |
Release Lock             [END]
   |
Delete Processing Msg
   |
 [END]
```

### Step 6.8: Step-by-Step Execution Sequence

#### TRUE Branch (Lock Acquired - Normal Execution):

```
1.  Discord Bot mention          → Trigger
2.  Acquire Lock                 → 🔒 LOCK (SET NX EX 300)
3.  Check Lock Result            → TRUE (got "OK")
4.  Send Processing Message      → "Processing your request..."
5.  RSS Fetch (all sources)      → Collect articles
6.  Filter & Categorize          → Process articles
7.  Check Duplicates (DB)        → Remove seen articles
8.  Gemini Score                 → AI scoring
9.  Filter by source_type        → Split to 4 branches
10. Gemini Summarize (x4)        → Generate summaries
11. Format Messages (x4)         → Create Discord embeds
12. Send to Discord (x4)         → Post to channels
13. Release Lock                 → 🔓 UNLOCK (DEL key)
14. Delete Processing Message    → Cleanup
15. [END]
```

#### FALSE Branch (Lock Denied - Rejected):

```
1.  Discord Bot mention          → Trigger
2.  Acquire Lock                 → Lock attempt
3.  Check Lock Result            → FALSE (got "null")
4.  Send Already Running         → "Workflow already running..."
5.  Wait 5s                      → Pause
6.  Delete Already Running Msg   → Cleanup
7.  [END]                        → No unlock needed (never had lock)
```

### Redis Commands Reference

| Command | Purpose |
|---------|---------|
| `SET key value NX EX 300` | Acquire lock (atomic, expires in 5min) |
| `DEL key` | Release lock |
| `GET key` | Check who has lock |
| `TTL key` | Check remaining lock time |

### Testing

```bash
# Acquire lock manually
curl "http://localhost:7379/SET/veille_lock/test123/NX/EX/300"
# Returns: {"SET":"OK"}

# Try again (should fail)
curl "http://localhost:7379/SET/veille_lock/test456/NX/EX/300"
# Returns: {"SET":null}

# Check lock holder
curl "http://localhost:7379/GET/veille_lock"
# Returns: {"GET":"test123"}

# Release lock
curl "http://localhost:7379/DEL/veille_lock"
# Returns: {"DEL":1}
```

---

## Summary

### Recommended Implementation Order

```
1. Priority 6 (Redis Lock)       <- Do this FIRST to prevent concurrent issues
2. Priority 1 (Duplicate Filter) <- Immediate token savings
3. Priority 3 (Single RSS Node)  <- Clean up workflow
4. Priority 2 (AI Filtering)     <- Better filtering quality
5. Priority 5 (Google Style)     <- Quick win, visual improvement
6. Priority 4 (Weekly Digest)    <- New separate workflow
```

### New Optimized Workflow Flow

```
Discord Bot Trigger
       |
+--------------------------------------------------------------+
| NEW: Acquire Lock (Redis via Webdis)                         |
|      |                                                       |
| NEW: Check Lock Result (If)                                  |
|      |                                                       |
|   TRUE -> Continue          FALSE -> Send "Already Running"  |
|      |                              -> Wait 5s -> Delete     |
+--------------------------------------------------------------+
       |
Send Processing Message
       |
+--------------------------------------------------------------+
| NEW: Load RSS Sources (reads rss_sources.json)               |
|      |                                                       |
| NEW: Fetch RSS Feed (dynamic URL loop)                       |
|      |                                                       |
| NEW: Parse RSS Feed                                          |
+--------------------------------------------------------------+
       |
Filter by Date Only (simplified)
       |
Categorize & Validate
       |
+--------------------------------------------------------------+
| NEW: Collect URLs for DB Check                               |
|      |                                                       |
| NEW: Check Existing in DB (PostgreSQL)                       |
|      |                                                       |
| NEW: Filter New Articles Only <- SAVES TOKENS HERE           |
+--------------------------------------------------------------+
       |
Escape SQL Values
       |
Gemini Score + Filter (combined) <- Only scores NEW articles
       |
Parse Score (filters irrelevant)
       |
Insert to Database + Branch by source_type
       |
   +-------+-------+-------+---------------+
   |       |       |       |               |
Tech    Companies Reddit  Other    NEW: Google Style
News                                      |
   +-------+-------+-------+---------------+
                    |
              Discord Webhooks
                    |
+--------------------------------------------------------------+
| NEW: Release Lock (Redis DEL)                                |
+--------------------------------------------------------------+
                    |
         Delete Processing Message
```

### Files to Update

| File | Changes |
|------|---------|
| `docker-compose.yml` | Added Redis + Webdis services, mount `rss_sources.json` in n8n volume |
| `rss_sources.json` | Already exists, used by dynamic RSS loader |
| `.env` | Add `DISCORD_WEBHOOK_SEARCH` if using Google style channel |

No database changes required - all queries are done directly in n8n Postgres nodes.
