# Prompt: qualify-lead

**Version:** 1 (`PROMPT_VERSION` in `src/adapters/claude.ts`)
**Model:** `claude-opus-5` (configurable via `CLAUDE_MODEL`)
**Effort:** `low` — a short classification is the workload shape that does not
repay deeper reasoning. Raise it if evaluation on real leads shows headroom.

The version travels with every assessment, so a decision can be traced back to
the prompt that produced it.

## System prompt

See `SYSTEM_PROMPT` in [`src/adapters/claude.ts`](../src/adapters/claude.ts) —
kept there rather than loaded from this file so it cannot silently drift from
the code that sends it. This document is the changelog and the rationale.

## The instruction that does the work

```text
`confidence` is how much your reading of this enquiry can be relied on — not
how good the lead is. A short, vague or ambiguous message means low confidence
even if you had to pick a score. This matters: the routing rules will refuse to
book a salesperson on a high score you are not sure about.
```

Without the second and third sentences, models report confidence in *the lead*
rather than in *their reading of it* — a strongly-worded enquiry with no
substance comes back at 0.9, and the confidence gate stops doing anything.
Telling the model what the number is used for is what makes it meaningful.

The last line is the same idea from the other direction:

```text
`qualification` is your own label. Record it honestly; the rules may disagree.
```

The model's label is stored and compared against the routed outcome. A rising
`overrode_model` rate is the signal that the prompt and the thresholds have
drifted apart.

## Output contract

Enforced with `output_config.format` (JSON Schema) **and** re-validated with zod
on receipt — see `CLAUDE_OUTPUT_SCHEMA` and `ClaudeAssessmentSchema` in
[`src/domain/qualification.ts`](../src/domain/qualification.ts), which must be
changed together.

## Changelog

- **v1** — Initial version.
