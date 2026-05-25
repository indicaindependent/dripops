#!/usr/bin/env python3
"""
patch_campaign_validator.py — apply DripOps instrumentation to campaign-validator-worker
Idempotent: detects existing marker and skips if already patched.

Adds:
  1. emitDripops() helper next to notifyPete()
  2. Emit "validation_completed" in /validate after computing result
  3. Emit also fires the 'blocked' case (it's still "completed" with blocked=true)
"""
import sys, shutil, datetime

SRC = "dripops/sources/campaign-validator-worker.original.js"
OUT = "dripops/sources/campaign-validator-worker.patched.js"

with open(SRC) as f:
    content = f.read()

if "DRIPOPS_INSTRUMENTATION_V1" in content:
    print("ALREADY_PATCHED — copying as-is.")
    shutil.copy(SRC, OUT)
    sys.exit(0)

# ============================================================
# PATCH 1: insert emitDripops() helper right after notifyPete()
# ============================================================
EMIT_BLOCK = '''
// DRIPOPS_INSTRUMENTATION_V1 — May 25 2026
// Best-effort observability emit. Fire-and-forget. Never blocks the response.
async function emitDripops(env, eventType, severity, fields) {
  if (!env.DRIPOPS_INGEST_KEY) return;
  const url = env.DRIPOPS_BRIDGE_URL || 'https://dripops-splunk-hec-bridge.thom-rvr.workers.dev/event';
  try {
    // Use ctx.waitUntil if available — but in this codebase we don't have ctx,
    // so we use a non-awaited promise wrapped in catch.
    fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.DRIPOPS_INGEST_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: 'campaign-validator-worker',
        event_type: eventType,
        severity: severity || 'info',
        host: 'cf-worker',
        ...fields,
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch (e) { /* swallow */ }
}

'''

marker = "} catch (e) { console.log('TG notify failed:', e.message); }\n}\n"
if marker not in content:
    print("FATAL: notifyPete end marker not found verbatim")
    sys.exit(1)
content = content.replace(marker, marker + EMIT_BLOCK, 1)
print("OK Patch 1: emitDripops helper inserted after notifyPete")

# ============================================================
# PATCH 2: emit in /validate handler — right before the final `return json(result);`
# ============================================================
old_validate_return = '''        await notifyPete(env, `⚠️ *Campaign Validation BLOCKED*\\n\\nCampaign: ${body.campaign_id || 'unnamed'}\\nRating: ${result.stars}/5.0\\nViolations: ${result.summary.totalViolations}\\nWarnings: ${result.summary.totalWarnings}\\n\\n${violationSummary}`);
      }

      return json(result);
    }'''

new_validate_return = '''        await notifyPete(env, `⚠️ *Campaign Validation BLOCKED*\\n\\nCampaign: ${body.campaign_id || 'unnamed'}\\nRating: ${result.stars}/5.0\\nViolations: ${result.summary.totalViolations}\\nWarnings: ${result.summary.totalWarnings}\\n\\n${violationSummary}`);
      }

      // DRIPOPS_INSTRUMENTATION_V1 — emit validation outcome
      await emitDripops(env, 'validation_completed', result.blocked ? 'warning' : 'info', {
        campaign_id: body.campaign_id || 'unnamed',
        stars: result.stars,
        passing: result.passing === true,
        blocked: result.blocked === true,
        post_count: posts.length,
        total_violations: result.summary && result.summary.totalViolations,
        total_warnings: result.summary && result.summary.totalWarnings,
        doctrine_version: DOCTRINE_VERSION,
      });

      return json(result);
    }'''

if old_validate_return not in content:
    print("FATAL: /validate return block not found verbatim")
    sys.exit(1)
content = content.replace(old_validate_return, new_validate_return, 1)
print("OK Patch 2: /validate emit added")

# ============================================================
# Write output
# ============================================================
with open(OUT, "w") as f:
    f.write(content)

print(f"OK Wrote {OUT} ({len(content)} bytes)")
print()
print("Next: deploy patched worker via cf-worker-deploy-via-kv skill,")
print("       then set DRIPOPS_INGEST_KEY + DRIPOPS_BRIDGE_URL secrets.")
