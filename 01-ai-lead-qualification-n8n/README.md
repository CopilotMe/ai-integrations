# AI Lead Qualification & Routing — n8n Integration

Inbound leads arrive from a website form or an email parser. This integration
scores them with an LLM, applies the business's own routing rules, writes the
result to HubSpot, and alerts sales in Slack with a draft reply attached.

It does **not** replace HubSpot, and it is not a CRM. It is the automation layer
between the systems a company already pays for.

```
Website form ─┐
              ├─► n8n webhook ─► POST /v1/qualify ─┬─► OpenAI (structured JSON)
Email parser ─┘                                    └─► deterministic scoring + routing
                                     │
                          ┌──────────┴──────────┬──────────────┐
                          ▼                     ▼              ▼
                    HOT: deal +          WARM: deal +     COLD: contact
                    Slack alert          nurture queue    only, archived
```

## Why the AI does not make the decision

The model produces an **assessment** — score, industry, forecast value, quoted
buying signals, and a non-binding opinion. The **decision** — `HOT` / `WARM` /
`COLD` and the next action — is made in [`src/domain/routing.ts`](src/domain/routing.ts)
by deterministic rules.

That split is the core design choice here, and it buys three things:

- **Reviewable.** Sales can read the rules. Nobody can read a prompt and predict
  its output.
- **Testable.** Routing has exhaustive unit tests with no network and no
  non-determinism.
- **Enforceable.** A budget floor or a competitor blocklist is a contract, not a
  suggestion. A prompt cannot guarantee either.

Every decision carries an `explanation` block recording the model's score, each
rule that adjusted it, which rule decided the outcome, and whether the rules
overrode the model. A rising override rate is the signal that the prompt has
drifted away from the business rules.

## Run it in 30 seconds, with no accounts

Every external system has an offline fake, so the whole pipeline runs with no
API keys and no network.

```bash
npm install
npm run demo
```

You get two things:

- a table in the terminal covering seven representative leads — including a
  duplicate delivery and an invalid payload;
- **`demo/report.html`** — a self-contained report of the same run, with the
  decision trace and drafted replies expanded. No server, no build step, opens
  from disk:

```bash
open demo/report.html
```

### Changing what the demo shows

Edit [`demo/leads.json`](demo/leads.json) and re-run — no TypeScript involved.
Each entry is a `label`, an optional `note` explaining what it demonstrates, and
the raw `payload` exactly as a form would post it:

```json
{
  "label": "Enterprise with no stated budget",
  "note": "Missing budget must not block HOT — an unstated budget is not a low one.",
  "payload": {
    "name": "Elena Dimitrova",
    "email": "elena@bigcorp.de",
    "company": "BigCorp GmbH",
    "employees": 800,
    "message": "We are replacing our support tooling this quarter and need automation."
  }
}
```

To change how the offline model *scores* those leads, the heuristics live in
[`src/adapters/fake/fake-llm.ts`](src/adapters/fake/fake-llm.ts). To change the
business rules themselves — thresholds, budget floor, blocklist — use `.env` or
[`src/domain/scoring.ts`](src/domain/scoring.ts); those apply to the real
pipeline too.

Then run the test suite:

```bash
npm test
```

And the service itself:

```bash
npm run dev
```

```bash
curl -s localhost:3000/v1/leads -H 'content-type: application/json' -d '{"name":"John Smith","email":"john.smith@acme.co","company":"Acme Ltd","employees":120,"budget":25000,"message":"We need to automate customer support. Our current process is manual."}' | jq
```

## Connecting the real thing

Copy `.env.example` to `.env` and switch providers one at a time — each is
independent, so you can put a real OpenAI key in while HubSpot stays fake.

| Variable | `fake` (default) | Real |
| --- | --- | --- |
| `LLM_PROVIDER` | deterministic heuristic | `openai` + `OPENAI_API_KEY` |
| `CRM_PROVIDER` | in-memory store | `hubspot` + `HUBSPOT_ACCESS_TOKEN` |
| `NOTIFIER_PROVIDER` | collected in memory | `slack` + `SLACK_WEBHOOK_URL` |

The service refuses to start if a provider is selected without its credential —
a misconfigured integration that boots cleanly and fails on the first real lead
is worse than one that will not boot.

## The n8n workflow

[`workflows/lead-qualification.json`](workflows/lead-qualification.json) imports
into n8n 1.6x+. Setup and the branch-by-branch walkthrough are in
[`docs/n8n-setup.md`](docs/n8n-setup.md).

n8n owns orchestration — the webhook, the branching, the CRM and Slack nodes,
the retries. This service owns the part that has to be reliable and testable:
validation, the model call, and the routing decision.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/qualify` | Assess and decide. **No side effects.** What n8n calls. |
| `POST` | `/v1/leads` | The full pipeline including HubSpot and Slack, for callers not using n8n. |
| `GET` | `/healthz` | Liveness. |
| `GET` | `/readyz` | Active providers and the routing rules currently in force. |

`POST` routes require `x-webhook-secret` when `WEBHOOK_SECRET` is set, compared
in constant time. An inbound `x-request-id` is reused as the correlation id, so
one identifier traces a lead across n8n, this service, HubSpot and Slack.

Status codes are chosen so n8n knows what to do with them: `422` and `400` mean
stop, `502` with `Retry-After` means try again, `207` means the lead was saved
but a non-critical step failed.

<details>
<summary>Example <code>POST /v1/qualify</code> response</summary>

```json
{
  "correlation_id": "n8n-exec-4711",
  "qualification": {
    "score": 100,
    "classification": "HOT",
    "next_action": "sales_call",
    "industry": "SaaS",
    "estimated_value": 25000,
    "reason": "Strong ICP fit: identified company (Acme Ltd), 120 employees, stated budget of €25,000.",
    "signals": ["We need to automate customer support"],
    "confidence": 0.82,
    "explanation": {
      "llm_score": 91,
      "llm_suggested_classification": "HOT",
      "adjustments": [
        { "rule": "high_budget", "delta": 10 },
        { "rule": "enterprise_headcount", "delta": 5 }
      ],
      "applied_rule": "score_threshold_hot",
      "overrode_model": false,
      "degraded": false
    }
  },
  "suggested_reply": "Hi John, thanks for reaching out on behalf of Acme Ltd..."
}
```
</details>

## What happens when things break

Full matrix in [`docs/failure-modes.md`](docs/failure-modes.md). The short
version:

| Failure | Behaviour |
| --- | --- |
| OpenAI 429 / 5xx / timeout | Retried with exponential backoff and full jitter, honouring `Retry-After` |
| OpenAI still failing after retries | Falls back to heuristic scoring, flags the lead `degraded`, no AI reply drafted |
| Model returns malformed or truncated JSON | Treated as retryable, then the same fallback |
| HubSpot contact write fails | Retried, then dead-lettered to `.data/dead-letter.jsonl` and the request fails with `502` |
| HubSpot deal write fails | Dead-lettered, request still succeeds with `207` — the contact is already saved |
| Slack down | Logged, lead processed normally |
| Duplicate webhook delivery | Contact matched by email, deal matched by idempotency key — no duplicates |

**A lead is never lost.** That is the one invariant the design is built around.
Replay anything that was parked:

```bash
npm run replay -- --dry-run
```

## Layout

```
src/domain/      Lead + assessment schemas, scoring rules, routing decision — no I/O
src/ports/       Interfaces the pipeline depends on (LLM, CRM, notifier)
src/adapters/    OpenAI, HubSpot, Slack + an offline fake for each
src/pipeline/    The two use cases: qualify (pure) and process (side effects)
src/http/        Fastify server, auth, error-to-status mapping
prompts/         Versioned prompts with changelogs
workflows/       The importable n8n workflow
demo/            Editable demo leads + the generated HTML report
tests/           60 tests, no network, no API keys
```

The domain layer imports nothing from adapters. That is what lets the entire
pipeline be tested against fakes and the provider be swapped in one file.

## Deliberately not built

Scope discipline is part of the exercise. Not here, and why:

- **No own CRM or frontend** — HubSpot already does that, and better.
- **No database** — the only state that needs to survive a crash is the
  dead-letter log, and a file covers that for a single node. The port is in
  place for the day it does not.
- **No RAG, no agent framework** — there is one classification task with a fixed
  schema. Neither would earn its complexity.
- **No eval harness** — meaningful here only against a labelled set of real
  leads. The `/v1/qualify` route is side-effect free specifically so one can be
  bolted on when that data exists.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — sequence diagram, layering, data flow
- [`docs/decisions.md`](docs/decisions.md) — the five decisions worth arguing about
- [`docs/failure-modes.md`](docs/failure-modes.md) — every failure and its handling
- [`docs/n8n-setup.md`](docs/n8n-setup.md) — importing and wiring the workflow
