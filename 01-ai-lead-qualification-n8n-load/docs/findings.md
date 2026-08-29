# What the simulation found

The point of building this was to learn something that unit tests cannot tell
you. It did. These are the results, with the commands to reproduce each one.

Every figure below comes from a recorded run at seed 1. Latencies are in
simulated time and are unaffected by wall-clock compression.

---

## 1. Slack is the bottleneck at 10,000 leads — not the model

The obvious assumption is that an AI pipeline is gated by the AI. It is not.

```bash
npm run simulate -- --leads 10000 --concurrency 50
```

| | |
| --- | --- |
| Duration | 9,700s simulated |
| Throughput | **1.0 leads/s** |
| End-to-end p50 | 514s — of which **485s was queue wait** |
| Binding constraint | **Slack: 9,496 calls at 60 rpm needs 9,496s = 98% of the run** |

Slack's incoming-webhook limit is roughly one message per second. Notifying on
every HOT and WARM lead therefore caps the whole pipeline at 60 leads/minute,
no matter how many workers are running or how fast the model responds.

**Verified by relieving it.** Same run, same seed, Slack ceiling raised 100×:

```bash
npm run simulate -- --leads 10000 --concurrency 50 --rpm-notifier 6000
```

| | 60 rpm | 6,000 rpm |
| --- | --- | --- |
| Duration | 9,700s | **2,082s** |
| Throughput | 1.0/s | **4.7/s** |
| End-to-end p50 | 514s | **112s** |
| Binding constraint | Slack (98%) | model (96%) |

**4.7× faster**, and the constraint moved to the model — which is where it
should have been all along. The diagnosis holds.

**What to do about it.** Not "raise the Slack limit" — you cannot. Three real
options, in order of preference:

1. **Batch the notifications.** Sales does not need 9,000 individual messages.
   One digest per minute listing new HOT leads costs 60 calls/hour instead of
   3,600 and is more useful to read.
2. **Notify only on HOT.** WARM leads are going into a nurture sequence; nobody
   acts on that message. This alone cuts notification volume by about 30%.
3. **Move notification off the critical path.** It is already best-effort — a
   failed Slack call does not fail the lead — so it has no business holding a
   worker. A separate queue with its own concurrency decouples it entirely.

The pipeline is already structured for (3): the notifier is behind a port and
its failures are non-fatal.

---

## 2. Zero leads lost during a simulated provider outage

```bash
npm run simulate -- --leads 1000 --concurrency 25 --profile outage
```

| | |
| --- | --- |
| Failures injected | **2,646** across all three dependencies |
| Leads completed | 977 |
| Rejected as invalid | 23 (these are genuinely malformed payloads) |
| **Dead-lettered** | **0** |
| Scored without AI (degraded) | 318 — **32.5%** |
| Cost | $0.31 |

2,646 injected failures produced zero permanently failed leads. The difference
is absorbed by three mechanisms working together:

- retry with backoff for transient failures,
- **degraded-mode heuristic scoring** when the model is unreachable after
  retries — a third of leads took this path and still reached a salesperson,
- best-effort notification, which never fails a lead already in the CRM.

The one-third degraded figure is the number to watch in production. Those leads
are scored crudely and flagged; a sustained rate that high means the AI is
effectively down, even though nothing is erroring.

---

## 3. Retries are almost invisible at the queue layer

Under the `normal` profile, **job retries: 0** — despite 345 rate-limit errors
and 159 server errors on the model.

Not a measurement bug. The pipeline's own retry logic absorbs transient failures
inside a single job, so the queue never sees them. Jobs only reach the queue's
retry path when the pipeline gives up, which under normal conditions it does not.

Worth knowing, because it means **queue-level retry metrics are the wrong alarm**.
By the time they move, in-pipeline retries have already been failing for a while.
Alert on `error.llm.*` rates and the degraded-mode share instead.

---

## 4. Cost is linear and small — roughly $5.65 per 10,000 leads

| | |
| --- | --- |
| Model | `gpt-4.1-mini` |
| Calls | 17,076 for 9,703 completed leads (~1.76 per lead) |
| Tokens | 7.68M |
| Per lead | **$0.000564** |
| **10,000 leads** | **$5.64 / EUR 5.23** |

The 1.76 calls per lead is the assessment plus a drafted reply for HOT and WARM
leads only — COLD leads get no reply, so they cost roughly half.

Two things the naive estimate misses, both counted here:

- **Retries are billed.** A call that returned malformed JSON was paid for, then
  paid for again on retry. 429s were not billed but still cost a round trip.
- **Rejected leads cost nothing.** Validation happens before the model call, so
  the 3% invalid payloads never reach it. Validating first is worth real money
  at volume.

Prices come from `config/pricing.json` and carry an `as_of` date that is printed
on every report. **Verify them before quoting any figure from this simulation.**

---

## 5. Client-side rate limiting is worth the throughput it costs

```bash
npm run simulate -- --leads 1000 --concurrency 25
npm run simulate -- --leads 1000 --concurrency 25 --no-rate-limit
```

Without a client-side limiter the pipeline discovers the provider's ceiling by
hitting it: more 429s, each one a wasted round trip that has to be retried, and
retries that arrive in a synchronised burst because they all backed off from the
same instant. With the limiter, requests are shaped before they leave.

The limiter costs latency deliberately — that is what "held back" means in the
report — and buys a lower error rate and a provider relationship that does not
degrade under load. Full jitter on the backoff is what stops the retries from
re-synchronising.

---

## Bugs this exercise found in the code

Load simulation earns its keep by finding things that a passing test suite does
not. Three, all now fixed and covered by tests:

1. **The seed did not guarantee reproducibility.** Concurrent workers shared one
   random stream, so their interleaving — which varies run to run — changed the
   sequence each consumed. Same seed, different results. Fixed by giving every
   lead its own stream derived from `(seed, index, attempt)`, read through async
   context. `simulation.test.ts` now asserts two runs at one seed match exactly,
   and that two time scales produce identical measurements.
2. **The lead generator crashed** when `duplicate` was drawn before any lead
   existed to duplicate — a first-iteration-only failure that a short run would
   never surface.
3. **`end-to-end latency` excluded queue wait**, so it was reported as smaller
   than the queue wait printed beside it. It now measures enqueue → settled,
   with queue wait and processing broken out beneath it.

A fourth, in the test harness: `ManualClock.advance` inspected its waiter list
before letting pending tasks register their sleeps, so a task that had not yet
started was skipped entirely. Tests using it were passing for the wrong reason.
