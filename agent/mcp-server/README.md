# DripOps MCP Server

> Exposes DripOps observability tools (Splunk + GitHub + Telegram + HEC bridge) to LLM clients via the Model Context Protocol.

**Built for:** Splunk Agentic Ops Hackathon 2026
**Bonus tracks targeted:** stack MCP ($1K) · Hosted Models ($1K)

---

## Tools exposed

| Tool | What it does |
|---|---|
| `splunk_search` | Run an ad-hoc SPL query (oneshot, ≤60s, ≤100 rows) |
| `splunk_saved_search` | Dispatch a pre-defined saved search and return results |
| `github_open_pr` | Open a (draft) PR with a proposed remediation |
| `telegram_alert` | Send a Telegram message to Pete via Scramblemebot |
| `dripops_health` | Health-check the HEC Bridge worker |

---

## Install + build

```bash
cd dripops/agent/mcp-server
npm install
npm run build
```

Output lands in `dist/index.js`.

---

## Run the smoke test

```bash
./test/smoke-test.sh
```

Verifies:
- Server boots, completes MCP handshake
- All 5 tools register correctly
- Errors propagate cleanly when env vars are missing

---

## Wire it into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "dripops": {
      "command": "node",
      "args": ["/absolute/path/to/dripops/agent/mcp-server/dist/index.js"],
      "env": {
        "SPLUNK_API_URL": "https://prd-p-xxxxx.splunkcloud.com:8089",
        "SPLUNK_TOKEN": "your-splunk-bearer-token",
        "GITHUB_TOKEN": "ghp_yourpat",
        "GITHUB_REPO": "pete-mcvries/dripops",
        "SCRAMBLEMEBOT_TOKEN": "your-bot-token",
        "TG_CHAT_ID": "0000000000",
        "HEC_BRIDGE_URL": "https://hec.dripops.osintnet.uk"
      }
    }
  }
}
```

Restart Claude Desktop. You should see `dripops` listed in the MCP indicator.

---

## Wire it into Cursor / Continue / other MCP clients

Any client that supports the standard `stdio` transport works. The config format varies but the command is the same:

```
node /absolute/path/to/dripops/agent/mcp-server/dist/index.js
```

---

## Architecture

```
LLM Client (Claude Desktop / Cursor / Sonnet 4.6 API)
                │
                │ JSON-RPC over stdio
                ▼
       DripOps MCP Server (this package)
                │
       ┌────────┼────────┬───────────┐
       ▼        ▼        ▼           ▼
   Splunk    GitHub   Telegram    HEC Bridge
   REST API  REST API Bot API     Worker
```

The server is a *thin action surface*: it does no reasoning. All decision-making lives in the LLM. The server's job is to:

1. Authenticate to upstream services (token rotation lives here, not in the LLM)
2. Marshal arguments into provider-specific formats
3. Return results in clean, structured JSON for the LLM to reason over

---

## Example agent flow (incident remediation)

1. Splunk fires a saved-search alert: "HEC failures > 5 in last 15 min"
2. Webhook triggers Claude Sonnet 4.6 with the alert payload
3. Claude calls `splunk_search` to investigate root cause
4. Claude identifies pattern: JWT cache TTL expired faster than expected
5. Claude pushes a fix branch via local git (out-of-band)
6. Claude calls `github_open_pr` with full root-cause writeup + runbook
7. Claude calls `telegram_alert` to ping Pete: "Draft PR #42 ready for review"
8. Pete reviews, merges, deploys — incident resolved with audit trail

---

## License

MIT — Pete McVries / VPDLNY, May 2026.
