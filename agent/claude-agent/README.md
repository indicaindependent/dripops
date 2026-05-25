# DripOps Agent — Autonomous Remediation Loop

> Claude Sonnet 4.6 + DripOps MCP Server = autonomous content-pipeline triage.

This is the **agentic intelligence lane** of DripOps. It runs a Claude Sonnet 4.6 LLM
in a tool-use loop with the DripOps MCP server, letting it autonomously:

1. **Investigate** — query Splunk for anomalies (HEC failure spikes, validator drift,
   stuck drip campaigns).
2. **Diagnose** — correlate evidence across sources (drip-watchdog logs +
   validator counters + cache freshness).
3. **Remediate** — either:
   - Open a draft GitHub PR with a proposed code fix, OR
   - Send Pete a Telegram alert with a runbook.

## How it works

```
┌─────────────────────────┐
│  Scheduled cron trigger │  (every 15 min, or manual)
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│   Claude Sonnet 4.6     │  System prompt: "you are DripOps Agent.
│   (Anthropic API)       │   Investigate the last 30 min of events.
└────────────┬────────────┘   If you detect an incident, remediate."
             │
             │  tool_use: splunk_search / dripops_health / etc.
             ▼
┌─────────────────────────┐
│   DripOps MCP Server    │
│   (stdio transport)     │
└────────────┬────────────┘
             │
       ┌─────┴─────┬───────────┐
       ▼           ▼           ▼
    Splunk     GitHub     Telegram
```

## Files

- `agent.py` — the orchestration script (Python, calls Anthropic API + MCP)
- `prompts/system.md` — the agent's system prompt (DripOps Agent persona)
- `prompts/runbooks/` — example incident patterns + canonical remediations

## Run it

```bash
cd dripops/agent/claude-agent
pip install anthropic httpx
export ANTHROPIC_API_KEY=sk-ant-...
python agent.py --once
```
