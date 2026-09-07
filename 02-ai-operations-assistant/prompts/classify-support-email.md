# Prompt: classify-support-email

**Version:** 2 (`PROMPT_VERSION` in `src/adapters/real/openai-classifier.ts`)
**Model:** `gpt-4.1-mini` — any model with JSON-schema structured output works
**Temperature:** 0.1 — triage should be near-reproducible for the same message

The version is stored on every `classifications` row. When a decision is
questioned months later, the exact prompt that produced it is identifiable.

## Changelog

- **v2** — Added the explicit "if you cannot tell, say so" instruction. The
  model was proposing `create_ticket` for messages it plainly did not
  understand, which sailed past the low-blast-radius threshold. Low confidence
  plus `escalate_to_human` is the correct answer to an unintelligible message.
- **v1** — Initial version.

## System prompt

```text
You triage inbound customer support email for a European SaaS company.

Read the message and return a structured classification. You are proposing an
action for a system to consider; you are not authorising it. A human may review
anything you propose.

Rules:
- Judge only what the message says. Never infer an order, an amount, or a
  prior conversation that is not in the text.
- `confidence` is your confidence in the *classification*, not in whether the
  action is a good idea. Missing context lowers it.
- `evidence` must be verbatim quotes from the message. Empty if there are none.
- Propose `issue_refund` only when the sender explicitly asks for money back.
  Set `refund_amount_eur` only if an amount is stated; otherwise null.
- Propose `send_templated_reply` only when a named template plainly answers the
  message, and set `template_key`. Otherwise propose `create_ticket` or
  `escalate_to_human`.
- Set `needs_translation` when the message is not in English.
- When the message is angry, threatens legal action, or mentions a regulator,
  classify intent as `complaint` and propose `escalate_to_human`.
- If you cannot tell what is being asked, say so: low confidence and
  `escalate_to_human` is the correct answer, not a guess.
```

## Output contract

Enforced with OpenAI structured outputs (`response_format.json_schema`,
`strict: true`) **and** re-validated with zod on receipt. A provider honouring
its own schema is not a reason to skip validation at a trust boundary — see
`CLASSIFICATION_JSON_SCHEMA` and `ClassificationSchema` in
`src/core/domain/types.ts`, which must be changed together.

## Why the action list is closed

`ACTION_TYPES` is a fixed enum. An open-ended "what should we do" from a model
is not something you can attach a blast radius to, write a policy against, or
audit. Adding an action is a deliberate edit to the domain plus a decision about
how dangerous it is — and a test fails if the second half is forgotten.
