/**
 * DripOps MCP Server
 * ===================
 * Model Context Protocol server that exposes DripOps observability tools
 * to Claude Sonnet 4.6 (or any MCP-compatible LLM client).
 *
 * The server is the *agentic action surface*: it turns natural-language
 * intent ("show me last hour's HEC failures", "open a PR to bump the
 * JWT cache TTL", "alert Pete that drip-watchdog is stuck") into real
 * API calls against Splunk Cloud, GitHub, and Telegram.
 *
 * Transport: stdio (standard MCP transport — works with Claude Desktop,
 * Cursor, Continue, and the Splunk MCP integration).
 *
 * Tools exposed:
 *   1. splunk_search        — run a Splunk SPL query (oneshot, max 60s)
 *   2. splunk_saved_search  — execute a pre-defined saved search
 *   3. github_open_pr       — open a PR against the dripops repo with a
 *                              proposed fix (used by remediation flows)
 *   4. telegram_alert       — send a Telegram message to Pete via Scramblemebot
 *   5. dripops_health       — quick health-check of the HEC bridge worker
 *
 * Built for the Splunk Agentic Ops Hackathon 2026
 *   Bonus eligibility:
 *     • stack MCP bonus     (using MCP as the agent action surface)
 *     • Hosted Models bonus (Claude Sonnet 4.6 via Anthropic API)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

// =========================================================================
// Environment
// =========================================================================

const env = {
  SPLUNK_API_URL: process.env.SPLUNK_API_URL || "",            // e.g. https://prd-p-xxxxx.splunkcloud.com:8089 (now optional — routed via bridge)
  SPLUNK_TOKEN: process.env.SPLUNK_TOKEN || "",                // Splunk auth token (deprecated — bridge holds it now)
  DRIPOPS_INGEST_KEY: process.env.DRIPOPS_INGEST_KEY || "",    // Bridge auth — used by splunk_search routed through bridge
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",                // GitHub PAT (repo scope)
  GITHUB_REPO: process.env.GITHUB_REPO || "pete-mcvries/dripops",
  SCRAMBLEMEBOT_TOKEN: process.env.SCRAMBLEMEBOT_TOKEN || "",
  TG_CHAT_ID: process.env.TG_CHAT_ID || "0000000000",
  HEC_BRIDGE_URL: process.env.HEC_BRIDGE_URL || "https://hec.dripops.osintnet.uk",
};

function assertConfigured(key: keyof typeof env): void {
  if (!env[key]) {
    throw new Error(
      `dripops-mcp: missing required env ${key}. ` +
      `Set it in the MCP client config (e.g. claude_desktop_config.json env block).`
    );
  }
}

// =========================================================================
// Splunk client (REST, oneshot)
// =========================================================================

interface SplunkResult {
  results: Array<Record<string, unknown>>;
  preview?: boolean;
  init_offset?: number;
  messages?: Array<{ type: string; text: string }>;
}

async function splunkSearch(query: string, earliest = "-1h", latest = "now", maxResults = 100): Promise<SplunkResult> {
  // Routes via the DripOps bridge worker — keeps Splunk creds centralized
  // and uses the same trusted OptiPlex relay path as HEC ingest.
  if (!env.HEC_BRIDGE_URL || !env.DRIPOPS_INGEST_KEY) {
    throw new Error("splunk_search requires HEC_BRIDGE_URL + DRIPOPS_INGEST_KEY env");
  }
  const r = await fetch(`${env.HEC_BRIDGE_URL.replace(/\/$/, "")}/splunk-search`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.DRIPOPS_INGEST_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, earliest, latest, max_results: maxResults }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`splunk_search failed ${r.status}: ${text.slice(0, 300)}`);
  }
  const data = await r.json() as { results: Array<Record<string, unknown>>; messages?: Array<{type: string; text: string}>; result_count: number };
  return { results: data.results || [], messages: data.messages || [] };
}

async function splunkSavedSearch(name: string, args: Record<string, string> = {}): Promise<SplunkResult> {
  assertConfigured("SPLUNK_API_URL");
  assertConfigured("SPLUNK_TOKEN");

  const form = new URLSearchParams({
    output_mode: "json",
    ...args,
  });

  const url = `${env.SPLUNK_API_URL.replace(/\/$/, "")}/services/saved/searches/${encodeURIComponent(name)}/dispatch`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.SPLUNK_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`splunk_saved_search dispatch failed ${r.status}: ${text.slice(0, 300)}`);
  }

  // Dispatch returns a search ID (sid). For the hackathon demo flow we
  // return the SID and let the caller poll separately; for the most common
  // case (small saved searches that complete in <5s) we wait + fetch.
  const dispatchResp = await r.json() as { sid?: string };
  const sid = dispatchResp.sid;
  if (!sid) {
    return { results: [], messages: [{ type: "ERROR", text: "no sid returned from dispatch" }] };
  }

  // Poll for completion (max 30s)
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    await new Promise(r => setTimeout(r, 1000));
    const statusUrl = `${env.SPLUNK_API_URL}/services/search/jobs/${sid}?output_mode=json`;
    const sr = await fetch(statusUrl, {
      headers: { "Authorization": `Bearer ${env.SPLUNK_TOKEN}` },
    });
    if (!sr.ok) continue;
    const sdata = await sr.json() as { entry?: Array<{ content?: { isDone?: boolean } }> };
    if (sdata.entry?.[0]?.content?.isDone) {
      // Fetch results
      const rUrl = `${env.SPLUNK_API_URL}/services/search/jobs/${sid}/results?output_mode=json&count=100`;
      const rr = await fetch(rUrl, {
        headers: { "Authorization": `Bearer ${env.SPLUNK_TOKEN}` },
      });
      const rdata = await rr.json() as SplunkResult;
      return rdata;
    }
  }

  return { results: [], messages: [{ type: "WARN", text: `saved search ${name} did not complete within 30s` }] };
}

// =========================================================================
// GitHub client (open a PR)
// =========================================================================

interface PrArgs {
  branch: string;          // e.g. "fix/jwt-cache-ttl-bump"
  title: string;           // e.g. "fix: bump JWT cache TTL to 120 min"
  body: string;            // PR description (Claude writes the runbook here)
  base?: string;           // defaults to "main"
  draft?: boolean;         // defaults to true (safer for agentic flow)
}

async function githubOpenPr(args: PrArgs): Promise<{ pr_url: string; pr_number: number }> {
  assertConfigured("GITHUB_TOKEN");

  // For an "agentic remediation" PR the agent is suggesting a fix, not yet
  // committing code. We open the PR against an existing branch the agent
  // (or a human) has already pushed. The agent's job here is to articulate
  // the *what + why + runbook* — humans approve the merge.
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/pulls`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: args.title,
      body: args.body,
      head: args.branch,
      base: args.base || "main",
      draft: args.draft ?? true,
    }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`github_open_pr failed ${r.status}: ${text.slice(0, 500)}`);
  }

  const pr = await r.json() as { html_url: string; number: number };
  return { pr_url: pr.html_url, pr_number: pr.number };
}

// =========================================================================
// Telegram alert
// =========================================================================

async function telegramAlert(text: string, severity: "info" | "warn" | "error" | "critical" = "info"): Promise<void> {
  assertConfigured("SCRAMBLEMEBOT_TOKEN");
  const emoji = { info: "🔵", warn: "🟡", error: "🟠", critical: "🔴" }[severity];
  const msg = `${emoji} *DripOps Agent*\n${text}`;

  const r = await fetch(`https://api.telegram.org/bot${env.SCRAMBLEMEBOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TG_CHAT_ID,
      text: msg,
      parse_mode: "Markdown",
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`telegram_alert failed ${r.status}: ${t.slice(0, 200)}`);
  }
}

// =========================================================================
// HEC Bridge health check
// =========================================================================

async function dripopsHealth(): Promise<{ ok: boolean; service: string; version: string; last_hec_latency_ms: number | null }> {
  const r = await fetch(`${env.HEC_BRIDGE_URL.replace(/\/$/, "")}/health`);
  if (!r.ok) throw new Error(`dripops_health failed ${r.status}`);
  return r.json() as Promise<{ ok: boolean; service: string; version: string; last_hec_latency_ms: number | null }>;
}

// =========================================================================
// MCP server setup
// =========================================================================

const tools: Tool[] = [
  {
    name: "splunk_search",
    description:
      "Run an ad-hoc Splunk SPL query (oneshot mode). Use this to investigate incidents, " +
      "check event counts, or drill into specific log lines. " +
      "Time defaults: last 1 hour. Returns up to 100 result rows.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "SPL query (the 'search' keyword prefix is added automatically if missing). Example: 'index=dripops sourcetype=dripops:event severity=error | stats count by source'",
        },
        earliest: { type: "string", description: "Splunk-relative time (e.g. '-1h', '-24h', '@d'). Default: '-1h'." },
        latest: { type: "string", description: "Splunk-relative time. Default: 'now'." },
        max_results: { type: "number", description: "Cap on rows returned. Default: 100." },
      },
      required: ["query"],
    },
  },
  {
    name: "splunk_saved_search",
    description:
      "Dispatch a pre-defined Splunk saved search and return its results. " +
      "Use this for vetted, named queries (e.g. 'dripops_hec_failures_24h', 'validator_violations_weekly').",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Saved search name as configured in Splunk." },
        args: {
          type: "object",
          description: "Optional dispatch arguments (e.g. {\"trigger_actions\": \"1\"}).",
          additionalProperties: { type: "string" },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "github_open_pr",
    description:
      "Open a (draft, by default) Pull Request against the dripops repo on behalf of the agent. " +
      "Use this for autonomous remediation: after diagnosing an incident, propose a code fix " +
      "in PR form so a human can review and merge. The agent should write a thorough PR body " +
      "including: root cause, evidence (Splunk links), the change, and a runbook for verification.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Branch name containing the proposed fix. Must already be pushed." },
        title: { type: "string", description: "PR title (conventional-commits style preferred). E.g. 'fix(watchdog): bump JWT cache TTL to 120 min'." },
        body: { type: "string", description: "PR description (markdown). Include root cause + evidence + verification runbook." },
        base: { type: "string", description: "Base branch. Default: 'main'." },
        draft: { type: "boolean", description: "Open as draft. Default: true (safer for autonomous flows)." },
      },
      required: ["branch", "title", "body"],
    },
  },
  {
    name: "telegram_alert",
    description:
      "Send a Telegram message to Pete via Scramblemebot. Use this for human-in-the-loop notifications " +
      "during incident response (e.g. 'I opened PR #42 for the JWT cache fix — please review').",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message body. Markdown supported." },
        severity: {
          type: "string",
          enum: ["info", "warn", "error", "critical"],
          description: "Severity tag (controls the leading emoji). Default: 'info'.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "dripops_health",
    description:
      "Quick health check of the DripOps Splunk HEC Bridge worker. Returns service, version, " +
      "and last observed HEC roundtrip latency. Use at the start of any investigation.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server(
  { name: "dripops-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "splunk_search": {
        const a = (args || {}) as { query: string; earliest?: string; latest?: string; max_results?: number };
        const result = await splunkSearch(a.query, a.earliest, a.latest, a.max_results);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "splunk_saved_search": {
        const a = (args || {}) as { name: string; args?: Record<string, string> };
        const result = await splunkSavedSearch(a.name, a.args || {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "github_open_pr": {
        const a = (args || {}) as unknown as PrArgs;
        const pr = await githubOpenPr(a);
        return {
          content: [{
            type: "text",
            text: `✅ PR opened: ${pr.pr_url} (#${pr.pr_number})`,
          }],
        };
      }
      case "telegram_alert": {
        const a = (args || {}) as { text: string; severity?: "info" | "warn" | "error" | "critical" };
        await telegramAlert(a.text, a.severity);
        return { content: [{ type: "text", text: "✅ Telegram alert sent." }] };
      }
      case "dripops_health": {
        const h = await dripopsHealth();
        return { content: [{ type: "text", text: JSON.stringify(h, null, 2) }] };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error in ${name}: ${msg}` }],
      isError: true,
    };
  }
});

// =========================================================================
// Boot
// =========================================================================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is fine for log lines — stdout is reserved for JSON-RPC frames
  console.error("dripops-mcp: connected (stdio transport)");
}

main().catch((err) => {
  console.error("dripops-mcp: fatal", err);
  process.exit(1);
});
