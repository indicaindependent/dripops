# Runbook — Campaign validator regression

## Symptom
- `campaign-validator-worker` emits `validation_completed` events with `blocked=true`
  at >50% rate over 1 hour.

## Diagnosis
```spl
index=main source=campaign-validator-worker event_type=validation_completed
| stats count(eval(blocked=true)) as blocked, count as total by campaign_id
| eval block_rate = round(blocked/total*100, 1)
| where block_rate > 50
```

## Remediation
1. Check the most-violated rule: usually R4 (multi-line bullets) or R2 (hashtag clean).
2. Run the failing campaign through validator's `/dripops-diag` endpoint manually.
3. Most likely cause: a new content writer (Pete experimenting, or LLM hallucinating
   doctrine). Fix in the LLM prompt, not in the validator.

## Alert template
```
:| Validator block rate at {rate}% on campaign {campaign_id} — top violation: R{rule}.
Last 3 blocked posts attached. Want me to soften R{rule} for one cycle?
```
