# Decision records

Short records of the choices that a reviewer would reasonably challenge.

---

## 1. The LLM assesses; deterministic code decides

**Alternative considered:** let the model return `classification` directly and
route on that.

**Decision:** the model returns a score and a *non-binding* opinion. Routing is
computed in `domain/routing.ts`.

**Why:** classification is a business commitment, not an opinion. A budget floor
and a competitor blocklist have to hold every time, and a prompt cannot promise
that — the same lead can classify differently across runs, and a model upgrade
silently re-routes the whole funnel. Rules are reviewable by the sales team,
testable without a network, and changeable without touching a prompt.

**Cost:** two sources of truth about what a good lead looks like. Mitigated by
recording `overrode_model` on every decision, so drift between them is
measurable rather than invisible.

---

## 2. A failed model call degrades, it does not fail

**Alternative considered:** return `502` and let n8n retry the whole workflow.

**Decision:** after retries are exhausted, score with a heuristic, mark the
result `degraded: true`, and skip the AI-drafted reply.

**Why:** the invariant is that a lead is never lost. An unroutable lead sitting
in a retry queue during an OpenAI incident is a lost deal; a crudely-scored lead
in front of a salesperson with a visible "not AI-scored" marker is not. The
degraded flag reaches Slack, so a human knows to look harder.

**Cost:** a degraded lead can be misrouted. Acceptable — the alternative is not
being routed at all.

---

## 3. Two endpoints, one decision engine

**Alternative considered:** a single `POST /v1/leads` doing everything.

**Decision:** `/v1/qualify` decides with no side effects; `/v1/leads` also
writes to HubSpot and Slack. Both call the same decision code.

**Why:** n8n should own orchestration — that is what it is good at, and what
makes the workflow legible to someone who does not read TypeScript. But a
side-effect-free endpoint is also what makes dry runs, replays and a future eval
harness possible. Sharing the decision code means the two paths cannot disagree.

**Cost:** a second endpoint to document. Cheap.

---

## 4. A file for the dead-letter queue

**Alternative considered:** SQS, Redis, or a Postgres table.

**Decision:** append-only JSONL at `.data/dead-letter.jsonl`, behind a
`DeadLetterPort`.

**Why:** this runs on one node. A file is durable, greppable, replayable with
`npm run replay`, and adds no infrastructure to stand up before the integration
delivers value. Introducing a queue here would be building for a scale problem
that does not exist yet.

**Cost:** breaks the moment there is a second instance. The port exists so that
day is a one-file change, and this is written down so it is a decision rather
than an oversight.

---

## 5. Ports and adapters, in a project this small

**Alternative considered:** call the OpenAI and HubSpot SDKs directly from the
pipeline.

**Decision:** three interfaces, six implementations — real and fake for each.

**Why:** the fakes are not test scaffolding, they are the product. `npm run
demo` runs the complete pipeline with no keys, no cost and no network, which is
what makes this reviewable by someone who will not provision a HubSpot sandbox
to look at it. The same seam gives 59 tests that run in under a second.

**Cost:** more files than a direct implementation. Paid back the first time the
whole thing runs offline.
