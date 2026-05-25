/**
 * CAMPAIGN VALIDATOR WORKER — Bluesky 5-Star Doctrine Enforcement
 * Validates campaign posts against R1-R13 (see BSKY_5STAR_DOCTRINE.md).
 * Generates proper facets array for posting.
 * Smart Emoji Engine: context-aware emoji selection with anti-repeat memory.
 *
 * Bindings: KV (validator-kv), VALIDATOR_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_PETE_ID
 *
 * Endpoints:
 *   GET  /health      — alive
 *   POST /validate    — validate a campaign payload, returns rating + violations + fixes
 *   POST /facetize    — generate facets array for a single post (text → posting-ready)
 *   POST /smartemoji  — pick context-aware emoji for a post (used by drafters)
 *   GET  /doctrine    — return current doctrine version + rule summary
 */

const DOCTRINE_VERSION = "1.1.0";

// ─── SMART EMOJI ENGINE ────────────────────────────────────────────────────
const EMOJI_RULES = {
  // HARD OVERRIDES — non-negotiable
  hard: [
    { match: /\b(BREAKING\s*NEWS|BREAKING)\b/i, emoji: '🟥', reason: 'BREAKING → red square (never 🚨)' },
    { match: /\b(LIVE|HAPPENING\s*NOW)\b/i, emoji: '🔴', reason: 'LIVE → red circle' },
  ],

  // CONTEXT-SCORED CANDIDATES — pick #2 or #3 for artistic variation
  // Format: { keywords: regex, candidates: [emoji ranked by strict relevance] }
  contextual: [
    { keywords: /\b(thread|continued|more below|keep reading)\b/i,
      candidates: ['🧵', '📜', '👇', '🔽'] },
    { keywords: /\b(war|conflict|combat|battle|military|strike|drone|missile)\b/i,
      candidates: ['⚔️', '🛡️', '💥', '🎯'] },
    { keywords: /\b(ukraine|russia|moscow|kremlin|kyiv|zelensky|putin)\b/i,
      candidates: ['🇺🇦', '🛡️', '⚔️', '🌻'] },
    { keywords: /\b(money|finance|stock|market|invest|wealth|billion|trillion|trade)\b/i,
      candidates: ['💰', '📈', '💸', '🏦'] },
    { keywords: /\b(bitcoin|btc|crypto|blockchain|satoshi)\b/i,
      candidates: ['₿', '🟧', '⛏️', '🔗'] },
    { keywords: /\b(code|coding|developer|github|software|bug|fix|deploy)\b/i,
      candidates: ['💻', '⌨️', '🛠️', '🔧'] },
    { keywords: /\b(ai|artificial intelligence|llm|gpt|claude|gemini|model)\b/i,
      candidates: ['🤖', '🧠', '⚙️', '🔮'] },
    { keywords: /\b(ice|deport|immigrant|border|raid|asylum|refugee)\b/i,
      candidates: ['🚫', '⚖️', '🗽', '🛑'] },
    { keywords: /\b(surveillance|spy|watch|monitor|track|palantir|peter\s*thiel)\b/i,
      candidates: ['👁️', '🔍', '📡', '🕵️'] },
    { keywords: /\b(protest|march|rally|strike|union|workers|may\s*day)\b/i,
      candidates: ['✊', '📢', '🪧', '🗣️'] },
    { keywords: /\b(election|vote|democracy|democrat|republican|congress|senate)\b/i,
      candidates: ['🗳️', '🏛️', '⚖️', '📊'] },
    { keywords: /\b(climate|environment|fossil|oil|energy|fracking|emissions)\b/i,
      candidates: ['🌍', '🛢️', '⚡', '🌿'] },
    { keywords: /\b(music|song|reggae|album|festival|concert)\b/i,
      candidates: ['🎵', '🎶', '🎸', '🎙️'] },
    { keywords: /\b(art|artist|paint|design|gallery|creative)\b/i,
      candidates: ['🎨', '🖌️', '🖼️', '✨'] },
    { keywords: /\b(new\s*york|nyc|brooklyn|manhattan|bronx|queens|staten)\b/i,
      candidates: ['🗽', '🌆', '🚕', '🏙️'] },
    { keywords: /\b(corrupt|fraud|scandal|lie|coverup|leak|whistleblow)\b/i,
      candidates: ['🚩', '📂', '🔓', '⚠️'] },
    { keywords: /\b(palestine|gaza|israel|west\s*bank|hamas|idf)\b/i,
      candidates: ['🕊️', '⚖️', '🍉', '🛑'] },
  ],

  // DEFAULT ROTATION POOL — used when no contextual match
  defaultPool: ['🧵', '👇', '👀', '🔽', '👉', '⤵️', '📜', '✨'],
};

async function pickSmartEmoji(env, text, campaignId, position) {
  // Position: 'p0' (root) or 'cta' (final reply)
  // 1. Check hard overrides
  for (const rule of EMOJI_RULES.hard) {
    if (rule.match.test(text)) {
      return { emoji: rule.emoji, reason: rule.reason, source: 'hard_override' };
    }
  }

  // 2. Score contextual candidates
  const matches = [];
  for (const rule of EMOJI_RULES.contextual) {
    if (rule.keywords.test(text)) {
      matches.push(...rule.candidates);
    }
  }

  // 3. Get anti-repeat history from KV
  let recent = [];
  try {
    const h = await env.KV.get('emoji_recent_' + (position || 'any'));
    if (h) recent = JSON.parse(h);
  } catch (_) {}

  // 4. Pick: prefer 2nd or 3rd choice (artistic), filter recent, fallback to default
  let pool = matches.length ? [...matches] : [...EMOJI_RULES.defaultPool];
  const fresh = pool.filter(e => !recent.includes(e));
  const finalPool = fresh.length ? fresh : pool;

  // Artistic preference: skip the #1 most-obvious choice if there are 3+ candidates
  let pick;
  if (matches.length >= 3) {
    // Pick from 2nd-3rd-4th
    pick = finalPool[Math.min(1 + Math.floor(Math.random() * 2), finalPool.length - 1)];
  } else {
    pick = finalPool[Math.floor(Math.random() * finalPool.length)];
  }

  // 5. Update anti-repeat history (last 5)
  const newRecent = [pick, ...recent].slice(0, 5);
  await env.KV.put('emoji_recent_' + (position || 'any'), JSON.stringify(newRecent), { expirationTtl: 86400 * 7 });

  return {
    emoji: pick,
    reason: matches.length ? `contextual match (${matches.length} candidates, picked artistic variant)` : 'default rotation pool',
    source: matches.length ? 'contextual' : 'default',
    candidates_considered: pool.length,
  };
}

// ─── FACET GENERATION ──────────────────────────────────────────────────────
// Bluesky facets need byteStart/byteEnd in UTF-8 byte offsets, not char offsets.
function utf8ByteLength(str) {
  return new TextEncoder().encode(str).length;
}

function generateFacets(text) {
  const facets = [];
  const enc = new TextEncoder();

  // 1. Hashtags: #PascalCase or #lowercase, 3-30 chars, must start with letter
  const hashtagRe = /#([A-Za-z][A-Za-z0-9_]{2,29})\b/g;
  let m;
  while ((m = hashtagRe.exec(text)) !== null) {
    const byteStart = utf8ByteLength(text.slice(0, m.index));
    const byteEnd   = byteStart + utf8ByteLength(m[0]);
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[1] }],
    });
  }

  // 2. URLs (http/https + common bare domains)
  const urlRe = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)\b/gi;
  while ((m = urlRe.exec(text)) !== null) {
    let url = m[1];
    // Skip if this match is inside a hashtag region (already faceted)
    const inHashtag = facets.some(f =>
      m.index >= text.slice(0, f.index.byteStart).length &&
      m.index <  text.slice(0, f.index.byteEnd).length
    );
    if (inHashtag) continue;
    // Skip pure dotted things that aren't really URLs (e.g. "1.500 km")
    if (/^\d/.test(url)) continue;
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;
    const byteStart = utf8ByteLength(text.slice(0, m.index));
    const byteEnd   = byteStart + utf8ByteLength(url);
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: fullUrl }],
    });
  }

  // 3. Mentions @handle.bsky.social or @something.tld — links to the profile URL
  const mentionRe = /@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
  while ((m = mentionRe.exec(text)) !== null) {
    const byteStart = utf8ByteLength(text.slice(0, m.index));
    const byteEnd   = byteStart + utf8ByteLength(m[0]);
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://bsky.app/profile/' + m[1] }],
    });
  }

  // Sort by byteStart for cleanliness
  facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
  return facets;
}

// ─── VALIDATION ────────────────────────────────────────────────────────────
function utf16Length(s) {
  // Bluesky counts UTF-16 code units (JS string length)
  return s.length;
}

// Rule 13 v2 helpers (May 23, 2026)
function isParallelLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('\u2022')) return 'bullet';
  if (/^[\u2014\u2013-]\s/.test(t)) return 'dash';
  if (/^\d+[).]\s/.test(t)) return 'numbered';
  if (/^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)|Last\s+\w+|Next\s+\w+|This\s+\w+|\d+\s+(?:wks?|weeks?|days?|hrs?|hours?|mins?|months?|yrs?|years?)\s+ago|Yesterday|Today|Tomorrow|Now)\b[^:\n]{0,30}:/i.test(t)) return 'date';
  if (/^(?:Per\s+)?[A-Z][A-Za-z0-9&. ]{1,30}(?:\s*\([^)]{1,40}\))?\s*[:,]/.test(t) && t.length < 200) return 'source';
  return false;
}

function checkR13(text, opts) {
  opts = opts || {};
  if (!text || typeof text !== 'string') return [];
  const lines = text.split('\n');
  const blanks = lines.filter(l => l.trim() === '').length;
  const ratio = lines.length > 0 ? blanks / lines.length : 0;
  const violations = [];
  if (/\n{3,}/.test(text)) violations.push({ rule: 'R13.8', msg: '3+ consecutive newlines — collapse to max 2' });
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i + 1].trim() === '') {
      const p = isParallelLine(lines[i]);
      const n = isParallelLine(lines[i + 2]);
      if (p && n) {
        violations.push({ rule: 'R13', msg: `Blank line between parallel ${p} lines (stack them tight)` });
        break;
      }
    }
  }
  if (lines.length <= 9 && blanks > 4) {
    violations.push({ rule: 'R13.7', msg: `${blanks} blanks in ${lines.length}-line post (max 4)` });
  }
  if (lines.length > 9 && lines.length <= 15 && blanks > 5) {
    violations.push({ rule: 'R13.7', msg: `${blanks} blanks in ${lines.length}-line post (max 5)` });
  }
  if (ratio > (opts.isP0 ? 0.50 : 0.45)) {
    violations.push({ rule: 'R13.7', msg: `blank_ratio ${ratio.toFixed(2)} exceeds ${opts.isP0 ? 0.50 : 0.45}` });
  }
  return violations;
}

function validatePost(text, options = {}) {
  const violations = [];
  const warnings = [];
  const isP0 = !!options.isP0;
  const isFinal = !!options.isFinal;
  const charBudget = utf16Length(text);

  // R8: Char budget
  if (charBudget > 300) violations.push({ rule: 'R8', msg: `Post exceeds Bluesky max (${charBudget}/300)` });
  else if (charBudget > 295) warnings.push({ rule: 'R8', msg: `Post is close to cap (${charBudget}/295 target)` });
  else if (charBudget < 100 && !isFinal) warnings.push({ rule: 'R8', msg: `Post is short (${charBudget} chars) — may feel thin` });

  // R1: Every post needs hashtags
  const hashtagMatches = text.match(/#([A-Za-z][A-Za-z0-9_]{2,29})/g) || [];
  const hashtagsRaw = text.match(/#\S+/g) || [];
  if (hashtagsRaw.length === 0) {
    violations.push({ rule: 'R1', msg: 'No hashtags found — every post needs 2-3 clickable tags' });
  } else if (hashtagMatches.length < 2 && !isFinal) {
    warnings.push({ rule: 'R1', msg: `Only ${hashtagMatches.length} clean hashtag — recommend 2-3` });
  }

  // R2: No emoji-glued hashtags / no banned hashtag formats
  for (const raw of hashtagsRaw) {
    // Check if a hashtag has anything other than #[A-Za-z0-9_]
    const cleanMatch = raw.match(/^#[A-Za-z][A-Za-z0-9_]{2,29}$/);
    if (!cleanMatch) {
      violations.push({ rule: 'R2', msg: `Hashtag "${raw}" is malformed (emoji/symbol contamination or wrong format)` });
    }
    // All-caps shouty check (with brand exemptions)
    const tagBody = raw.replace(/^#/, '');
    const BRAND_EXEMPT = ['OSINT', 'NYC', 'FBI', 'CIA', 'DOJ', 'ICE', 'ATF', 'NSA', 'DEA', 'TSA', 'IRS', 'GOP', 'DOD', 'DHS', 'USA', 'UK', 'EU', 'UN', 'WHO', 'NATO', 'BLM', 'LGBTQ', 'AI', 'BTC', 'NFT', 'API', 'CEO', 'CFO', 'GDP', 'PTSD'];
    if (tagBody.length >= 4 && tagBody === tagBody.toUpperCase() && /[A-Z]/.test(tagBody) && !BRAND_EXEMPT.includes(tagBody)) {
      warnings.push({ rule: 'R2', msg: `Hashtag "${raw}" is ALL-CAPS — prefer PascalCase (e.g. #SlavaUkraini not #SLAVAUKRAINI)` });
    }
  }

  // R12: BANNED EMOJI — 🚨 is permanently forbidden per Pete's law (2026-05-19). Use 🟥 instead.
  if (text.includes('\u{1F6A8}')) {
    violations.push({ rule: 'R12', msg: 'BANNED EMOJI 🚨 detected — Pete\'s permanent law: use 🟥 (red square) for breaking news. Auto-replace before posting.' });
  }

  // R14 (May 24 2026): NO ARBITRARY LINKS — block-level. Only dsc.gg/Indica is whitelisted.
  // No URL/domain/hostname in any post unless explicitly approved by Pete via options.approvedLinks.
  const URL_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.){1,}(?:app|com|net|org|io|uk|gg|xyz|info|news|co|me|ai|dev|tech|tv)(?:\/[^\s)]*)?/gi;
  const WHITELIST = ['dsc.gg/indica', 'discord.gg/'];
  const approvedLinks = (options.approvedLinks || []).map(l => l.toLowerCase());
  const matchedUrls = text.match(URL_RE) || [];
  for (const url of matchedUrls) {
    const lower = url.toLowerCase();
    const isWhitelisted = WHITELIST.some(w => lower.includes(w));
    const isApproved = approvedLinks.some(a => lower.includes(a));
    // Skip @-handles inadvertently matched (rare but possible if handle ends in .com etc.)
    const idx = text.indexOf(url);
    if (idx > 0 && text[idx - 1] === '@') continue;
    if (!isWhitelisted && !isApproved) {
      violations.push({ rule: 'R14', msg: `Arbitrary link "${url}" — not in whitelist (only dsc.gg/Indica permitted unless Pete pre-approves)` });
    }
  }

  // R4: Multi-line bullet detection — find "• X:\n  Y" patterns
  const multiLineBullet = /•[^\n]*:\s*\n\s+\S/;
  if (multiLineBullet.test(text)) {
    violations.push({ rule: 'R4', msg: 'Multi-line bullet detected — use single-line em-dash style: "• Source — punchy fact"' });
  }

  // R5: P0 should end with a thread continuation signal
  // SKIP entirely if post_mode === 'single' (single posts don't continue)
  const isSinglePost = options.postMode === 'single';
  if (isP0 && !isSinglePost) {
    // R5 v3 (May 24 2026 — patched): also exclude [image:] tag lines, fall back to whole-body scan
    const threadSignals = ['🧵', '🪡', '⛓️', '👇', '📜', '🪵', '🟥']; // 6-pool + 🟥 breaking carry-through
    const bodyLines = text.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('[image:'));
    const lastBodyLine = bodyLines[bodyLines.length - 1] || '';
    // Primary: last non-hashtag non-image line. Fallback: any line in the body has a signal.
    const hasSignal = threadSignals.some(e => lastBodyLine.includes(e)) ||
                      threadSignals.some(e => bodyLines.some(l => l.includes(e)));
    if (!hasSignal) {
      warnings.push({ rule: 'R5', msg: 'P0 missing thread continuation emoji — pick one from pool: 🧵 🪡 ⛓️ 👇 📜 🪵 (see smart_emoji_engine.md)' });
    }
  }

  // R6: Final post should have Discord CTA
  // SKIP if single post mode
  if (isFinal && !isSinglePost) {
    if (!/dsc\.gg\/Indica|discord\.gg\//i.test(text)) {
      warnings.push({ rule: 'R6', msg: 'Final reply missing Discord CTA (dsc.gg/Indica)' });
    }
  }

  // R13 v2: Editorial spacing check (May 23 2026)
  const r13violations = checkR13(text, { isP0 });
  for (const v of r13violations) violations.push(v);

  return { violations, warnings, charBudget };
}

function validateCampaign(posts, campaignOptions = {}) {
  const results = [];
  const allTagsUsed = new Map();  // tag → count
  const tagSetsByPost = [];
  const { approvedLinks = [], postMode = 'campaign' } = campaignOptions;

  for (let i = 0; i < posts.length; i++) {
    const isP0 = i === 0;
    const isFinal = i === posts.length - 1;
    const result = validatePost(posts[i].text, { isP0, isFinal, approvedLinks, postMode });
    result.postIndex = i;
    results.push(result);

    // Track tags
    const tags = (posts[i].text.match(/#([A-Za-z][A-Za-z0-9_]{2,29})/g) || []).map(t => t.toLowerCase());
    const tagSet = tags.slice().sort().join(',');
    tagSetsByPost.push(tagSet);
    for (const t of tags) allTagsUsed.set(t, (allTagsUsed.get(t) || 0) + 1);
  }

  // R3: Hashtag rotation check
  const uniqueTagSets = new Set(tagSetsByPost.filter(s => s));
  const totalUniqueTags = allTagsUsed.size;
  const campaignViolations = [];
  if (posts.length >= 4 && totalUniqueTags < 4) {
    campaignViolations.push({ rule: 'R3', msg: `Only ${totalUniqueTags} unique hashtags across ${posts.length} posts — need 4-7 rotating tags` });
  }
  // Duplicate tag-set check
  const tagSetCounts = {};
  tagSetsByPost.forEach(s => { if (s) tagSetCounts[s] = (tagSetCounts[s] || 0) + 1; });
  for (const [set, count] of Object.entries(tagSetCounts)) {
    if (count > 2) {
      campaignViolations.push({ rule: 'R3', msg: `Tag set [${set}] used on ${count} posts — rotate more` });
    }
  }

  // Compute star rating
  const totalViolations = results.reduce((sum, r) => sum + r.violations.length, 0) + campaignViolations.length;
  const totalWarnings   = results.reduce((sum, r) => sum + r.warnings.length, 0);
  // 5.0 stars perfect, each violation -0.5, each warning -0.15
  let stars = 5.0 - (totalViolations * 0.5) - (totalWarnings * 0.15);
  stars = Math.max(0, Math.min(5, stars));

  return {
    stars: Math.round(stars * 10) / 10,
    passing: totalViolations === 0 && stars >= 4.5,
    blocked: totalViolations > 0 || stars < 4.5,
    perPost: results,
    campaignViolations,
    summary: {
      totalPosts: posts.length,
      totalViolations,
      totalWarnings,
      uniqueHashtags: totalUniqueTags,
      uniqueTagSets: uniqueTagSets.size,
    }
  };
}

// ─── ROUTES ────────────────────────────────────────────────────────────────
function json(d, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function authOk(req, env) {
  return req.headers.get('Authorization') === `Bearer ${env.VALIDATOR_SECRET}`;
}

async function notifyPete(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_PETE_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_PETE_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    });
  } catch (e) { console.log('TG notify failed:', e.message); }
}

// DRIPOPS_INSTRUMENTATION_V1 — May 25 2026
// Best-effort observability emit. Fire-and-forget. Never blocks the response.
function emitDripops(env, eventType, severity, fields) {
  // Prefer service binding (env.DRIPOPS_BRIDGE) — internal Worker→Worker, bypasses public DNS.
  // Fallback to public fetch only if binding is missing.
  if (!env.DRIPOPS_INGEST_KEY) {
    console.log('[dripops] no INGEST_KEY, skipping');
    return Promise.resolve();
  }
  const payload = JSON.stringify({
    source: 'campaign-validator-worker',
    event_type: eventType,
    severity: severity || 'info',
    host: 'cf-worker',
    ...fields,
  });
  const headers = {
    'Authorization': 'Bearer ' + env.DRIPOPS_INGEST_KEY,
    'Content-Type': 'application/json',
  };
  const useBinding = !!env.DRIPOPS_BRIDGE;
  console.log('[dripops] emit ' + eventType + ' via=' + (useBinding ? 'binding' : 'public'));
  const promise = useBinding
    ? env.DRIPOPS_BRIDGE.fetch('https://internal/event', { method: 'POST', headers, body: payload })
    : fetch(env.DRIPOPS_BRIDGE_URL || 'https://dripops-splunk-hec-bridge.thom-rvr.workers.dev/event',
        { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(5000) });
  return promise
    .then((r) => { console.log('[dripops] emit ' + eventType + ' → ' + r.status); return r; })
    .catch((e) => { console.log('[dripops] emit swallowed: ' + (e && e.message)); });
}


export default {
  async fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);

    if (pathname === '/version' || pathname === '/_version') {
      return json({ service: 'campaign-validator-worker', doctrine_version: DOCTRINE_VERSION, status: 'ok' });
    }
    if (pathname === '/health') {
      return json({ status: 'ok', worker: 'campaign-validator-worker', doctrine_version: DOCTRINE_VERSION, ts: new Date().toISOString() });
    }

    if (pathname === '/doctrine') {
      return json({
        version: DOCTRINE_VERSION,
        rules: [
          'R1: Every post has clickable hashtags',
          'R2: Hashtags are clean (no emoji glue, no ALL CAPS)',
          'R3: Rotating hashtag pool (4-7 unique tags across thread)',
          'R4: Body bullets are single-line em-dash style',
          'R5: P0 ends with thread continuation emoji',
          'R6: Final post has Discord CTA + context link',
          'R7: #OSINT only when thread-appropriate',
          'R8: Char budget 220-285, hard cap 295',
          'R9: P0 has R2-hosted editorial image',
          'R10: Smart Emoji Engine (BREAKING→🟥, contextual scoring, anti-repeat) | R12: 🚨 BANNED forever',
          'R11: BLOCK + WARN — fail-closed if validator down',
          'R12: Integrated into schedule-worker, drip-watchdog, bsky-worker',
          'R13: Vertical spacing (blank lines between sections)',
        ],
        enforcement_mode: 'BLOCK_AND_WARN',
        notify_channel: 'Telegram @BumboclaatBot → Pete',
      });
    }

    if (!authOk(req, env)) return json({ error: 'Unauthorized' }, 401);

    if (pathname === '/smartemoji' && req.method === 'POST') {
      const body = await req.json();
      const result = await pickSmartEmoji(env, body.text || '', body.campaign_id || 'default', body.position || 'p0');
      return json(result);
    }

    if (pathname === '/facetize' && req.method === 'POST') {
      const body = await req.json();
      const facets = generateFacets(body.text || '');
      return json({ text: body.text, facets, facet_count: facets.length });
    }

    if (pathname === '/validate' && req.method === 'POST') {
      const body = await req.json();
      // PATCH 11 (May 20 2026): accept both string-array and {text}-object posts
      let posts = body.posts || [];
      if (!Array.isArray(posts) || !posts.length) {
        return json({ error: 'posts array required' }, 400);
      }
      posts = posts.map((p, i) => {
        if (typeof p === 'string') return { text: p };
        if (p && typeof p === 'object' && typeof p.text === 'string') return p;
        throw new Error(`POST_INVALID_AT_INDEX_${i}: must be string or {text: string}`);
      });
      const result = validateCampaign(posts, { approvedLinks: body.approvedLinks || [], postMode: body.postMode || 'campaign' });

      // Add auto-generated facets per post for the caller's convenience
      result.perPost.forEach((p, i) => {
        p.text = posts[i].text;
        p.suggested_facets = generateFacets(posts[i].text);
      });

      // If blocked, ping Pete
      if (result.blocked && body.notify !== false) {
        const violationSummary = result.perPost
          .flatMap((p, i) => p.violations.map(v => `  P${i}: [${v.rule}] ${v.msg}`))
          .concat(result.campaignViolations.map(v => `  CAMPAIGN: [${v.rule}] ${v.msg}`))
          .slice(0, 10)
          .join('\n');
        await notifyPete(env, `⚠️ *Campaign Validation BLOCKED*\n\nCampaign: ${body.campaign_id || 'unnamed'}\nRating: ${result.stars}/5.0\nViolations: ${result.summary.totalViolations}\nWarnings: ${result.summary.totalWarnings}\n\n${violationSummary}`);
      }

      // DRIPOPS_INSTRUMENTATION_V1 — emit via ctx.waitUntil (fire-and-forget, keeps response fast)
      ctx.waitUntil(emitDripops(env, 'validation_completed', result.blocked ? 'warning' : 'info', {
        campaign_id: body.campaign_id || 'unnamed',
        stars: result.stars,
        passing: result.passing === true,
        blocked: result.blocked === true,
        post_count: posts.length,
        total_violations: result.summary && result.summary.totalViolations,
        total_warnings: result.summary && result.summary.totalWarnings,
        doctrine_version: DOCTRINE_VERSION,
      }));

      return json(result);
    }

    return json({
      service: 'campaign-validator-worker',
      doctrine_version: DOCTRINE_VERSION,
      endpoints: [
        'GET  /health',
        'GET  /doctrine',
        'POST /validate    {posts: [{text}], campaign_id?: string, notify?: bool}',
        'POST /facetize    {text: string}',
        'POST /smartemoji  {text, campaign_id, position}',
      ],
    });
  },
};