# GoHighLevel setup

## 1. Create the custom fields

In the sub-account (location), create these **contact** custom fields. The
adapter looks them up by key and writes by id, so the keys must match exactly:

| Field key | Type |
| --- | --- |
| `ai_lead_score` | Number |
| `ai_qualification` | Single line / dropdown (`hot`, `warm`, `cold`) |
| `ai_reason` | Multi line |
| `ai_confidence` | Number |
| `ai_next_action` | Single line |
| `ai_route` | Single line |
| `ai_processed_at` | Date/time or single line |

If a field is missing the adapter fails with a message naming the location,
rather than writing a partial record.

## 2. Create a Private Integration token

**Settings → Private Integrations → Create.** Scopes needed:

- `contacts.readonly`
- `contacts.write`
- `locations/customFields.readonly`

Copy the token into `GHL_ACCESS_TOKEN`, and the sub-account id into
`GHL_LOCATION_ID`. The location id matters: **custom-field ids are per
sub-account**, so a token alone is not enough to know which field to write.

## 3. Send the webhook

Either:

- **Workflow → Custom Webhook action**, fired on a Contact Created / Updated
  trigger — gives you control over the payload and lets you add a static
  `x-webhook-secret` header; or
- a **native contact webhook**, if your plan exposes one.

Point it at the n8n webhook URL, not at this service directly. n8n normalises
the payload first — see [`n8n-setup.md`](n8n-setup.md).

## 4. Follow-up automation

The service writes an `ai-sales` / `ai-nurture` / `ai-low-priority` tag
alongside the fields. Build the follow-up workflows to trigger on **Contact Tag
Added**, not on a custom-field change — tag triggers are far more reliable in
GHL, and the tag is the machine-readable half of the write-back.

## Verifying without a real account

You do not need one to review this project. `npm run demo` and `npm test` run
the whole pipeline against a fake CRM that records what would have been written.
The GoHighLevel adapter itself is exercised in tests through an injected
`fetchImpl`, so its request shape, error mapping and retry classification are
covered without a network.
