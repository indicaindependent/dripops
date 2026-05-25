#!/usr/bin/env python3
"""
dripops_watchdog_patch.py — apply DripOps instrumentation to drip_watchdog.py
Idempotent: detects existing markers and skips if already patched.

Adds:
  1. emit_dripops_event() helper (after tg_alert)
  2. Success emit after fire_reply() in process_campaigns()
  3. Success emit after fire_p0_with_image() in process_campaigns()
  4. Failure emit in the exception handler
"""
import re, sys, shutil, datetime

SRC = "/home/ptsdpete/drip_watchdog.py"
BAK = f"/home/ptsdpete/drip_watchdog.py.bak.{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"

with open(SRC) as f:
    content = f.read()

if "# DRIPOPS_INSTRUMENTATION_V1" in content:
    print("ALREADY_PATCHED — no changes.")
    sys.exit(0)

shutil.copy(SRC, BAK)
print(f"Backup: {BAK}")

EMIT_BLOCK = '''
# DRIPOPS_INSTRUMENTATION_V1 — May 25 2026
# Best-effort observability emit to dripops-splunk-hec-bridge. Never blocks fires.
DRIPOPS_BRIDGE_URL = os.environ.get("DRIPOPS_BRIDGE_URL", "https://dripops-splunk-hec-bridge.thom-rvr.workers.dev/event")
DRIPOPS_INGEST_KEY = os.environ.get("DRIPOPS_INGEST_KEY", "")

def emit_dripops_event(event_type, severity="info", **fields):
    """Fire-and-forget event emit to the DripOps bridge. Swallows ALL errors."""
    if not DRIPOPS_INGEST_KEY:
        return
    try:
        payload = {
            "source": "drip-watchdog",
            "event_type": event_type,
            "severity": severity,
            "host": "optiplex",
            **fields,
        }
        req = urllib.request.Request(
            DRIPOPS_BRIDGE_URL,
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {DRIPOPS_INGEST_KEY}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        log.debug(f"dripops emit swallowed: {e}")

'''

marker = 'log.error(f"tg_alert failed: {e}")\n        return False\n'
if marker not in content:
    print("FATAL: tg_alert end marker not found")
    sys.exit(1)
content = content.replace(marker, marker + EMIT_BLOCK, 1)
print("OK Patch 1: emit helper inserted")

old_reply_ok = '''            uri, cid = fire_reply(text, row["root_uri"], row["root_cid"], posted_uris[-1], posted_cids[-1])
            posted_uris.append(uri)
            posted_cids.append(cid)
            new_fired = fired + 1
            new_status = "completed" if new_fired >= len(posts) else "scheduled"
            now_str = now_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z")
            d1("UPDATE campaigns SET fired_count=?, posted_uris=?, posted_cids=?, last_fired_at=?, status=?, updated_at=? WHERE id=?",
               [new_fired, json.dumps(posted_uris), json.dumps(posted_cids), now_str, new_status, now_str, row["id"]])
            log.info(f"  OK {uri}")
            time.sleep(2)'''

new_reply_ok = '''            uri, cid = fire_reply(text, row["root_uri"], row["root_cid"], posted_uris[-1], posted_cids[-1])
            posted_uris.append(uri)
            posted_cids.append(cid)
            new_fired = fired + 1
            new_status = "completed" if new_fired >= len(posts) else "scheduled"
            now_str = now_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z")
            d1("UPDATE campaigns SET fired_count=?, posted_uris=?, posted_cids=?, last_fired_at=?, status=?, updated_at=? WHERE id=?",
               [new_fired, json.dumps(posted_uris), json.dumps(posted_cids), now_str, new_status, now_str, row["id"]])
            log.info(f"  OK {uri}")
            emit_dripops_event(
                "reply_fired", severity="info",
                campaign_id=row["id"], post_index=new_fired,
                post_total=len(posts), status=new_status,
                bsky_uri=uri, bsky_cid=cid,
            )
            time.sleep(2)'''

if old_reply_ok not in content:
    print("FATAL: reply_ok block not found verbatim")
    sys.exit(1)
content = content.replace(old_reply_ok, new_reply_ok, 1)
print("OK Patch 2: fire_reply success instrumented")

old_p0_ok = '''                    p0_uri, p0_cid = fire_p0_with_image(posts[0])'''
new_p0_ok_inject = '''                    p0_uri, p0_cid = fire_p0_with_image(posts[0])
                    emit_dripops_event(
                        "p0_fired", severity="info",
                        campaign_id=row["id"], post_index=1,
                        post_total=len(posts), has_image=True,
                        bsky_uri=p0_uri, bsky_cid=p0_cid,
                    )'''

if old_p0_ok in content:
    content = content.replace(old_p0_ok, new_p0_ok_inject, 1)
    print("OK Patch 3: P0 image-fire success instrumented")
else:
    print("WARN Patch 3 skipped: P0 fire line not found exactly. Continuing.")

old_err = '''        except Exception as e:
            # PATCH 18 (May 20 2026): Alert Pete on P1+ failures + track consecutive errors
            cid = row.get('id','?')
            log.error(f"Error on {cid}: {e}")'''

new_err = '''        except Exception as e:
            # PATCH 18 (May 20 2026): Alert Pete on P1+ failures + track consecutive errors
            cid = row.get('id','?')
            log.error(f"Error on {cid}: {e}")
            emit_dripops_event(
                "fire_failed", severity="error",
                campaign_id=cid,
                error_message=str(e)[:500],
                fired_count=row.get('fired_count', 0),
            )'''

if old_err in content:
    content = content.replace(old_err, new_err, 1)
    print("OK Patch 4: failure path instrumented")
else:
    print("WARN Patch 4 skipped: exception block not found exactly. Continuing.")

with open(SRC, "w") as f:
    f.write(content)
print(f"OK Wrote patched {SRC}")
print(f"   Backup at {BAK}")
