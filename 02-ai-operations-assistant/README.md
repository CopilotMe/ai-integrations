# AI Operations Assistant

Inbound support email is classified by an LLM, routed by deterministic business
rules, and — when it matters — **held for a human to authorise**. Every step is
written to an append-only audit trail that the application itself cannot rewrite.

```
Email ─► n8n ─► POST /api/v1/messages ─► classify ─► autonomy policy ─┬─► execute
                                                                      └─► human approves ─► execute
                                          every step ─► audit log (append-only)
```

This is the software layer underneath an automation, not another automation.
n8n moves the email; this decides what may happen to it, remembers what did, and
can tell you six weeks later who approved it and why.

## The idea

> **The model proposes. The policy decides. A human authorises anything that matters.**

The model returns a classification and a *proposed* action. A pure function then
decides whether the system may act alone, scored on **confidence × blast
radius** — how much damage the action does if it is wrong.

| Action | Blast radius | Auto-executes? |
| --- | --- | --- |
| `create_ticket` | low | above 0.75 confidence |
| `send_templated_reply` | medium | above 0.90 confidence |
| `issue_refund`, `cancel_subscription`, `update_account` | **high** | **never, by default** |

Hard stops — VIP domains, complaints, cancellations, refunds without an amount,
anything below the confidence floor — are evaluated *before* the threshold, so a
confident model can never argue past a rule.

Full write-up: [`docs/autonomy-policy.md`](docs/autonomy-policy.md).

## Run it with no accounts

Every external system has an offline fake. No API key, no network, no spend.

```bash
npm install
npm run db:up && npm run db:migrate && npm run db:seed
npm run demo
npm run dev
```

`npm run demo` posts eight representative messages — including the ones that
should *not* auto-execute — through the real pipeline:

```
Message                                    Route  Intent            Conf  Action                Blast   Decided by
Duplicate charge, refund requested         HUMAN  refund_request    0.63  issue_refund          high    refund_above_cap
Password reset, clear technical issue      auto   technical_issue   0.86  create_ticket         low     cleared_threshold
Angry complaint threatening legal action   HUMAN  complaint         0.94  escalate_to_human     low     always_review_intent
Invoice question                           HUMAN  billing_question  0.89  send_templated_reply  medium  below_action_threshold
Obvious spam                               auto   spam              0.95  no_action             none    cleared_threshold
Cancellation                               HUMAN  cancellation      0.61  escalate_to_human     low     always_review_intent
Non-English message                        HUMAN  other             0.35  escalate_to_human     low     below_minimum_confidence
Vague enquiry                              HUMAN  other             0.35  escalate_to_human     low     below_minimum_confidence

2 auto-executed · 6 held for a human
```

Then open <http://localhost:3000> and work the queue as `agent@example.com`.

## The console

A dark, dense operations console — deliberately single-theme, because the amber
"needs you" signal should be the brightest thing on the screen.

- **Review queue** — pending approvals first, with a four-segment blast-radius
  meter you learn to read before the words next to it.
- **Case detail** — the original email, the classification with a confidence
  gauge marked at the threshold it had to clear, the policy verdict with every
  rule that fired, and the approve/reject panel.
- **Decision ledger** — the case's flight recorder. Machine events in grey,
  human decisions in amber, in order, never summarised.
- **Audit log** — every event across every case.

An operator can approve, reject, or **authorise something different from what
was proposed** — the audit entry records both and flags the override.

## Connecting the real thing

Copy `.env.example` to `.env`. Each provider switches independently, so a real
OpenAI key can go in while the executor stays fake.

| Variable | `fake` (default) | Real |
| --- | --- | --- |
| `LLM_PROVIDER` | keyword matcher | `openai` + `OPENAI_API_KEY` |
| `TICKETING_PROVIDER` | in-memory, idempotent | `http` + `TICKETING_WEBHOOK_URL` |
| `NOTIFIER_PROVIDER` | collected in memory | `slack` + `SLACK_WEBHOOK_URL` |

The app refuses to start if a provider is selected without its credential, or if
`SESSION_SECRET` is weak in production.

Database: `DATABASE_URL` points at the local Docker Postgres, or at Supabase,
Neon, or any managed Postgres. Nothing in the schema is vendor-specific.

## What makes this more than a pipeline

**An audit log the application cannot rewrite.** Postgres triggers reject
`UPDATE` and `DELETE` on `audit_log`, and `UPDATE` on `messages`. Enforced in
[`drizzle/0001_audit_log_append_only.sql`](drizzle/0001_audit_log_append_only.sql),
and asserted by a test that tries and is refused.

**Two operators cannot approve the same case.** Cases carry a `version` bumped
by a trigger; an approval sends the version the operator was looking at, and a
mismatch returns `409`. Approving something other than what you read is the
failure mode this exists to prevent.

**Nothing is executed twice.** Actions are claimed against a unique
`idempotency_key` *before* the side effect, so a retry converges on the existing
result instead of issuing a second refund.

**A failed classification loses nothing.** The case is committed before the
model is called. If the model is down, the case is durable, marked `failed`,
with the reason in the audit trail — not a lost email and a 500.

**Every decision is explainable.** Each `policy_decisions` row stores the
verdict, both confidences, every rule that fired, and **a snapshot of the policy
configuration in force at the time** — so a decision from three months ago is
not re-read against today's thresholds.

## Tests

```bash
npm run db:up && npm test
```

62 tests, under two seconds.

- **Policy** — every action has a blast radius; thresholds are inclusive;
  refunds never auto-execute by default; hard stops beat confidence; every rule
  that fires is reported; the function is pure.
- **Domain** — the state machine refuses to skip classification or move out of a
  terminal state; idempotency keys are stable per case+action and *differ* when
  the refund amount changes.
- **Crypto** — scrypt round-trips, salts, stores its cost parameters, survives a
  corrupt hash, handles unicode-equivalent passwords.
- **Integration, against real Postgres** — auto-execute and approval paths end to
  end; three concurrent deliveries of one email produce one case; a classifier
  failure leaves a durable inspectable case; a stale version is refused; the
  audit log rejects `UPDATE` and `DELETE`; correlation ids thread through
  everything.

## Layout

```
src/core/domain/     Schemas, the case state machine, audit vocabulary — no I/O
src/core/policy/     The autonomy policy: a pure function
src/core/pipeline/   The two use cases: intake, and approval
src/core/ports/      Interfaces the pipeline depends on
src/adapters/        OpenAI, Slack, HTTP executor + an offline fake for each
src/db/              Drizzle schema, repositories, migrations
src/server/          Composition root, auth, HTTP error mapping
src/app/api/         REST route handlers (thin)
src/app/(console)/   The operator console
```

`core/` imports nothing from `next` and nothing from `adapters/`. The pipeline is
tested without booting a server.

## Docs

- [`docs/autonomy-policy.md`](docs/autonomy-policy.md) — blast radius, thresholds, hard stops, how to tune it
- [`docs/decisions.md`](docs/decisions.md) — the seven choices worth arguing about
- [`docs/api.md`](docs/api.md) — endpoints, auth, status codes
- [`docs/n8n-setup.md`](docs/n8n-setup.md) — importing the workflow, and what deliberately isn't in it

## Deliberately not built

- **No Slack approve button.** Slack gets a link. A button that mutates state
  needs its own signature verification and identity model — three ways to get
  authorisation wrong to save one click, on exactly the actions that reach a
  human because they move money.
- **No queue or worker.** Intake is synchronous. It is fast enough at this
  volume, and [project 01's load simulation](../01-ai-lead-qualification-n8n-load)
  already covers what a queue buys and what it costs.
- **No auth provider.** The surface is a handful of named operators with no
  signup and no password reset. `src/server/auth.ts` is the single file that
  changes the day it needs SSO — see [decision 5](docs/decisions.md).
- **No eval harness.** Meaningful only against labelled real support email. The
  classifier sits behind a port so one can be added when that data exists.
