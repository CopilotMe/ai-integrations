# REST API

Base URL: `/api`. Every response carries `correlation_id`, echoed from an
inbound `x-request-id` when present so one identifier traces a message across
n8n, this service, and the audit log.

## Authentication

Two independent identities, on purpose — **a key that can post messages must not
be able to approve them.**

| Caller | Mechanism | Used by |
| --- | --- | --- |
| Machine | `Authorization: Bearer opsk_…` | n8n intake |
| Operator | `ops_session` cookie, `httpOnly` `SameSite=Lax` | The console |

Machine keys carry scopes (`intake`). Operators carry a role (`admin`, `agent`,
`viewer`); `viewer` is read-only and receives `403` on any mutation.

All mutating requests are checked for a same-origin `Origin` header.

## Endpoints

### `POST /api/v1/messages` — intake

Auth: API key with `intake` scope. Optional `Idempotency-Key`.

```json
{
  "external_id": "gmail-18f2a1c",
  "source": "n8n:gmail",
  "from_email": "nina@northwind.de",
  "to_email": "support@example.com",
  "subject": "Charged twice for October",
  "body": "I was charged EUR 49 twice. Please refund the duplicate charge."
}
```

`201` on a new case, `200` when the message was already ingested:

```json
{
  "case_id": "ca8e4a5d-…",
  "state": "pending_approval",
  "duplicate": false,
  "classification": { "intent": "refund_request", "confidence": 0.63, "...": "…" },
  "decision": {
    "verdict": "require_approval",
    "action": "issue_refund",
    "blast_radius": "high",
    "decided_by": "refund_above_cap",
    "triggered": [{ "rule": "refund_above_cap", "detail": "Refund of EUR 49 exceeds…" }]
  },
  "external_ref": null,
  "correlation_id": "…"
}
```

Replaying an `Idempotency-Key` returns the stored response with
`Idempotent-Replay: true`. Reusing one with a *different* body is `409` — that
is a client bug, and silently accepting it would hide it.

### `GET /api/v1/cases`

Auth: operator. `?state=pending_approval&q=search&limit=50&offset=0`. Cases
awaiting a human sort first regardless of age; nothing else is blocked on a
person.

### `GET /api/v1/messages/:id`

Auth: operator. The full case: message, every classification, every policy
decision, approvals, actions, and the complete audit trail.

### `POST /api/v1/messages/:id/approve`

Auth: operator, non-`viewer`.

```json
{
  "expected_version": 3,
  "reason": "Verified duplicate charge NW-88231 in billing",
  "override_action": "create_ticket",
  "override_refund_eur": 49
}
```

`expected_version` is the case version the operator was looking at. A mismatch
returns `409` — see [decision 3](decisions.md). The overrides let an operator
authorise something other than what was proposed; the audit entry records both,
and flags `overridden: true`.

### `POST /api/v1/messages/:id/reject`

Auth: operator, non-`viewer`. `reason` is **required** — why something was
refused is the part nobody can reconstruct later.

### `GET /api/v1/audit`

Auth: operator. `?case_id=…&event=approval.granted&since=2026-09-01&limit=100`.

### `GET /api/v1/stats`

Auth: operator. Case counts by state, intent distribution, token totals, and
`autonomy_rate` — the share of decisions that did not need a person, which is
the number to watch when tuning thresholds.

### `GET /api/health`

No auth. Checks the database, not just the process — a health endpoint that
reports green through a database outage is worse than none. `503` when the
database is unreachable.

## Status codes

Chosen for what the caller should do about them:

| Code | Meaning |
| --- | --- |
| `200` / `201` | Done. `200` also means "already ingested" |
| `401` / `403` | Not authenticated / not permitted. Do not retry |
| `409` | Someone changed it first, or a key was reused with a different body. Reload |
| `422` | Payload is wrong, with per-field `issues`. Do not retry |
| `502` | A dependency failed. Retryable, with `Retry-After` |
| `503` | The database is unreachable |

Unexpected errors return a bare `internal_error`. The detail goes to the logs
with the correlation id — an error message can carry connection strings, row
contents or stack frames, and none of that belongs in a response body.
