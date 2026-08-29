# AI Lead Qualification — Production Load Simulation

The [lead qualification pipeline](../01-ai-lead-qualification-n8n) works. This
project answers the questions that follow: **what happens at 10,000 leads, what
breaks first, and what does it cost?**

It runs the real pipeline — unmodified — through a queue and a worker pool
against simulated providers that have realistic latency distributions, real rate
limits and injected failures. No API keys, no network, no spend.

```
generate → queue (bounded) → worker pool → the real pipeline → simulated OpenAI / HubSpot / Slack
              ↑ backpressure      ↑ concurrency        ↓
         retries · dead letters   metrics · cost tracking → live dashboard + HTML report
```

## Run it

```bash
npm install
npm run simulate
```

Ten leads, real time, about six seconds. Then scale up:

```bash
npm run simulate -- --leads 1000 --concurrency 25
npm run sim:10k                                        # 10,000 leads, ~97s
npm run simulate -- --leads 10000 --profile outage     # everything failing at once
npm run simulate -- --help
```

Each run writes `sim/report.html` — a self-contained report with throughput and
queue-depth charts, a latency histogram, the failure breakdown, the rate-limit
analysis and the cost projection — plus `sim/result.json` for diffing runs.

## What it found

Full write-up with reproduction commands in [`docs/findings.md`](docs/findings.md).
The headline:

> **Slack is the bottleneck at 10,000 leads, not the model.** Its
> ~60 requests/minute webhook limit caps the entire pipeline at 1.0 leads/second
> — 98% of the run's elapsed time. Raising that one ceiling made the same run
> **4.7× faster** and moved the constraint to the model, where it belongs.

Also:

- **2,646 injected failures → 0 leads lost.** A third of leads fell back to
  degraded scoring and still reached a salesperson.
- **~$5.64 per 10,000 leads** on `gpt-4.1-mini`, including retries and the calls
  that returned unusable output.
- **Queue-level retry metrics are the wrong alarm** — in-pipeline retries absorb
  transient failures before the queue ever sees them.

And three real bugs in this harness that only load exposed — including a seed
that did not actually guarantee reproducibility. They are written up in the same
document rather than quietly fixed.

## The pieces

| Concern | Where | What it does |
| --- | --- | --- |
| **Queue** | [`src/queue/`](src/queue) | Bounded FIFO with delayed retries, attempt limits, dead-letter terminus. Producers block at `--max-queue-depth` rather than buffering without bound. |
| **Rate limits** | [`src/ratelimit/`](src/ratelimit) | Token bucket per provider — burst capacity plus a sustained rate. Modelled on published tiers; `--no-rate-limit` shows what it prevents. |
| **Retries** | [`src/lib/retry.ts`](src/lib/retry.ts) | Exponential backoff with **full jitter**, honouring `Retry-After`. Two layers: in-pipeline for transient faults, queue-level for jobs the pipeline gave up on. |
| **Failed jobs** | [`src/queue/queue.ts`](src/queue/queue.ts) | Dead-lettered with attempt count and last error, listed in the report, replayable with `npm run replay`. |
| **Logging** | [`src/logger.ts`](src/logger.ts) | Structured JSON, PII redacted, silent by default under load — `--log-level info` to see it. |
| **Monitoring** | [`src/metrics/`](src/metrics) | Counters, gauges and latency histograms with reservoir sampling, plus a time series so the report shows the *shape* of the run, not just totals. |
| **Cost** | [`src/cost/`](src/cost) | Token accounting priced from [`config/pricing.json`](config/pricing.json), counting retries and unusable responses. Projects to 10,000 leads. |

## Two design decisions worth arguing about

**A virtual clock, so results do not depend on how fast the run went.** Every
duration in the system — provider latency, rate-limit windows, retry backoff —
is in virtual milliseconds, and `--time-scale` controls how much real time one
virtual millisecond costs. A 10,000-lead run that would take 2.7 hours completes
in 97 seconds and reports *the same numbers*. That property is asserted in
`simulation.test.ts`; without it a compressed run would be a different
experiment, not a faster one.

**One random stream per lead, not one per run.** The obvious approach — a single
seeded generator — is not reproducible under concurrency, because N workers
consume the sequence in whatever order the event loop picks. Each lead gets its
own stream derived from `(seed, index, attempt)`, read through async context, so
its latency and failures depend only on itself. Same seed, same result, every
time. This was found by a failing test, not by design; see finding 6.

## Failure profiles

| Profile | What it models |
| --- | --- |
| `healthy` | Everything up. Only tail latency is interesting. |
| `normal` *(default)* | Low background error rates on every dependency — a normal Tuesday. |
| `degraded` | The model provider is slow, rate limiting hard, occasionally incoherent. |
| `outage` | Model provider largely down. Exercises degraded scoring and the dead-letter path. |

Defined in [`src/sim/failure-profile.ts`](src/sim/failure-profile.ts) — latency
medians, log-normal spread, and per-error-class injection rates.

## Tests

```bash
npm test
```

113 tests, no network, under three seconds. Beyond the 60 inherited from the base
project, the load infrastructure has its own:

- **Queue** — FIFO order, backpressure blocking the producer, delayed retry not
  firing early, dead-lettering on exhaustion, non-retryable failing immediately.
- **Worker pool** — concurrency never exceeded, every settlement reported once.
- **Rate limiter** — burst then throttle, refill rate, never exceeding capacity,
  a waiter actually blocking, sustained shaping.
- **Metrics** — exact percentiles under the reservoir size, exact count/min/max/
  mean above it, sane behaviour when empty.
- **Cost** — input and output priced separately, unbilled 429s counted as calls
  but not cost, refusing an unpriced model rather than reporting zero.
- **Simulation** — every lead accounted for, same seed → identical results,
  different time scale → identical measurements, queue depth and concurrency
  ceilings never breached, no leads lost during an outage.

## Not built

- **No real broker.** The queue is in-memory. It models what a broker provides —
  bounded depth, delayed redelivery, attempt limits, a dead-letter terminus — so
  the whole thing runs with one command. Swapping in SQS or BullMQ changes one
  file; what else changes is in [`docs/findings.md`](docs/findings.md).
- **No distributed run.** One process. The rate limiters are per-process, so
  multiple instances would need a shared limiter (Redis) to respect one ceiling.
- **No real API calls.** Deliberate: this is for exploring configurations, not
  measuring OpenAI. The base project runs against real providers.
