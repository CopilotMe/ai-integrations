# n8n setup

[`workflows/inbound-email-intake.json`](../workflows/inbound-email-intake.json)
imports into n8n 1.6x+.

```
Gmail trigger
   └─► Normalise (Code) ─► POST /api/v1/messages ──(error)──► Alert on intake failure
                                    │
                                    └─► Needs a human?
                                           ├─ yes ─► Alert reviewers (Slack) ─┐
                                           └─ no  ─────────────────────────────┼─► Label handled
```

## 1. Create an API key

The seed script prints one. To mint another, insert a row into `api_keys` with
the SHA-256 of a token you generate — the plaintext is never stored:

```bash
node -e "const{randomBytes,createHash}=require('crypto');const t='opsk_'+randomBytes(32).toString('base64url');console.log('token:',t);console.log('hash: ',createHash('sha256').update(t).digest('hex'))"
```

## 2. Set n8n's environment

| Variable | Example |
| --- | --- |
| `OPS_API_URL` | `http://host.docker.internal:3000` |
| `OPS_APP_URL` | `http://localhost:3000` (used in Slack deep links) |
| `OPS_API_KEY` | the `opsk_…` token |
| `OPS_REVIEW_CHANNEL` | `support-approvals` |
| `OPS_ALERT_CHANNEL` | `ops-alerts` |
| `OPS_HANDLED_LABEL_ID` | a Gmail label id |

Self-hosted n8n needs `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` for `$env` to resolve
inside expressions.

## 3. Attach credentials

Imported credentials are placeholders (`REPLACE_ME`) — n8n never exports secrets.
Gmail OAuth2 on the trigger and the label node, Slack OAuth2 with `chat:write`
on both Slack nodes.

## Reliability settings, and why

| Node | Setting | Reason |
| --- | --- | --- |
| `POST /v1/messages` | `retryOnFail`, 3 tries | Intake is idempotent, so retrying is safe |
| `POST /v1/messages` | `Idempotency-Key: gmail-<id>` | A retry replays the original response rather than re-running the pipeline |
| `POST /v1/messages` | `onError: continueErrorOutput` | A `422` answers into the alert branch instead of retrying a payload that will never become valid |
| Slack nodes | `onError: continueRegularOutput` | A missed ping must never fail an intake that already succeeded |
| Gmail label | `onError: continueRegularOutput` | Same |

## What deliberately does **not** happen in n8n

**Approval.** Slack gets a link, not a button.

A Slack button that mutates state needs its own request-signature verification,
its own identity model, and its own path into the audit log — three ways to get
authorisation wrong, for the sake of one fewer click. One authenticated path
into one audit trail is worth more than the convenience, particularly for the
actions that reach a human precisely *because* they move money.

**Classification and routing.** n8n normalises and delivers; the service
classifies and decides. That keeps one implementation of the policy, under test,
rather than a copy in a Code node that drifts.
