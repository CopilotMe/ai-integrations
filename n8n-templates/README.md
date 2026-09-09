# n8n templates

Standalone workflows for the [n8n template gallery](https://n8n.io/workflows/).

Unlike the workflows inside each project folder, these have **no external
service dependency** — they run on n8n plus a credential you already have, so
anyone can import and use them.

## [lead-qualification-confidence-gate.json](lead-qualification-confidence-gate.json)

**AI lead qualification with a confidence gate (Claude + deterministic routing)**

Most AI lead-qualification workflows let the model output "hot / warm / cold"
and act on it. That is not reproducible: the same lead can classify differently
between runs, and a model upgrade silently re-routes the whole funnel.

Here Claude returns only a **score** and a **confidence**. A Code node decides
the route from those two numbers, and that node is the entire business policy.

**The rule:** a lead must clear both the score and the confidence gate for its
tier. Clearing the score but not the confidence drops it **exactly one tier —
never straight to archive.** A sales call costs an hour of someone's time, a
nurture sequence costs almost nothing, and archiving is the only irreversible
outcome, so low confidence may block an escalation but must never throw a lead
away.

It also gets the Anthropic response parsing right, which is the common bug:
the Messages API returns `content[0].text`, not your fields at the top level.
Reading `$json.lead_score` directly yields `undefined`, every lead scores 0, and
everything routes to low priority — silently.

The fuller version of this idea, with tests, lives in
[`../03-ai-crm-ghl-claude-n8n`](../03-ai-crm-ghl-claude-n8n).
