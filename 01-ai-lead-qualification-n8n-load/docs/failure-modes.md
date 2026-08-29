# Failure modes

Every external call in this integration can fail. This is what happens when each
one does, and which test proves it.

The governing invariant: **a lead is never lost.** Every decision below follows
from it.

## The model

| Failure | Detection | Response | Test |
| --- | --- | --- | --- |
| Rate limit (429) | Status code | Retry with backoff, honouring `retry-after-ms` or `retry-after` | `llm-failures.test.ts` |
| Server error (5xx) | Status code | Retry with exponential backoff + full jitter | `llm-failures.test.ts` |
| Timeout | `AbortController` after `LLM_TIMEOUT_MS` | Socket torn down, retried | `llm-failures.test.ts` |
| Malformed JSON | `JSON.parse` throws | `LlmContractError`, retried | `llm-failures.test.ts` |
| Schema-invalid output | zod re-validation fails | `LlmContractError`, retried | `llm-failures.test.ts` |
| Truncated output | `finish_reason: 'length'` | `LlmContractError`, retried | — |
| Bad API key (401) | Not marked retryable | Fails immediately, no wasted retries | `llm-failures.test.ts` |
| **All retries exhausted** | — | **Heuristic scoring, `degraded: true`, no drafted reply** | `llm-failures.test.ts` |
| Reply drafting fails | Any of the above | Lead processed, `suggested_reply: null` | `llm-failures.test.ts` |

Structured outputs (`json_schema`, `strict: true`) make malformed output rare,
but the response is still re-validated with zod on receipt. A provider honouring
its schema is not a reason to skip validation at a trust boundary.

Backoff uses **full jitter** — `random() * min(maxDelay, base * 2^attempt)`.
n8n fans a batch of leads out concurrently, and without jitter every retry from
a rate-limited batch lands on the provider at the same instant.

## HubSpot

| Failure | Response | Test |
| --- | --- | --- |
| Contact already exists (409) | Search by email, `PATCH` instead of `POST` | `crm.test.ts` |
| 409 but contact not findable | Retryable — the search index has not caught up | — |
| Duplicate deal (same idempotency key) | Existing deal returned, nothing created | `crm.test.ts` |
| 429 / 5xx | Retryable, `Retry-After` honoured | `crm.test.ts` |
| 4xx | **Not** retryable — a retry would send the identical bad request | `crm.test.ts` |
| Network failure (no response) | Retryable | `crm.test.ts` |
| **Contact write unrecoverable** | Dead-lettered, request fails `502` + `Retry-After` | `pipeline.test.ts`, `api.test.ts` |
| **Deal write unrecoverable** | Dead-lettered, request succeeds `207` | `pipeline.test.ts` |

The contact write is the only step allowed to fail the request, because it is
the only one that loses data if skipped. Once the contact exists the lead is
safe, so a failed deal degrades to a warning and a dead-letter entry rather than
throwing away work that already succeeded.

## Slack

| Failure | Response | Test |
| --- | --- | --- |
| Any error | Logged, `notification_failed` warning, request returns `207` | `pipeline.test.ts`, `api.test.ts` |

Never fatal. Failing the webhook over a missed notification would make n8n retry
the entire pipeline and redo the CRM work for the sake of a chat message.

## Inbound requests

| Failure | Response | Test |
| --- | --- | --- |
| Missing or malformed field | `422` with per-field issues | `api.test.ts` |
| Missing / wrong webhook secret | `401`, constant-time comparison | `api.test.ts` |
| Body over 256 KB | `413` from Fastify | — |
| Duplicate delivery | Idempotent — no duplicate contact or deal | `pipeline.test.ts` |

Status codes are chosen for what n8n does with them:

- `422` / `400` — permanent. Stop, do not retry.
- `502` + `Retry-After` — transient. Retry is safe and expected.
- `207` — the lead was saved, something non-critical did not happen.

## Configuration

Config is validated at boot. Selecting `LLM_PROVIDER=openai` without
`OPENAI_API_KEY`, or setting `WARM_SCORE_THRESHOLD ≥ HOT_SCORE_THRESHOLD`,
prevents startup with a message naming the field (`config.test.ts`).

A misconfigured integration that starts cleanly and fails on the first real lead
is worse than one that refuses to start.

## Recovery

```bash
npm run replay -- --dry-run   # list what is parked
npm run replay                # push it back through the pipeline
```

Replay is safe: contacts are keyed by email and deals by idempotency key, so a
lead that partially succeeded the first time is not duplicated. The consumed
file is archived, not deleted.

## Known gaps

Named rather than hidden:

- **The dead-letter file assumes one instance.** Two replicas writing to the
  same path will interleave. Swap `FileDeadLetter` for a queue before scaling
  out — see [decision 4](decisions.md).
- **No circuit breaker.** During a sustained OpenAI outage every lead pays the
  full retry budget before degrading. Acceptable at this volume; a breaker
  around the LLM port is the fix if lead volume makes the latency hurt.
- **Degraded scoring is crude by design.** It exists to keep leads moving, not
  to be accurate. Watch the `degraded` rate rather than trusting its output.
- **No replay ordering.** Entries replay in file order, not arrival order. Only
  matters if two submissions from the same address are parked together.
