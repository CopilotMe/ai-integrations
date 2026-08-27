# n8n setup

[`workflows/lead-qualification.json`](../workflows/lead-qualification.json)
imports into n8n 1.6x+ (tested against the node type versions listed below).

## 1. Start the service

n8n calls this service over HTTP, so it has to be reachable from wherever n8n
runs. For a local n8n in Docker, that is `http://host.docker.internal:3000`.

```bash
npm run dev
```

## 2. Import the workflow

**Workflows → Import from File →** `workflows/lead-qualification.json`.

## 3. Set the environment variables n8n reads

In n8n's own environment (not this project's `.env`):

| Variable | Example |
| --- | --- |
| `LEAD_SERVICE_URL` | `http://host.docker.internal:3000` |
| `LEAD_SERVICE_SECRET` | must match `WEBHOOK_SECRET` in this project's `.env` |
| `SLACK_SALES_CHANNEL` | `sales-leads` |
| `SLACK_MARKETING_CHANNEL` | `marketing-nurture` |
| `HUBSPOT_DEAL_STAGE_HOT` | `appointmentscheduled` |
| `HUBSPOT_DEAL_STAGE_WARM` | `qualifiedtobuy` |

Self-hosted n8n needs `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` for `$env` to resolve
inside expressions.

## 4. Attach credentials

Imported credentials are placeholders (`REPLACE_ME`) — n8n never exports secrets,
which is why they have to be selected by hand:

- **HubSpot** (`Upsert HubSpot contact`, `Create deal (HOT)`, `Create deal (WARM)`) —
  a Private App token with `crm.objects.contacts.read/write` and
  `crm.objects.deals.read/write`.
- **Slack** (`Alert sales (HOT)`, `Queue nurture (WARM)`) — OAuth2 with
  `chat:write`.

Create the custom deal property `spesti_idempotency_key` (single-line text) in
HubSpot if you want deal-level deduplication on the HubSpot side too.

## 5. Test it

Copy the test webhook URL from the `Lead webhook` node, then:

```bash
curl -s -X POST '<TEST_WEBHOOK_URL>' -H 'content-type: application/json' -d '{"name":"John Smith","email":"john.smith@acme.co","company":"Acme Ltd","employees":120,"budget":25000,"message":"We need to automate customer support. Our current process is manual."}'
```

Expected: `{"status":"accepted","classification":"HOT","score":100,"next_action":"sales_call","correlation_id":"..."}`

To watch the branches without touching HubSpot, leave this project's providers
on `fake` and call `/v1/qualify` directly — the routing decision is identical,
only the CRM writes are stubbed.

## The graph

```
Lead webhook
   └─► Qualify lead ──(error)──► Respond error (502)
          │
          └─► Upsert HubSpot contact
                 └─► Route by classification
                        ├─ HOT  ─► Create deal (HOT)  ─► Alert sales (HOT)   ─┐
                        ├─ WARM ─► Create deal (WARM) ─► Queue nurture (WARM) ┼─► Respond 200
                        └─ COLD ─► Archive (no-op) ────────────────────────────┘
```

Node type versions: `webhook@2`, `httpRequest@4.2`, `hubspot@2`, `switch@3.2`,
`slack@2.2`, `respondToWebhook@1.1`, `noOp@1`.

## Reliability settings baked into the workflow

| Node | Setting | Reason |
| --- | --- | --- |
| `Qualify lead` | `retryOnFail`, 3 tries, 2s apart | The service is idempotent, so retrying is safe |
| `Qualify lead` | `onError: continueErrorOutput` | A `422` (bad lead) answers the caller instead of retrying forever |
| HubSpot nodes | `retryOnFail`, 3 tries, 3s apart | Absorbs HubSpot's rate limits |
| Slack nodes | `onError: continueRegularOutput` | A missed ping must not fail a lead already in HubSpot |

The workflow deliberately does **not** re-implement routing. It switches on
`qualification.classification` from the service, so the decision has exactly one
implementation and cannot drift between the two systems.

## Which parts belong where

| Concern | Owner | Why |
| --- | --- | --- |
| Webhook, branching, retries, credentials | n8n | Visible to non-engineers, changeable without a deploy |
| Validation, model call, scoring, routing | Service | Needs tests, version control and review |
| CRM and Slack writes | n8n | Native nodes, no API client to maintain |

`POST /v1/leads` does the CRM and Slack writes too, for anyone who wants the
integration without running n8n. Both paths share the same decision code.
