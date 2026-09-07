# Decision records

---

## 1. Two gates — score *and* confidence

**Alternative:** route on score alone, as project 01 does.

**Decision:** a lead must clear both the score and the confidence threshold for
its tier. Missing the confidence gate drops it exactly one tier — never straight
to archive.

**Why:** score says how good the lead looks; confidence says how much the
model's reading of it can be relied on. Those are different questions, and only
the second one tells you whether to spend a person on it. The asymmetry in the
rule follows from the asymmetry in the costs: a sales call costs an hour of
someone's time, a nurture sequence costs almost nothing, and archiving is the
only outcome you cannot undo. So low confidence blocks an escalation but never
throws a lead away.

**Cost:** two numbers to tune per tier instead of one, and a model that
under-reports confidence quietly suppresses the sales pipeline. That is what
`overrode_model` is recorded for — a rising override rate is the signal.

---

## 2. n8n normalises; the service decides

**Alternative:** call Claude from an n8n HTTP node and route in a Code node.

**Decision:** n8n owns the GoHighLevel-shaped work — the webhook, normalising
three different payload shapes, and firing the follow-up workflow. The service
owns validation, the Claude call, the routing rules and the CRM write-back.

**Why:** the routing rules are the part that has to be right, and a Code node
cannot be unit tested, reviewed in a diff, or run in CI. Putting them in the
service means one implementation under test rather than a copy that drifts.
Equally, GHL's payload inconsistencies are genuinely integration-layer problems
and do not belong in a domain model.

**Cost:** one more hop. Worth it — and the workflow keeps its own retry and
error branches so an outage in the service answers the webhook rather than
hanging.

---

## 3. Idempotency keyed on the GHL event id, claimed before the model call

**Decision:** `claim(event_id)` happens before Claude is called, not after.

**Why:** GoHighLevel fires `ContactCreate` and `ContactUpdate` for the same
contact and retries any non-2xx delivery. Claiming after the model call would
still prevent the duplicate *write*, but both deliveries would already have been
billed. Claiming first means the second delivery costs nothing.

The claim is **released** when the failure is retryable, so a transient CRM
outage does not leave a lead permanently unqualified — the sender retries into a
free key. A permanent failure keeps the key, because retrying it would fail the
same way.

**Cost:** the store is in-memory and therefore single-process. Two instances
would each keep their own map and both would process a duplicate. `Redis SET key
NX PX ttl` behind the same `IdempotencyStore` interface is the fix; nothing else
changes.

---

## 4. Claude structured outputs, and zod on top

**Decision:** `output_config.format` with a JSON Schema constrains generation,
and the response is **still** re-validated with zod on receipt.

**Why:** the schema makes the response parseable by construction rather than by
prompt discipline — no "return only JSON" instruction, no regex fishing for a
code fence. Re-validating anyway is not redundancy: the boundary between a
remote service and this process is a trust boundary, and a provider honouring
its own contract is a reason to expect valid output, not a reason to stop
checking. It also catches the case the schema cannot express — a `confidence`
of 0.5 is schema-valid whether or not the model understood the question.

`effort: 'low'` because this is a short classification, which is the workload
shape that does not repay deeper reasoning.

---

## 5. Custom fields are resolved by id at runtime

**Decision:** look the GHL custom-field ids up once from
`/locations/{id}/customFields` and cache them, rather than hardcoding ids or
writing by key.

**Why:** GHL addresses custom fields by id on the write path, and those ids are
**per sub-account**. A hardcoded id works in exactly one location, which for an
agency-shaped tool is the wrong number. Looking them up by key at startup makes
the same build work in any location that has the fields defined.

**Cost:** one extra API call per process, and a clear error when the fields do
not exist rather than a silent no-op write.

---

## 6. A tag is written alongside the fields

**Decision:** the route is written both as a custom field and as an
`ai-sales` / `ai-nurture` / `ai-low-priority` tag.

**Why:** GHL workflow triggers fire on tags far more reliably than on
custom-field changes, and the follow-up automation is the whole point of writing
the qualification back. The field is for humans reading the contact; the tag is
what the machine listens to.
