# n8n setup

[`workflows/ghl-lead-qualification.json`](../workflows/ghl-lead-qualification.json)
imports into n8n 1.6x+.

```
GHL contact webhook
   └─► Normalise GHL payload (Code)
          └─► POST /v1/leads ──(error)──► Respond 502
                 └─► Route
                        ├─ sales        ─► Alert sales (Slack)    ─┐
                        ├─ nurture      ─► Start nurture workflow  ┼─► Respond 200
                        └─ low_priority ─► No follow-up ───────────┘
```

## 1. Start the service

```bash
npm run dev
```

For n8n in Docker, it is reachable at `http://host.docker.internal:3000`.

## 2. Environment variables in n8n

| Variable | Example |
| --- | --- |
| `QUALIFY_SERVICE_URL` | `http://host.docker.internal:3000` |
| `QUALIFY_SERVICE_SECRET` | must match `WEBHOOK_SECRET` in the service's `.env` |
| `GHL_API_BASE` | `https://services.leadconnectorhq.com` |
| `GHL_ACCESS_TOKEN` | Private Integration token |
| `GHL_LOCATION_ID` | sub-account id (used to build the contact deep link) |
| `GHL_NURTURE_WORKFLOW_ID` | the workflow to add nurture leads to |
| `GHL_SALES_CHANNEL` | `sales-leads` |

Self-hosted n8n needs `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` for `$env` to resolve
inside expressions.

## 3. Attach credentials

Imported credentials are placeholders (`REPLACE_ME`) — n8n never exports
secrets. Slack OAuth2 with `chat:write`, and an HTTP Header Auth credential for
the GoHighLevel call.

## Reliability settings, and why

| Node | Setting | Reason |
| --- | --- | --- |
| `Qualify lead` | `retryOnFail`, 3 tries | The service claims the event id before calling Claude, so a retry cannot produce a second classification or a second write |
| `Qualify lead` | `onError: continueErrorOutput` | A `422` answers the webhook instead of retrying a payload that will never become valid |
| `Start nurture workflow` | `retryOnFail`, then `continueRegularOutput` | Absorbs GHL rate limits; a failure here must not fail a lead already written to the CRM |
| `Alert sales` | `onError: continueRegularOutput` | Same — a missed Slack ping is an annoyance, not a lost lead |

## What deliberately does *not* happen in n8n

**Claude is not called from a Code node, and routing is not implemented in one.**
Both live in the service, where they are unit tested and reviewable in a diff. A
Code node cannot be run in CI, and a copy of the routing rules in n8n is a copy
that drifts from the tested one the first time a threshold changes.

What n8n *does* own is the part that genuinely belongs to the integration layer:
GoHighLevel's three inconsistent webhook shapes, the credentials, and what
happens after a route is chosen.
