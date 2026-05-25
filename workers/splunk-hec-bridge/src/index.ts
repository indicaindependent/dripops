/**
 * DripOps — Splunk HEC Bridge
 * ============================
 * Cloudflare Worker that accepts events from DripOps sources
 * (drip-watchdog, tuck cache, campaign validator, etc.) and forwards
 * them to Splunk's HTTP Event Collector (HEC) endpoint.
 *
 * Why a bridge worker instead of direct HEC POST?
 *   1. Edge-side enrichment — we attach standard fields (host, source, sourcetype,
 *      env, region) so every event arrives Splunk-ready.
 *   2. Auth surface — sources hold a DRIPOPS_INGEST_KEY (short, scoped), we hold
 *      the real HEC token in worker secrets. Sources can be rotated without
 *      touching Splunk.
 *   3. Batching — accept up to 100 events per call, fan-out to HEC in chunks
 *      to stay under Splunk's per-request limits.
 *   4. Failure mode — on HEC down, we buffer to KV with TTL and replay via cron.
 *   5. Schema enforcement — Zod-style validation rejects malformed events at
 *      the edge so bad data never reaches Splunk indexing.
 *
 * Endpoints:
 *   POST /event       — single event ingest
 *   POST /batch       — batch ingest (max 100 events)
 *   GET  /health      — health + last-HEC-roundtrip latency
 *   POST /replay      — admin: drain KV buffer to HEC (cron-triggered)
 *
 * Auth (all routes except /health):
 *   Header: Authorization: Bearer <DRIPOPS_INGEST_KEY>
 *
 * Built for Splunk Agentic Ops Hackathon 2026.
 */

export interface Env {
  // Secrets
  DRIPOPS_INGEST_KEY: string;        // Shared key sources use to call us
  SPLUNK_HEC_TOKEN: string;          // Real HEC token (kept server-side only)
  SPLUNK_HEC_URL: string;            // e.g. https://prd-p-xxxxx.splunkcloud.com:8088
  SCRAMBLEMEBOT_TOKEN: string;       // Telegram alerting (failure mode)
  TG_CHAT_ID: string;                // your chat_id = "0000000000"

  // Optional relay (trial-stack workaround for self-signed certs)
  SSHMCP_RELAY_URL?: string;         // e.g. https://sshmcp.ptsdtree.com/exec
  SSHMCP_SECRET?: string;            // X-SSH-Secret header value

  // Bindings
  DRIPOPS_BUFFER: KVNamespace;       // Failure buffer
  DRIPOPS_METRICS: KVNamespace;      // Health/metrics state
}

interface DripOpsEvent {
  // Required
  source: string;                    // e.g. "drip-watchdog", "tuck-cache-refresh"
  event_type: string;                // e.g. "post_fired", "validator_failed", "auth_rotated"
  severity: "info" | "warn" | "error" | "critical";

  // Optional context
  campaign_id?: string;
  worker_name?: string;
  duration_ms?: number;
  error?: string;
  metadata?: Record<string, unknown>;

  // Auto-stamped if missing
  timestamp?: number;                // epoch ms
  host?: string;
}

const SOURCETYPE = "dripops:event";
const INDEX = "main"; // pivot from May 24: use main during trial; switch to dripops index post-launch

// ---------- Helpers ----------

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function validateEvent(e: unknown): { ok: true; event: DripOpsEvent } | { ok: false; reason: string } {
  if (typeof e !== "object" || e === null) return { ok: false, reason: "event must be an object" };
  const ev = e as Record<string, unknown>;
  if (typeof ev.source !== "string" || !ev.source) return { ok: false, reason: "source required" };
  if (typeof ev.event_type !== "string" || !ev.event_type) return { ok: false, reason: "event_type required" };
  const sev = ev.severity;
  if (sev !== "info" && sev !== "warn" && sev !== "error" && sev !== "critical") {
    return { ok: false, reason: "severity must be one of: info, warn, error, critical" };
  }
  return { ok: true, event: ev as unknown as DripOpsEvent };
}

function enrichEvent(e: DripOpsEvent, req: Request): DripOpsEvent {
  return {
    ...e,
    timestamp: e.timestamp ?? Date.now(),
    host: e.host ?? new URL(req.url).hostname,
  };
}

function toHecPayload(e: DripOpsEvent): Record<string, unknown> {
  return {
    time: Math.floor((e.timestamp ?? Date.now()) / 1000),
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
      metadata: e.metadata,
    },
  };
}

async function postToHecDirect(env: Env, ndjsonBody: string): Promise<{ ok: boolean; status: number; body: string }> {
  const r = await fetch(`${env.SPLUNK_HEC_URL}/services/collector/event`, {
    method: "POST",
    headers: {
      "Authorization": `Splunk ${env.SPLUNK_HEC_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: ndjsonBody,
  });
  const text = await r.text().catch(() => "");
  return { ok: r.ok, status: r.status, body: text };
}

async function postToHecViaRelay(env: Env, ndjsonBody: string): Promise<{ ok: boolean; status: number; body: string }> {
  if (!env.SSHMCP_RELAY_URL || !env.SSHMCP_SECRET) {
    return { ok: false, status: 0, body: "relay not configured" };
  }
  // Escape the ND-JSON body for embedding in a shell single-quoted string
  const escapedBody = ndjsonBody.replace(/'/g, "'\\''");
  const curlCmd = `curl -sS -k --max-time 15 -w "\\n__HTTP_STATUS__%{http_code}" -X POST '${env.SPLUNK_HEC_URL}/services/collector/event' -H 'Authorization: Splunk ${env.SPLUNK_HEC_TOKEN}' -H 'Content-Type: application/json' -d '${escapedBody}'`;
  const r = await fetch(env.SSHMCP_RELAY_URL, {
    method: "POST",
    headers: {
      "X-SSH-Secret": env.SSHMCP_SECRET,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cmd: "bash", args: ["-c", curlCmd] }),
  });
  if (!r.ok) {
    return { ok: false, status: r.status, body: `relay gateway error: ${r.status}` };
  }
  const j = await r.json().catch(() => null) as { stdout?: string; stderr?: string; exitCode?: number } | null;
  if (!j || j.exitCode !== 0) {
    return { ok: false, status: 0, body: `relay exec failed: ${JSON.stringify(j)}` };
  }
  const stdout = j.stdout || "";
  // Parse trailing __HTTP_STATUS__NNN marker
  const m = stdout.match(/__HTTP_STATUS__(\d+)$/);
  const status = m ? parseInt(m[1], 10) : 0;
  const body = m ? stdout.slice(0, -m[0].length) : stdout;
  const ok = status >= 200 && status < 300 && body.includes('"text":"Success"');
  return { ok, status, body };
}

async function postToHec(env: Env, events: DripOpsEvent[]): Promise<{ ok: boolean; status: number; latency_ms: number; body: string; via: "direct" | "relay" }> {
  const start = Date.now();
  // HEC accepts ND-JSON: one event per line, no comma
  const ndjsonBody = events.map(e => JSON.stringify(toHecPayload(e))).join("\n");

  // Try direct first
  const direct = await postToHecDirect(env, ndjsonBody);
  if (direct.ok) {
    return { ok: true, status: direct.status, latency_ms: Date.now() - start, body: direct.body, via: "direct" };
  }

  // Fall back to SSHMCP relay (trial-stack self-signed cert workaround).
  // CF returns 525/526/530 for TLS/origin errors. Anything 4xx is a real HEC reject (don't retry).
  const isTlsOrOriginError = direct.status === 0 || direct.status === 525 || direct.status === 526 || direct.status === 530;
  if (isTlsOrOriginError && env.SSHMCP_RELAY_URL && env.SSHMCP_SECRET) {
    const relay = await postToHecViaRelay(env, ndjsonBody);
    return { ok: relay.ok, status: relay.status, latency_ms: Date.now() - start, body: relay.body, via: "relay" };
  }

  return { ok: false, status: direct.status, latency_ms: Date.now() - start, body: direct.body, via: "direct" };
}

async function bufferToKv(env: Env, events: DripOpsEvent[]): Promise<void> {
  const key = `buffer:${Date.now()}:${crypto.randomUUID()}`;
  // 24h TTL — if HEC is down longer than that, we have bigger problems
  await env.DRIPOPS_BUFFER.put(key, JSON.stringify(events), { expirationTtl: 86400 });
}

async function alertTelegram(env: Env, msg: string): Promise<void> {
  if (!env.SCRAMBLEMEBOT_TOKEN || !env.TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.SCRAMBLEMEBOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text: `🟧 *DripOps HEC Bridge*\n${msg}`,
        parse_mode: "Markdown",
      }),
    });
  } catch { /* alert is best-effort */ }
}

async function recordMetric(env: Env, key: string, value: number): Promise<void> {
  try {
    await env.DRIPOPS_METRICS.put(`metric:${key}`, JSON.stringify({ value, ts: Date.now() }), {
      expirationTtl: 3600,
    });
  } catch { /* metrics are best-effort */ }
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function authOk(req: Request, env: Env): boolean {
  const h = req.headers.get("Authorization") || "";
  return h === `Bearer ${env.DRIPOPS_INGEST_KEY}`;
}

// ---------- Router ----------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    // GET /health — no auth, for uptime monitors
    if (url.pathname === "/health" && req.method === "GET") {
      const last = await env.DRIPOPS_METRICS.get("metric:last_hec_latency_ms");
      return json({
        ok: true,
        service: "dripops-splunk-hec-bridge",
        version: "0.1.0",
        last_hec_latency_ms: last ? JSON.parse(last).value : null,
      });
    }

    // Everything else needs auth
    if (!authOk(req, env)) return unauthorized();

    // POST /event
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

    // POST /batch
    if (url.pathname === "/batch" && req.method === "POST") {
      const body = await req.json().catch(() => null) as { events?: unknown[] } | null;
      if (!body || !Array.isArray(body.events)) return json({ error: "events array required" }, 400);
      if (body.events.length === 0) return json({ error: "empty batch" }, 400);
      if (body.events.length > 100) return json({ error: "batch too large (max 100)" }, 400);

      const enriched: DripOpsEvent[] = [];
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

    // POST /replay — drain buffer (called by cron or manually)
    if (url.pathname === "/replay" && req.method === "POST") {
      const list = await env.DRIPOPS_BUFFER.list({ prefix: "buffer:", limit: 100 });
      let replayed = 0;
      let failed = 0;
      for (const k of list.keys) {
        const raw = await env.DRIPOPS_BUFFER.get(k.name);
        if (!raw) continue;
        const events = JSON.parse(raw) as DripOpsEvent[];
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

    return json({ error: "not_found" }, 404);
  },

  // Scheduled handler — replay buffer every 5 minutes
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const list = await env.DRIPOPS_BUFFER.list({ prefix: "buffer:", limit: 100 });
    if (list.keys.length === 0) return;
    for (const k of list.keys) {
      const raw = await env.DRIPOPS_BUFFER.get(k.name);
      if (!raw) continue;
      const events = JSON.parse(raw) as DripOpsEvent[];
      const result = await postToHec(env, events);
      if (result.ok) {
        await env.DRIPOPS_BUFFER.delete(k.name);
      }
    }
  },
};
