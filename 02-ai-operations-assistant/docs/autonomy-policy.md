# The autonomy policy

The one idea this project is built around:

> **The model proposes. The policy decides. A human authorises anything that matters.**

`src/core/policy/autonomy.ts` is a pure function. Same inputs, same verdict, no
I/O. That is what makes it testable, explainable to a non-engineer, and
replayable against a historical case to answer *"would today's policy have done
the same thing?"*

## Blast radius

The axis that actually matters is not how confident the model is. It is **how
much damage the action does if it is wrong** — and that is a property of the
action, not of the model.

| Action | Blast radius | Why |
| --- | --- | --- |
| `no_action` | none | Nothing happens |
| `create_ticket` | low | Wastes a minute of someone's time |
| `escalate_to_human` | low | Same |
| `send_templated_reply` | **medium** | Leaves the building, in our name, to a customer |
| `update_account` | **high** | Changes state the customer depends on |
| `cancel_subscription` | **high** | Ends a paying relationship |
| `issue_refund` | **high** | Money out of the door |

Every action type must appear in this table. A test asserts it, so a new action
cannot be added without someone deciding how dangerous it is.

## Thresholds

Confidence required to act without asking:

| Blast radius | Default threshold |
| --- | --- |
| none | 0.50 |
| low | 0.75 |
| medium | 0.90 |
| high | **1.01** |

`1.01` is deliberately unreachable. **Refunds, cancellations and account changes
always reach a human in the default configuration, however certain the model
is.** That is a business decision expressed as one number, not a technical
limit — which is exactly the point. Changing it is a visible, reviewable edit to
a config file, not an emergent property of a prompt someone tweaked.

## Hard stops

Evaluated **before** the confidence check, so a confident model can never argue
its way past one:

| Rule | Fires when |
| --- | --- |
| `vip_domain` | Sender's domain is on the VIP list |
| `always_review_intent` | Intent is `complaint` or `cancellation` |
| `below_minimum_confidence` | Confidence under 0.40 — the classification itself is not trusted |
| `needs_translation` | Message is not in a language the templates cover |
| `refund_without_amount` | A refund was proposed with no amount |
| `refund_above_cap` | Refund exceeds the auto-approval cap |
| `reply_without_template` | A templated reply was proposed without naming a template |

Every rule that fires is recorded, not just the deciding one, and the detail
strings are written to be shown verbatim to the operator reviewing the case.

## What gets stored

Each decision writes a `policy_decisions` row containing the verdict, the action,
the blast radius, both confidences, the deciding rule, every triggered rule, and
**a snapshot of the entire policy configuration in force at the time**.

That last field is what makes the record honest. Thresholds change. Without the
snapshot, a decision from three months ago would be re-read against today's
rules and appear inexplicable.

## Tuning it

All of it is environment configuration — see `.env.example`:

```bash
POLICY_THRESHOLD_MEDIUM=0.9
POLICY_THRESHOLD_HIGH=1.01        # above 1 = never automatic
POLICY_MIN_CONFIDENCE=0.4
POLICY_REFUND_AUTO_CAP_EUR=0
POLICY_VIP_DOMAINS=bigclient.com,keyaccount.eu
POLICY_ALWAYS_REVIEW_INTENTS=complaint,cancellation
```

A sensible rollout: start with everything reaching a human, watch the queue for
a fortnight, and lower a threshold only where the operators are approving the
same proposal every time without changing it. The `autonomy_rate` in
`GET /api/v1/stats` is the number to watch.

## Why not let the model decide?

It was the obvious alternative: have the model return the classification *and*
the verdict, and skip the policy layer.

Three reasons not to:

1. **A prompt cannot make a promise.** The same message can classify differently
   across runs, and a model upgrade silently re-routes the entire queue. A
   budget cap and a blocklist are contracts.
2. **Nobody can review a prompt.** A support lead can read the rules table above
   and tell you whether it matches how their team works. They cannot do that
   with a system prompt.
3. **Auditability.** "The model said 0.91" is not an explanation. "Refund of EUR
   49 exceeds the auto-approval cap of EUR 0" is.

The cost is two places that describe what a good decision looks like — the
prompt and the policy. `overrode_model` is not tracked here as it is in project
01, because the policy consumes a *proposal* rather than a competing verdict;
the equivalent signal is the share of proposals whose action an operator changes
on approval, which is visible in the audit log.
