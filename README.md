# AI Integrations

Portfolio of production-shaped AI integration work: real business processes
wired into the systems companies already run, with the AI placed where it
actually earns its cost.

The through-line across these projects is the same: **integrate, don't rebuild.**
Each one takes an existing tool stack, adds a model where judgement is needed,
and makes the result reliable enough to trust — tested, observable, and honest
about what happens when a dependency fails.

## Projects

| # | Project | Stack | What it demonstrates |
| --- | --- | --- | --- |
| 01 | [AI Lead Qualification & Routing](01-ai-lead-qualification-n8n) | n8n · OpenAI · HubSpot · Slack · TypeScript | Structured LLM output, deterministic routing over model opinion, retry/timeout/degradation, idempotent CRM writes, 60 tests |

## How to review any of these in 30 seconds

Every project runs with no API keys. External systems have offline fakes, so the
complete pipeline can be executed and inspected without provisioning anything:

```bash
npm install && npm run demo
```

Each demo also writes a self-contained HTML report, so the results can be
reviewed without running anything at all.

Real credentials are opt-in, one provider at a time.
