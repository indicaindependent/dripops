#!/usr/bin/env python3
"""
DripOps Agent — Claude Sonnet 4.6 autonomous remediation loop.

Talks to the DripOps MCP server over stdio and runs a tool-use loop until
Claude either acts (TG alert / PR) or declares all-clear.

Usage:
    python agent.py --once             # single investigation run
    python agent.py --watch INTERVAL   # loop every INTERVAL seconds
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid
from typing import Any

import anthropic

ROOT = pathlib.Path(__file__).resolve().parent
MCP_SERVER_JS = ROOT.parent / "mcp-server" / "dist" / "index.js"
MODEL = os.environ.get("DRIPOPS_MODEL", "claude-sonnet-4-5-20250929")  # Sonnet 4.5/4.6
MAX_TOOL_ITERATIONS = 8


def load_prompt() -> str:
    """Build the system prompt: persona + all runbooks."""
    parts = [(ROOT / "prompts" / "system.md").read_text()]
    runbook_dir = ROOT / "prompts" / "runbooks"
    if runbook_dir.exists():
        parts.append("\n\n# Runbooks\n")
        for f in sorted(runbook_dir.glob("*.md")):
            parts.append(f.read_text())
            parts.append("\n---\n")
    return "\n".join(parts)


class McpStdioClient:
    """Minimal MCP client that talks to our dripops-mcp server over stdio."""

    def __init__(self, server_cmd: list[str], env: dict[str, str]):
        self.proc = subprocess.Popen(
            server_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            bufsize=1,
        )
        self._id = 0
        self._initialize()

    def _send(self, msg: dict[str, Any]) -> None:
        assert self.proc.stdin
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def _recv(self) -> dict[str, Any]:
        assert self.proc.stdout
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"MCP server closed stdout. stderr: {err[:500]}")
        return json.loads(line)

    def _call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._id += 1
        msg = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            msg["params"] = params
        self._send(msg)
        while True:
            resp = self._recv()
            if resp.get("id") == self._id:
                if "error" in resp:
                    raise RuntimeError(f"MCP error: {resp['error']}")
                return resp.get("result", {})

    def _notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self._send(msg)

    def _initialize(self) -> None:
        self._call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "dripops-agent", "version": "0.1.0"},
        })
        self._notify("notifications/initialized")

    def list_tools(self) -> list[dict[str, Any]]:
        result = self._call("tools/list")
        return result.get("tools", [])

    def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        result = self._call("tools/call", {"name": name, "arguments": arguments})
        content = result.get("content", [])
        text_parts = [c.get("text", "") for c in content if c.get("type") == "text"]
        return "\n".join(text_parts)

    def close(self) -> None:
        try:
            self.proc.stdin.close()  # type: ignore
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def mcp_tools_to_anthropic(mcp_tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert MCP tool definitions to Anthropic tool-use format."""
    return [
        {
            "name": t["name"],
            "description": t["description"],
            "input_schema": t["inputSchema"],
        }
        for t in mcp_tools
    ]


def run_investigation(client: anthropic.Anthropic, mcp: McpStdioClient) -> dict[str, Any]:
    """Run one full tool-use loop with Claude."""
    run_id = uuid.uuid4().hex[:8]
    log = {"run_id": run_id, "started_at": time.time(), "tool_calls": [], "final_text": None}

    print(f"[{run_id}] Loading MCP tools...")
    mcp_tools = mcp.list_tools()
    anthropic_tools = mcp_tools_to_anthropic(mcp_tools)
    print(f"[{run_id}] {len(anthropic_tools)} tools: {[t['name'] for t in anthropic_tools]}")

    system_prompt = load_prompt()
    messages: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": (
                "Run your scheduled investigation now. Check the last 30 minutes of "
                "DripOps events. Start with dripops_health, then investigate. "
                "If everything looks fine, say 'all clear' and stop. "
                "If you find an incident, act on it via telegram_alert or github_open_pr."
            ),
        }
    ]

    for iteration in range(MAX_TOOL_ITERATIONS):
        print(f"[{run_id}] iteration {iteration+1}/{MAX_TOOL_ITERATIONS} → Claude...")
        resp = client.messages.create(
            model=MODEL,
            max_tokens=2048,
            system=system_prompt,
            tools=anthropic_tools,
            messages=messages,
        )

        # Collect assistant message (text + tool_use blocks)
        assistant_content: list[dict[str, Any]] = []
        tool_uses: list[dict[str, Any]] = []
        text_chunks: list[str] = []
        for block in resp.content:
            if block.type == "text":
                assistant_content.append({"type": "text", "text": block.text})
                text_chunks.append(block.text)
            elif block.type == "tool_use":
                assistant_content.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })
                tool_uses.append({"id": block.id, "name": block.name, "input": block.input})

        if text_chunks:
            print(f"[{run_id}] Claude says: {' '.join(text_chunks)[:300]}")

        messages.append({"role": "assistant", "content": assistant_content})

        if resp.stop_reason != "tool_use":
            log["final_text"] = "\n".join(text_chunks)
            log["stop_reason"] = resp.stop_reason
            print(f"[{run_id}] DONE — stop_reason={resp.stop_reason}")
            return log

        # Execute each tool_use against MCP server
        tool_results: list[dict[str, Any]] = []
        for use in tool_uses:
            print(f"[{run_id}] → MCP call: {use['name']}({json.dumps(use['input'])[:120]})")
            try:
                result = mcp.call_tool(use["name"], use["input"])
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": use["id"],
                    "content": result[:8000],
                })
                log["tool_calls"].append({"name": use["name"], "input": use["input"], "ok": True})
                print(f"[{run_id}]   ← {result[:200]}")
            except Exception as e:
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": use["id"],
                    "content": f"Error: {e}",
                    "is_error": True,
                })
                log["tool_calls"].append({"name": use["name"], "ok": False, "error": str(e)})
                print(f"[{run_id}]   ← ERROR: {e}")

        messages.append({"role": "user", "content": tool_results})

    print(f"[{run_id}] hit max iterations")
    log["stop_reason"] = "max_iterations"
    return log


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Run a single investigation")
    parser.add_argument("--watch", type=int, metavar="SECONDS", help="Loop every N seconds")
    args = parser.parse_args()

    if not args.once and not args.watch:
        args.once = True

    api_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("SCRAMBLE_ANTHROPIC_KEY")
    if not api_key:
        print("ERROR: set ANTHROPIC_API_KEY (or SCRAMBLE_ANTHROPIC_KEY)", file=sys.stderr)
        return 1

    # Pass DripOps env to the MCP server subprocess
    mcp_env = os.environ.copy()
    mcp_env.setdefault("HEC_BRIDGE_URL", "https://dripops-splunk-hec-bridge.thom-rvr.workers.dev")
    # Splunk/GitHub/TG vars passed through from os.environ

    client = anthropic.Anthropic(api_key=api_key)

    def run_once() -> None:
        mcp = McpStdioClient(["node", str(MCP_SERVER_JS)], mcp_env)
        try:
            log = run_investigation(client, mcp)
            print(f"\n=== run summary ===\n{json.dumps(log, indent=2, default=str)}")
        finally:
            mcp.close()

    if args.once:
        run_once()
    else:
        while True:
            try:
                run_once()
            except Exception as e:
                print(f"investigation crashed: {e}", file=sys.stderr)
            print(f"\nsleeping {args.watch}s...\n")
            time.sleep(args.watch)
    return 0


if __name__ == "__main__":
    sys.exit(main())
