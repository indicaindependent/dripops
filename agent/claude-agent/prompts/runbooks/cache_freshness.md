# Runbook — Tuck cache freshness drift

## Symptom
- `tuck-cache-refresh` emits `freshness_drift` events.
- OR `prices_tickers` count drops below 8 in a `cache_refreshed` event.
- OR `cache_refreshed` events stop appearing entirely (cron failed).

## Diagnosis
```spl
index=main source=tuck-cache-refresh
| stats latest(_time) as last_event by event_type
| eval age_min = round((now() - last_event) / 60, 1)
```

If `cache_refreshed` age > 12h (skipping a cron run) → **incident**.
If `freshness_drift` count ≥ 3 in the last hour → user-facing staleness.

## Remediation
1. Check CF Worker cron status: should be `0 10,17 * * 1-5` (6 AM + 1 PM ET).
2. Check Yahoo Finance rate-limit: `tuck-cache-refresh` pulls 12 tickers
   per refresh. If 429s spike, add a 200ms sleep between tickers.
3. **PR title:** `fix(tuck-cache-refresh): throttle Yahoo Finance fetches`

## Alert template
```
:/ Tuck cache stale — last successful refresh {age_min} min ago.
Failed tickers: {failed_count}/12. Investigating Yahoo rate limit.
```
