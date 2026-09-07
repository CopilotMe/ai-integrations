# Test scenarios

Every row is a real test in [`tests/scenarios.test.ts`](../tests/scenarios.test.ts).
`npm test` runs them in under a second, with no API key and no network.

| # | Scenario | Expected | Where it is proved |
| --- | --- | --- | --- |
| 1 | HOT: score 87, confidence 0.94 | `sales` / `sales_call` | routing |
| 2 | WARM: score 65, confidence 0.85 | `nurture` / `nurture_sequence` | routing |
| 3 | COLD: score 30, confidence 0.95 | `low_priority` / `archive` | routing |
| 4 | Missing contact_id / email / inquiry | `422`, **no model call, no CRM write** | pipeline, with spies |
| 5 | Score 95 but confidence 0.55 | cannot become HOT — drops one tier to `nurture`, and records that it overrode the model | routing |
| 6 | Claude timeout | retried; the call is actually aborted; after the budget, `504` and **no partial CRM write** | pipeline, with a hanging stub |
| 7 | Invalid structured output | retried as transient; **no CRM side effect**; a permanent 401 is *not* retried | pipeline |
| 8 | GoHighLevel 5xx | retried, then succeeds; a `400` is not retried; the idempotency claim is **released** so the sender can retry | pipeline |
| 9 | Same event delivered twice | one classification, one CRM write, second call returns the stored result — including when the deliveries arrive **concurrently** | pipeline |
| 10 | Same contact, new event id | qualified again; one contact, two writes | pipeline |

Plus boundary and plumbing tests: thresholds inclusive at 80/0.8 and 50/0.7 and exclusive just below; a hot-scoring lead is never archived on low confidence alone; a blocked domain hard-stops regardless of score; the routing function is pure; the fake assessor is deterministic and reports lower confidence for a vague enquiry.

## The two that matter most

**Scenario 5** is the reason this project exists as something other than a second copy of project 01. A score of 95 the model is only 55% sure about is not a hot lead. Booking a salesperson on it is the expensive mistake, so the confidence gate blocks the escalation — but it drops the lead exactly one tier, to nurture, never to archive. Archiving is the only irreversible outcome and belongs to the score alone.

**Scenario 9** is the one that bites in production. GoHighLevel fires `ContactCreate` *and* `ContactUpdate` for the same contact and retries any non-2xx delivery, so duplicates are routine rather than an edge case. The claim is taken **before** the Claude call, which is why the concurrent version of the test passes: three simultaneous deliveries produce one classification, not three.
