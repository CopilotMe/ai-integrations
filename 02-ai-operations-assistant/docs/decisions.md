# Decision records

The choices a reviewer would reasonably challenge.

---

## 1. A policy layer between the model and the side effect

**Alternative:** let the model return the action and execute it.

**Decision:** the model proposes; `domain/policy/autonomy.ts` decides; a human
authorises anything with a high blast radius.

**Why:** covered in full in [`autonomy-policy.md`](autonomy-policy.md). In one
line: a prompt cannot promise that a refund cap holds, and a support lead cannot
review one.

**Cost:** two descriptions of a good decision — the prompt and the policy. Worth
it, because only one of them is enforceable.

---

## 2. The audit log is append-only in the database, not by convention

**Alternative:** an `audit_log` table the application only ever inserts into.

**Decision:** Postgres triggers reject `UPDATE` and `DELETE` on `audit_log`, and
`UPDATE` on `messages`. Enforced in `drizzle/0001_audit_log_append_only.sql`.

**Why:** an audit trail the application can rewrite is not an audit trail. A
convention holds until the first migration script, the first "quick fix in
production", or the first developer who has not read this file. A trigger holds
regardless.

Triggers rather than `REVOKE` because on Supabase and Neon the application role
routinely owns its own schema, and an owner can grant itself back anything it
revoked.

**Cost:** the test suite cannot clean up with `DELETE`. It uses `TRUNCATE`, which
is deliberately still permitted — the guarantee is that the *application* cannot
rewrite history, not that the table is indestructible.

---

## 3. Optimistic concurrency on cases, not row locks

**Alternative:** `SELECT … FOR UPDATE` when an operator opens a case.

**Decision:** every case carries a `version`, bumped by a trigger. Approvals
send the version the operator was looking at; a mismatched update matches zero
rows and returns `409`.

**Why:** the real scenario is two operators with the same case open in two tabs
for several minutes. A pessimistic lock held across a human's thinking time is a
lock held across a coffee break, and it does nothing about the tab that was
opened before the case changed. The version check catches exactly the case that
matters: *you are approving something other than what you read*.

**Cost:** the operator occasionally has to reload. That is the correct outcome.

---

## 4. Two deduplication layers, because they answer different questions

**Decision:**
- `Idempotency-Key` header → replays the stored response for **a retried request**.
- Unique index on `(source, external_id)` → collapses **a redelivered email**.

**Why:** a client that times out and retries wants its original answer back. A
provider that delivers the same message twice through two workflows wants one
case. Neither mechanism covers the other, and the second one has to be a
database constraint — checking-then-inserting leaves the race wide open, which
an integration test demonstrates by firing three concurrent deliveries.

---

## 5. Session cookies and scrypt, not an auth provider

**Alternative:** Clerk, Auth0, or Auth.js.

**Decision:** operators in Postgres, scrypt-hashed passwords, hashed session
tokens in a `httpOnly` `SameSite=Lax` cookie, `Origin` checked on every mutation.

**Why:** the auth surface here is genuinely small — an internal console with a
handful of named operators, no self-service signup, no password reset, no social
login. Implementing that surface with Node's own primitives is a few dozen lines
and demonstrates the mechanics; adopting a provider would hide them behind a
dependency and add an external service to a project whose selling point is that
it runs with no accounts.

scrypt rather than bcrypt because it is in the standard library — no native
build step, which matters on a serverless deploy — and memory-hard, which bcrypt
is not. Argon2id would be better still if a dependency were acceptable.

**Cost:** this is exactly the boundary at which rolling your own stops being
sensible. The moment this needs SSO, MFA, or password reset, adopt a provider —
`src/server/auth.ts` is the only file that would change.

---

## 6. Next.js, rather than a separate API and SPA

**Alternative:** the Fastify service pattern from project 01, plus a Vite admin app.

**Decision:** one Next.js App Router application — route handlers for the REST
API, server components for the console.

**Why:** one deployable, one auth context, one set of types shared end to end,
and Vercel-native. Project 01 already demonstrates a standalone service; doing
it again would show less, not more.

The business logic still does not know Next.js exists: `core/` imports nothing
from `next`, and the route handlers are thin. That is what keeps the pipeline
testable without booting a server, and what would make extracting a worker
process straightforward if intake ever needed to be queued.

---

## 7. Fakes for every provider, shipped as product

**Decision:** `FakeClassifier`, `FakeExecutor` and `FakeNotifier` are default
configuration, not test scaffolding.

**Why:** the same reasoning as project 01, and it held up again. `npm run demo`
runs the complete pipeline — classification, policy, execution, audit — with no
API key, no network and no spend. A portfolio project that needs an account to
review is a project nobody reviews.

**Cost:** the fake classifier is a keyword matcher and proves nothing about
model quality. It is not meant to: the tests around it are testing the system
*around* the model, which is the part that has to be right whichever model is
plugged in.
