// src/index.ts
var SOURCETYPE = "dripops:event";
var INDEX = "main";
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
function validateEvent(e) {
  if (typeof e !== "object" || e === null) return { ok: false, reason: "event must be an object" };
  const ev = e;
  if (typeof ev.source !== "string" || !ev.source) return { ok: false, reason: "source required" };
  if (typeof ev.event_type !== "string" || !ev.event_type) return { ok: false, reason: "event_type required" };
  const sev = ev.severity;
  if (sev !== "info" && sev !== "warn" && sev !== "error" && sev !== "critical") {
    return { ok: false, reason: "severity must be one of: info, warn, error, critical" };
  }
  return { ok: true, event: ev };
}
function enrichEvent(e, req) {
  return {
    ...e,
    timestamp: e.timestamp ?? Date.now(),
    host: e.host ?? new URL(req.url).hostname
  };
}
function toHecPayload(e) {
  return {
    time: Math.floor((e.timestamp ?? Date.now()) / 1e3),
    host: e.host,
    source: e.source,
    sourcetype: SOURCETYPE,
    index: INDEX,
    event: {
      event_type: e.event_type,
      severity: e.severity,
      campaign_id: e.campaign_id,
      worker_name: e.worker_name,
      duration_ms: e.duration_ms,
      error: e.error,
      metadata: e.metadata
    }
  };
}
async function postToHecDirect(env, ndjsonBody) {
  const r = await fetch(`${env.SPLUNK_HEC_URL}/services/collector/event`, {
    method: "POST",
    headers: {
      "Authorization": `Splunk ${env.SPLUNK_HEC_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: ndjsonBody
  });
  const text = await r.text().catch(() => "");
  return { ok: r.ok, status: r.status, body: text };
}
async function postToHecViaRelay(env, ndjsonBody) {
  if (!env.SSHMCP_RELAY_URL || !env.SSHMCP_SECRET) {
    return { ok: false, status: 0, body: "relay not configured" };
  }
  const escapedBody = ndjsonBody.replace(/'/g, "'\\''");
  const curlCmd = `curl -sS -k --max-time 15 -w "\\n__HTTP_STATUS__%{http_code}" -X POST '${env.SPLUNK_HEC_URL}/services/collector/event' -H 'Authorization: Splunk ${env.SPLUNK_HEC_TOKEN}' -H 'Content-Type: application/json' -d '${escapedBody}'`;
  const r = await fetch(env.SSHMCP_RELAY_URL, {
    method: "POST",
    headers: {
      "X-SSH-Secret": env.SSHMCP_SECRET,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ cmd: "bash", args: ["-c", curlCmd] })
  });
  if (!r.ok) {
    return { ok: false, status: r.status, body: `relay gateway error: ${r.status}` };
  }
  const j = await r.json().catch(() => null);
  if (!j || j.exitCode !== 0) {
    return { ok: false, status: 0, body: `relay exec failed: ${JSON.stringify(j)}` };
  }
  const stdout = j.stdout || "";
  const m = stdout.match(/__HTTP_STATUS__(\d+)$/);
  const status = m ? parseInt(m[1], 10) : 0;
  const body = m ? stdout.slice(0, -m[0].length) : stdout;
  const ok = status >= 200 && status < 300 && body.includes('"text":"Success"');
  return { ok, status, body };
}

async function splunkSearchViaRelay(env, spl, earliest = "-1h", latest = "now", maxResults = 100) {
  if (!env.SSHMCP_RELAY_URL || !env.SSHMCP_SECRET) {
    return { ok: false, status: 0, body: "relay not configured" };
  }
  if (!env.SPLUNK_API_URL || !env.SPLUNK_SEARCH_TOKEN) {
    return { ok: false, status: 0, body: "splunk search not configured (need SPLUNK_API_URL + SPLUNK_SEARCH_TOKEN)" };
  }
  // Splunk requires "search " prefix on raw SPL — be forgiving if user already added it
  const splNorm = (spl.trim().startsWith("search ") || spl.trim().startsWith("|")) ? spl.trim() : `search ${spl.trim()}`;
  // URL-encode the form fields for shell safety
  const form = new URLSearchParams({
    search: splNorm,
    earliest_time: earliest,
    latest_time: latest,
    output_mode: "json",
    exec_mode: "oneshot",
    count: String(maxResults),
  }).toString();
  // Single-quote-escape for bash
  const escapedForm = form.replace(/'/g, "'\\''");
  const escapedAuth = env.SPLUNK_SEARCH_TOKEN.replace(/'/g, "'\\''");
  const curlCmd = `curl -sS -k --max-time 30 -w "\n__HTTP_STATUS__%{http_code}" -X POST '${env.SPLUNK_API_URL}/services/search/jobs/export' -H 'Authorization: Bearer ${escapedAuth}' -H 'Content-Type: application/x-www-form-urlencoded' --data '${escapedForm}'`;
  const r = await fetch(env.SSHMCP_RELAY_URL, {
    method: "POST",
    headers: { "X-SSH-Secret": env.SSHMCP_SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: "bash", args: ["-c", curlCmd] })
  });
  if (!r.ok) return { ok: false, status: r.status, body: `relay gateway error: ${r.status}` };
  const j = await r.json().catch(() => null);
  if (!j || j.exitCode !== 0) return { ok: false, status: 0, body: `relay exec failed: ${JSON.stringify(j)}` };
  const stdout = j.stdout || "";
  const m = stdout.match(/__HTTP_STATUS__(\d+)$/);
  const status = m ? parseInt(m[1], 10) : 0;
  const rawBody = m ? stdout.slice(0, -m[0].length) : stdout;
  // Parse ND-JSON results
  const results = [];
  const messages = [];
  for (const line of rawBody.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.result) results.push(obj.result);
      if (obj.messages) messages.push(...obj.messages);
    } catch { /* skip */ }
  }
  const ok = status >= 200 && status < 300;
  return { ok, status, body: rawBody.slice(0, 1000), results, messages, result_count: results.length };
}

async function postToHec(env, events) {
  const start = Date.now();
  const ndjsonBody = events.map((e) => JSON.stringify(toHecPayload(e))).join("\n");
  const direct = await postToHecDirect(env, ndjsonBody);
  if (direct.ok) {
    return { ok: true, status: direct.status, latency_ms: Date.now() - start, body: direct.body, via: "direct" };
  }
  const isTlsOrOriginError = direct.status === 0 || direct.status === 525 || direct.status === 526 || direct.status === 530;
  if (isTlsOrOriginError && env.SSHMCP_RELAY_URL && env.SSHMCP_SECRET) {
    const relay = await postToHecViaRelay(env, ndjsonBody);
    return { ok: relay.ok, status: relay.status, latency_ms: Date.now() - start, body: relay.body, via: "relay" };
  }
  return { ok: false, status: direct.status, latency_ms: Date.now() - start, body: direct.body, via: "direct" };
}
async function bufferToKv(env, events) {
  const key = `buffer:${Date.now()}:${crypto.randomUUID()}`;
  await env.DRIPOPS_BUFFER.put(key, JSON.stringify(events), { expirationTtl: 86400 });
}
async function alertTelegram(env, msg) {
  if (!env.SCRAMBLEMEBOT_TOKEN || !env.TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.SCRAMBLEMEBOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text: `\u{1F7E7} *DripOps HEC Bridge*
${msg}`,
        parse_mode: "Markdown"
      })
    });
  } catch {
  }
}
async function recordMetric(env, key, value) {
  try {
    await env.DRIPOPS_METRICS.put(`metric:${key}`, JSON.stringify({ value, ts: Date.now() }), {
      expirationTtl: 3600
    });
  } catch {
  }
}
function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}
function authOk(req, env) {
  const h = req.headers.get("Authorization") || "";
  return h === `Bearer ${env.DRIPOPS_INGEST_KEY}`;
}
var index_default = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/health" && req.method === "GET") {
      const last = await env.DRIPOPS_METRICS.get("metric:last_hec_latency_ms");
      return json({
        ok: true,
        service: "dripops-splunk-hec-bridge",
        version: "0.2.0",
        last_hec_latency_ms: last ? JSON.parse(last).value : null
      });
    }
    if (!authOk(req, env)) return unauthorized();
    if (url.pathname === "/event" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const v = validateEvent(body);
      if (!v.ok) return json({ error: v.reason }, 400);
      const enriched = enrichEvent(v.event, req);
      const result = await postToHec(env, [enriched]);
      ctx.waitUntil(recordMetric(env, "last_hec_latency_ms", result.latency_ms));
      if (!result.ok) {
        ctx.waitUntil(bufferToKv(env, [enriched]));
        ctx.waitUntil(alertTelegram(env, `HEC failed (${result.status}, via=${result.via}). 1 event buffered. Body: \`${result.body.slice(0, 200)}\``));
        return json({ error: "hec_failed", status: result.status, via: result.via, buffered: true }, 502);
      }
      return json({ ok: true, latency_ms: result.latency_ms, via: result.via });
    }
    if (url.pathname === "/batch" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || !Array.isArray(body.events)) return json({ error: "events array required" }, 400);
      if (body.events.length === 0) return json({ error: "empty batch" }, 400);
      if (body.events.length > 100) return json({ error: "batch too large (max 100)" }, 400);
      const enriched = [];
      for (const raw of body.events) {
        const v = validateEvent(raw);
        if (!v.ok) return json({ error: `invalid event: ${v.reason}` }, 400);
        enriched.push(enrichEvent(v.event, req));
      }
      const result = await postToHec(env, enriched);
      ctx.waitUntil(recordMetric(env, "last_hec_latency_ms", result.latency_ms));
      if (!result.ok) {
        ctx.waitUntil(bufferToKv(env, enriched));
        ctx.waitUntil(alertTelegram(env, `HEC failed (${result.status}, via=${result.via}). ${enriched.length} events buffered.`));
        return json({ error: "hec_failed", status: result.status, via: result.via, buffered: true, count: enriched.length }, 502);
      }
      return json({ ok: true, count: enriched.length, latency_ms: result.latency_ms, via: result.via });
    }
    if (url.pathname === "/replay" && req.method === "POST") {
      const list = await env.DRIPOPS_BUFFER.list({ prefix: "buffer:", limit: 100 });
      let replayed = 0;
      let failed = 0;
      for (const k of list.keys) {
        const raw = await env.DRIPOPS_BUFFER.get(k.name);
        if (!raw) continue;
        const events = JSON.parse(raw);
        const result = await postToHec(env, events);
        if (result.ok) {
          await env.DRIPOPS_BUFFER.delete(k.name);
          replayed += events.length;
        } else {
          failed += events.length;
        }
      }
      return json({ ok: true, replayed, failed, keys_processed: list.keys.length });
    }
    if (url.pathname === "/splunk-search" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || !body.query) return json({ error: "query field required" }, 400);
      const earliest = body.earliest || "-1h";
      const latest = body.latest || "now";
      const maxResults = Math.min(body.max_results || 100, 500);
      const result = await splunkSearchViaRelay(env, body.query, earliest, latest, maxResults);
      if (!result.ok) {
        return json({ error: "splunk_search_failed", status: result.status, body: result.body }, 502);
      }
      return json({ ok: true, result_count: result.result_count, results: result.results, messages: result.messages });
    }
    return json({ error: "not_found" }, 404);
  },
  // Scheduled handler — replay buffer every 5 minutes
  async scheduled(_event, env, ctx) {
    const list = await env.DRIPOPS_BUFFER.list({ prefix: "buffer:", limit: 100 });
    if (list.keys.length === 0) return;
    for (const k of list.keys) {
      const raw = await env.DRIPOPS_BUFFER.get(k.name);
      if (!raw) continue;
      const events = JSON.parse(raw);
      const result = await postToHec(env, events);
      if (result.ok) {
        await env.DRIPOPS_BUFFER.delete(k.name);
      }
    }
  }
};
export {
  index_default as default
};
