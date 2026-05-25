# Runbook — JWT auth drift (schedule-worker-v3 / bsky-worker)

## Symptom
- `drip-watchdog` emits `fire_failed` events with `error_message` containing
  `401`, `unauthorized`, or `invalid_token`.
- OR `validation_completed` rate drops to zero while no campaigns are running.

## Diagnosis
```spl
index=main source IN ("drip-watchdog","schedule-worker-v3") severity=error
| where match(error_message, "(?i)(401|unauthorized|invalid.token|jwt)")
| stats count by source, error_message
| sort -count
```

If count ≥ 5 in the last 15 min → **incident**.

## Remediation
1. The JWT cache in `schedule-worker-v3` (D1 table `bsky_auth_cache`) has a 90-minute
   TTL. The bsky atproto session token usually lives ~120 min — drift happens when
   the bsky server expires sessions early.
2. **Fix:** bump TTL to 60 min and add a `refresh-on-401` retry.
3. **Code location:** `workers/schedule-worker-v3/src/auth.ts`, constant `JWT_TTL_MS`.
4. **PR title:** `fix(schedule-worker-v3): bump JWT cache TTL + retry on 401`

## Alert template (if escalating instead of PR-ing)
```
:O JWT drift detected — {count} 401s in the last 15min across {sources}.
Last error: {sample_error_message}
Suggest: bump JWT TTL to 60 min + retry-on-401. Want me to open a PR?
```
