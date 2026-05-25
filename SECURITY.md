# Security

## Secret handling

DripOps deliberately keeps every credential out of source. There is no API key, bot token, ingest secret, or admin password committed to this repo — past, present, or in history.

### Where secrets actually live

| Secret | Where it lives | How to inject |
|---|---|---|
| `DRIPOPS_INGEST_KEY` | Cloudflare Worker secret (bridge) + `.env` on each source host | `wrangler secret put DRIPOPS_INGEST_KEY` |
| `SPLUNK_HEC_TOKEN` | Cloudflare Worker secret (bridge only) | `wrangler secret put SPLUNK_HEC_TOKEN` |
| `SPLUNK_SEARCH_TOKEN` | Cloudflare Worker secret (bridge only) | `wrangler secret put SPLUNK_SEARCH_TOKEN` |
| `SSHMCP_SECRET` | Cloudflare Worker secret (bridge) + OptiPlex relay | `wrangler secret put SSHMCP_SECRET` |
| `ANTHROPIC_API_KEY` | local `.env` for the agent host only | `export ANTHROPIC_API_KEY=...` |
| `GITHUB_TOKEN` | local `.env` for the agent host only | `export GITHUB_TOKEN=...` |
| `TELEGRAM_BOT_TOKEN` | Cloudflare Worker secret + agent host `.env` | `wrangler secret put TELEGRAM_BOT_TOKEN` |
| `TG_CHAT_ID` | Cloudflare Worker secret + agent host `.env` | non-sensitive but kept out of source |

### .env.example

Copy `.env.example` to `.env` and fill in your own values. The `.env` file is in `.gitignore`.

## Reporting a vulnerability

Open a private security advisory on this repo or DM `@indicaindependent.bsky.social` on Bluesky. No bounty program (this is a hackathon project) — just real thanks.

## Hardening notes

- All Splunk credentials live in exactly one Cloudflare Worker (the bridge). Rotation is one `wrangler secret put` call.
- The OptiPlex SSH-MCP relay accepts only `bash` commands matching an explicit allowlist regex on the relay side.
- Bridge auth is a 64-char hex shared secret with constant-time comparison.
- `.env` files are gitignored, and `git filter-repo` was used during initial setup to scrub any historical token leaks before the first public commit.
