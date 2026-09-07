# AI CRM Lead Qualification — GoHighLevel + Claude + n8n

A GoHighLevel contact webhook is qualified by Claude, routed by deterministic
rules, and written back to the CRM as custom fields and a routing tag that the
follow-up automation triggers on.

```
GoHighLevel ─► n8n ─► POST /v1/leads ─► Claude ─► routing rules ─► GHL write-back ─► follow-up
   webhook      normalise   validate    structured   score gate      fields + tag      by tag
                            + claim      output    + confidence gate
```

> **The model proposes. Deterministic rules decide.**

## What is different about this one

Project 01 also qualifies leads, so the honest version of the difference:

| | 01 — HubSpot | **03 — GoHighLevel** |
| --- | --- | --- |
| Model | OpenAI | **Claude**, `output_config.format` structured outputs |
| CRM | HubSpot contacts + deals | **GoHighLevel** custom fields, resolved by id per sub-account, plus a route tag |
| Routing | Score thresholds | **Score *and* confidence gates**, one-tier-drop rule |
| Idempotency | Keyed on lead content | **Keyed on the GHL delivery id, claimed *before* the model call** |

The shared principle is the point — it is worth showing twice against different
stacks — but the two projects fail differently, and that is where the work is.

## The idea: two gates, not one

Score says *how good the lead looks*. Confidence says *how much the model's
reading of it can be relied on*. Only the second tells you whether to spend a
person's hour on it.

> A lead must clear both the score and the confidence gate for its tier. If it
> clears the score but not the confidence, it drops **exactly one tier** — never
> straight to archive.

That asymmetry is deliberate, and it follows from the asymmetry in the costs:

| Outcome | Costs | Reversible |
| --- | --- | --- |
| `sales` | an hour of a salesperson's time | yes, expensively |
| `nurture` | almost nothing | yes |
| `low_priority` | the lead | **no** |

So low confidence is allowed to block an escalation, but never to throw a lead
away. Archiving belongs to the score alone.

| Condition | Route |
| --- | --- |
| score ≥ 80 **and** confidence ≥ 0.80 | `sales` |
| score ≥ 80, confidence < 0.80 | `nurture` — one tier down, and recorded as an override |
| score ≥ 50 **and** confidence ≥ 0.70 | `nurture` |
| score ≥ 50, confidence < 0.70 | `low_priority` |
| score < 50 | `low_priority` |
| blocked email domain | `low_priority`, whatever the score |

Every threshold is environment configuration.

## Run it with no accounts

```bash
npm install
npm run demo
```

```
  rules: hot ≥ 80 & conf ≥ 0.8 · warm ≥ 50 & conf ≥ 0.7

  Lead                                      Route         Score  Conf  Overrode model  Applied rule
  ────────────────────────────────────────  ────────────  ─────  ────  ──────────────  ─────────────────────────────
  Enterprise, budget stated, urgent         sales         100    0.97  no              hot_score_and_confidence
  Mid-market, real interest, few details    nurture        94    0.65  yes             hot_downgraded_low_confidence
  Strong words, almost nothing to go on     low_priority   62    0.31  yes             warm_downgraded_low_confidence
  Job enquiry                               low_priority    5    0.43  no              score_below_warm_threshold
  Competitor on the blocklist               low_priority  100    0.76  yes             hard_stop:blocked_email_domain
  Redelivery of lead #1 (GHL retry)         — dup —       100    0.97  no              hot_score_and_confidence
  ContactUpdate for lead #1 (new event id)  nurture        93    0.76  yes             hot_downgraded_low_confidence
  Invalid payload (no email)                ✗ rejected     —      —    —               email: expected string, received undefined

  CRM state: 5 contacts, 6 writes
```

Row 2 is the whole design in one line: a lead that **scores 94** is not sent to
sales, because the model was only 65% sure of its reading.

Then the service:

```bash
npm run dev
```

```bash
curl -s localhost:3000/v1/leads -H 'content-type: application/json' -d '{"contact_id":"c1","event_id":"e1","email":"nina@northwind.de","company":"Northwind","employees":450,"budget_eur":60000,"inquiry":"We need to automate support this quarter, budget approved."}' | jq
```

## Connecting the real thing

Copy `.env.example` to `.env`. Each provider switches independently, so a real
Claude key can go in while the CRM stays fake.

| Variable | `fake` (default) | Real |
| --- | --- | --- |
| `LLM_PROVIDER` | deterministic heuristic | `claude` + `ANTHROPIC_API_KEY` |
| `CRM_PROVIDER` | in-memory, records writes | `ghl` + `GHL_ACCESS_TOKEN` + `GHL_LOCATION_ID` |

The service refuses to start if a provider is selected without its credential,
or if the thresholds would make a tier unreachable.

- [`docs/ghl-setup.md`](docs/ghl-setup.md) — the custom fields to create, the Private Integration scopes, and why the location id is required
- [`docs/n8n-setup.md`](docs/n8n-setup.md) — importing the workflow and what deliberately isn't in it

## Failure handling

| Failure | Behaviour | Test |
| --- | --- | --- |
| Invalid payload | `422` with per-field issues, **before** any model call | 4 |
| Claude timeout | Aborted and retried with jitter; after the budget, `504`, no partial write | 6 |
| Malformed / schema-invalid output | Retried as transient; a `401` is **not** retried | 7 |
| Claude refuses | `stop_reason: "refusal"` detected before parsing; surfaced as permanent | — |
| GoHighLevel 5xx | Retried honouring `Retry-After`; a `4xx` is not | 8 |
| Transient failure after the claim | **Claim released**, so the sender's retry is not swallowed | 8 |
| Duplicate delivery | One classification, one write — including under concurrency | 9 |
| Same contact, new event | Qualified again, one contact updated | 10 |

## Tests

```bash
npm test
```

30 tests, no network, under a second. Every one of the ten scenarios in
[`docs/test-scenarios.md`](docs/test-scenarios.md) is a real test — routing is
tested against the policy, and validation, retries, idempotency and CRM failure
are tested through the pipeline with stub ports and spies.

## Layout

```
src/domain/      GHL webhook + Claude output schemas — no I/O
src/policy/      The routing rules: a pure function
src/pipeline/    validate → claim → assess → route → write back
src/ports.ts     Interfaces the pipeline depends on
src/adapters/    Claude, GoHighLevel + an offline fake for each
src/lib/         Retry with jitter, idempotency store, errors, logger
workflows/       The importable n8n workflow
```

## Docs

- [`docs/architecture.md`](docs/architecture.md) — flow diagram, trust boundaries, the invariant
- [`docs/decisions.md`](docs/decisions.md) — the six choices worth arguing about
- [`docs/test-scenarios.md`](docs/test-scenarios.md) — all ten, mapped to real tests
- [`docs/ghl-setup.md`](docs/ghl-setup.md) · [`docs/n8n-setup.md`](docs/n8n-setup.md) · [`prompts/qualify-lead.md`](prompts/qualify-lead.md)

## Deliberately not built

- **No database.** The idempotency store is in-memory and therefore
  single-process — a real limit, written down in [decision 3](docs/decisions.md)
  with the Redis one-liner that fixes it.
- **No Marketplace app.** A Private Integration is the right scope for one
  sub-account; a public OAuth app is a different project.
- **No dashboard.** [Project 02](../02-ai-operations-assistant) is where the
  operator console lives.
- **No eval harness.** Meaningful only against labelled real leads. The
  assessor sits behind a port so one can be added when that data exists.
