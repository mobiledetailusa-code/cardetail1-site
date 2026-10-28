# Square Sandbox settlement prototype

This component depends on the Square adapter contract in commit `f68c9b46af83d747e55139eaac5fb724db0e43e4`, which is Draft PR #373. This branch is stacked on that commit. It does not modify PR #373, and it does not include Stripe Draft PR #372.

Observations are stored as unverified evidence. Settlement commits only after this service retrieves the payment through the adapter contract, using the payment id already stored on the operation and an injected mock client. That mock is synthetic test input. It is not Square authentication. Caller-supplied trust labels and timestamps cannot authorize settlement. `financiallySettled` is true only when the call committed a matching `sandbox_settlement` row or a later read confirmed that row.

The connection gate opens only `cardetail1_square_settlement_7d` on loopback port `5432` or `5433`. It does not read `DATABASE_URL`. Local tests use port `5433` unless `SQUARE_SETTLEMENT_TEST_PORT` is explicitly `5432` or `5433`. The full-test job creates that database on the ephemeral Postgres service and runs the settlement tests in the service network namespace. Commercial migrations stay on `cardetail1_ci`. The settlement schema is applied by the test harness, not by the workflow.

## CI credential handling

The settlement setup and test steps derive their disposable PostgreSQL password inside the script from the existing loopback-only `DATABASE_URL`; they do not declare another plaintext step-level password. The test launcher registers the derived value with GitHub Actions masking before forwarding it into the PostgreSQL service namespace.

The same disposable static password remains in the PostgreSQL service-container configuration and can appear in container startup logs before any user step can register a mask. Fully hiding that startup value would require a long-lived Actions secret or a broader service-authentication change, neither of which is introduced here. This credential is not a Neon, Square, Stripe, or production credential.

## Phase 7E.6 transaction locking policy

The audit covers every SQL site in `square-sandbox-settlement.js`, including inserts, updates, foreign-key checks, uniqueness conflicts, inbox recovery, and post-rollback reads. The second confirmed cycle was `createOperation` retry holding an obligation while waiting for the operation, against verification holding the operation while waiting for the obligation. Payment advisory locks alone do not cover the retry or cross-payment index conflicts.

Every financial transaction now acquires the same database-scoped transaction advisory gate, keyed by `cardetail1.square-settlement.transaction.v1`, immediately after `BEGIN` and before its callback performs financial SQL. The hierarchy is: component gate, optional payment advisory lock, then row/index/foreign-key work. All seven transactional callbacks use the shared `transaction()` helper. No callback opens a nested transaction or performs provider I/O.

This deliberately serializes the short database phases for the isolated prototype. Only one compliant transaction can hold application row or constraint locks at a time, so another compliant transaction cannot hold a conflicting financial row while waiting for that holder. Different row sequences below the gate therefore cannot form a cycle between service transactions. This also covers waits from unique-index conflicts and foreign-key checks, rather than only explicit `FOR UPDATE` statements. It avoids adding an optimistic new-versus-retry branch that would itself need revalidation across operation creation and payment association races. The existing new-operation, retry, and already-settled return contracts remain distinct and unchanged.

`COMMIT` and `ROLLBACK` release the gate automatically. Constraint violations still roll back before conflict recovery; there is no automatic replay of an ambiguous financial transaction. PostgreSQL uniqueness remains authoritative. Isolation level, schema, foreign keys, and uniqueness constraints are unchanged.

### Lock acquisition matrix

`G` = component transaction gate; `P` = payment advisory lock; `R` = operation row; `O` = obligation row; `E` = inbox event rows; `S` = settlement row. Arrows show SQL acquisition order, not a claim that every operation has the same row sequence. All transactional sequences begin with `G`.

| Entry point or helper | Locks and SQL order | Boundary and historical conflict |
| --- | --- | --- |
| `createObligation` | G, insert O, primary-key index | One transaction. Formerly could overlap obligation creation/read paths; now queues at G. |
| `createOperation`, new | G, O `FOR UPDATE`, R key lookup, insert R, unique obligation/key indexes, parent-O FK check | One transaction. Concurrent creation, key reuse, and association are serialized before row/index work. |
| `createOperation`, retry | G, O `FOR UPDATE`, existing R `FOR UPDATE` by key | One transaction. The previous O-to-R cycle with verification, association, or inbox review is blocked at G. No authorization or association field is rewritten. |
| `createOperation`, settled | G, O `FOR UPDATE`, plain committed S lookup | Same transaction, returns rejection with financially-settled evidence only when the committed row matches; never reopens O. |
| `associatePayment` | G, P, R `FOR UPDATE`, update R/unique payment index, `reviewInbox` | Commit before optional verification. Formerly opposed retry's O-to-R order; different operations competing for one payment also meet G before uniqueness checks. |
| `ingestObservation` | G, P, insert E/unique event conflict, `reviewInbox` | Commit before optional verification. Early unassociated events stay durable; duplicate event IDs use `ON CONFLICT DO NOTHING`. Cross-payment event-key conflicts are also inside G. |
| `readOperation` | G, preliminary payment read, P, R `FOR UPDATE`, association revalidation, O `FOR UPDATE`, S `FOR UPDATE` | Commits before retrieval. The preliminary association remains subject to locked revalidation. Formerly opposed retry's O-to-R order. |
| `reviewInbox` | Parent G/P, R `FOR UPDATE`, E `FOR UPDATE` ordered by event ID, O `FOR UPDATE`, S `FOR UPDATE`, update E | No independent transaction; only called from association or ingestion. Conflicts with verification/commit and retry remain below the shared G. |
| `commitSettlement` | G, P, R `FOR UPDATE`, O `FOR UPDATE`, S `FOR UPDATE`, insert S/unique indexes/parent R and O FK checks, update O/R, insert and update E | New transaction after retrieval. Unique-conflict recovery starts only after rollback releases G. Exactly one committed S remains the settlement authority. |
| `recordVerification` | G, insert E/primary-key index | Separate transaction for unsuccessful or nonterminal retrieval. No settlement is inserted. |
| `loadSettlement`, `insertSettlement`, `insertObservation`, `markOpenEvents` | Use the parent's G; row, index and FK operations listed above | Helpers never connect or begin independently and never acquire G after holding rows. |
| `confirmCommittedSettlement` | Plain MVCC read after the failed transaction has rolled back | No explicit financial row/advisory locks and no writes. Checks exact committed obligation, operation, payment, amount and currency; cannot close a wait cycle through G. |
| `verifyAndSettle` | G in read phase, no locks during injected retrieval, G in commit or observation phase | No encompassing transaction across provider retrieval. Concurrent retrievals may occur; their commit phases serialize and retain exactly-once database effects. |

Parent FK checks on operation and settlement inserts and unique-index transaction waits were included in the audit. Relevant PostgreSQL references: [locking and advisory-lock lifetime](https://www.postgresql.org/docs/16/explicit-locking.html), [unique-index checks](https://www.postgresql.org/docs/16/index-unique-checks.html), and [foreign-key trigger implementation](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/utils/adt/ri_triggers.c).

### Deterministic proof and regression boundaries

The operation-retry regression uses two blocker transactions: one holds the operation row and another holds its obligation. The retry is observed waiting for the obligation; the competitor is observed waiting on a PostgreSQL lock. The obligation blocker is released first, and the retry is observed waiting for the operation. Releasing the operation blocker exposes the original cycle on uncorrected code. On base `cb678658e7c28e8e023de39e44bd4e44584b4473`, the new regression failed with the database deadlock counter increasing from 4 to 5. The unchanged schedule passes with G, preserving the operation identity and one exact committed settlement row.

The same barriers cover retry versus webhook ingestion, payment association, and another retry. Verification versus webhook ingestion also has its earlier advisory-lock schedule retained at the settlement layer. Other coverage checks simultaneous verification, operation creation, unique payment association, duplicate events, authorization immutability, settled retries, rollback recovery, and progress of an operation retry from inside the injected retrieval callback (proving no gate or financial row lock spans retrieval).

This is a cooperative component policy, not protection against arbitrary SQL writers or schema changes. All future financial writers must enter G before financial SQL; mixed old/new writers invalidate the proof. Test schema reset and the standalone constraint proof require quiescent traffic and intentionally run outside operational transactions. Long manual transactions can still cause bounded timeouts. Throughput is limited by serial database phases; any future per-resource replacement needs its own complete lock/FK/index proof and regressions before use. No production-readiness or payment-activation claim follows from this correction.

### Local validation record

The new deterministic operation-retry regression failed on the uncorrected base and passed after the transaction-gate correction. The complete settlement suite passed 35 tests with zero failures or skips. The preserved bridge suite passed 28 tests, including its original verification-versus-webhook lock regression, using a process-local module-cache substitution of only the corrected settlement dependency. The bridge files and its integration branch were read unchanged; no Git merge or branch update was used for this compatibility check.

Square HMAC, receiver, adapter, provider, disabled-provider and payment-closure suites passed 83 tests. Financial invariants passed 134 tests on disposable loopback PostgreSQL. Total targeted tests: 280 passed, zero failed or skipped. The standalone database constraint proof returned its expected `23505` uniqueness and `23514` check violations with no proof failures.

Additional stress repeated eight concurrency scenarios for 25 rounds: 200 passed test executions, no failed rounds, and database deadlocks unchanged at 5 before and after. These repeated runs support the controlled lock-barrier proofs rather than replacing them.

The repository suite was run before and after the correction in this same worktree with identical test selection, environment flags and disposable local database. Both runs reported 4,568 tests: 4,527 passed, 41 failed, zero cancelled and zero skipped. All 41 failing test source locations matched exactly; no failures were added or removed. This establishes those failures on the local base rather than assuming Windows failures are preexisting. It does not declare the repository suite green or establish a Linux GitHub CI result. No CI workflow, schema, provider, receiver, bridge, commercial financial code, dependency or payment gate was changed.

## Phase 7E.9A: canonical PostgreSQL connection boundary

The Phase 7E.9 audit found that the URL gate checked an allowed authority but forwarded the original connection string to `pg.Client`. Offline construction of the installed driver confirmed that `?host=example.invalid` changed its effective host and `?port=6543` changed its effective port, despite the gate accepting loopback port 5433. No remote connection was attempted. The post-connection identity check could not prevent an unauthorized connection attempt.

The correction is based directly on settlement commit `4432d8000e2c8a6712b26cde3fcbb51933a9bf17`. The gate now accepts only a primitive string using `postgres:` or `postgresql:`, one explicit user authority, literal `127.0.0.1` or `localhost`, explicit port 5432 or 5433, and the literal dedicated database path. It rejects every query parameter and fragment, including empty delimiters, rather than maintaining an override blacklist. Missing usernames, empty explicit passwords, sockets, malformed escapes, ambiguous authority delimiters, raw whitespace/control characters, backslashes and noncanonical destination spellings are refused with a credential-free error before client construction. A username without a password remains supported for the disposable local server's existing trust authentication. Reserved password characters must be percent-encoded and are decoded once.

`pg.Client` receives a newly constructed configuration object, never `connectionString`. The accepted `localhost` alias becomes `127.0.0.1` before driver construction, avoiding DNS resolution. Port is numeric; database and validated username are explicit. SSL is disabled for this isolated TCP loopback component, SSL negotiation and client encoding are fixed, and application name, replication mode and startup options are controlled. Connection timeout remains 5 seconds and statement timeout remains 8 seconds.

The installed `pg` driver falls back to environment values for falsy configuration fields. In particular, an empty password string would permit `PGPASSWORD` fallback. A password provider returns the validated password string, including the empty string for passwordless local authentication, without falling back to environment credentials or a pgpass file. Other identity fields are nonempty explicit settings. Fixed startup options prevent `PGOPTIONS` from overriding the statement timeout. Tests exercise actual driver parameter construction and password resolution with hostile PostgreSQL environment values; no environment values are read by the gate itself.

After connecting, the gate still checks server database, address and port, and additionally checks `current_user` against the validated username. Failure to connect, a failed proof query, or a mismatched identity closes the client. The shared financial transaction gate, authorization rules, SQL schema and settlement response contracts are unchanged.

### Client entry-point review

The settlement service, committed-row recovery, schema application/reset helpers, constraint proof and PostgreSQL test helpers all use `connectProven`. The preserved bridge imports that dependency through settlement and its test helpers; it creates no independent database client. The separate Actions database-preparation script constructs its client with hardcoded loopback host/port, fixed database names and user, and a validated nonempty disposable password. It does not forward its source URL to the driver. No additional destination-override path was found within the reviewed settlement scope. The workflow and receiver were not modified.

### Local correction validation

The new offline regression file reported 13 passes and 39 failures against the original implementation, then 52 passes with zero failures, cancellations or skips after correction. Its 41 rejected-input cases assert zero client constructions, connection calls and queries, plus credential-free validation errors. Remaining cases inspect the actual driver's canonical configuration, hostile environment handling, post-connection identity rejection and cleanup. The offline suite never opens a socket.

The complete settlement suite passed 36 tests, including a new real loopback identity/timeout proof. All 28 unchanged bridge tests passed using process-local aliases of only the corrected settlement and database dependencies; no preserved bridge file or worktree was edited. Five settlement deterministic selections and the bridge gate-contention regression also passed separately. Database deadlocks remained 5 before and after these controlled runs. The standalone constraint proof returned expected `23505` uniqueness and `23514` currency violations, with no proof failures. Rollback, retry, association and committed-row verification remain covered by the unchanged financial tests.

Financial invariants passed 134 tests. Disabled-provider and customer-payment closure suites passed 33 tests across three files. Together with offline, settlement and bridge suites, 283 targeted tests passed, excluding the six separately repeated deterministic cases.

The full Windows repository baseline at the unchanged parent recorded 4,568 tests: 4,535 passed and 33 failed. The candidate recorded 4,620 tests: 4,579 passed and 41 failed, including all 52 added offline tests. Both had zero cancellations or skips. The original failure locations matched. The eight additional booking failures were investigated with identical focused test selection, Node runtime, environment flags and local database settings on both the candidate and a clean unchanged parent checkout. Both focused runs recorded 37 tests: 29 passed and the same eight failed, with `booking_slot_unavailable` and HTTP 409 versus expected 200. The unchanged baseline checkout remained clean. Thus every candidate failure location was baseline-reproduced; the underlying causes were not all diagnosed. The full repository suite is not green, and no new GitHub CI result is claimed for this local correction.

### Phase 7E.9E response and recovery remediation

The adapter-owned response correction is inherited through a normal local merge. Settlement independently requires an error-free successful HTTP contract before accepting reconciliation flags. No failed or contradictory body can replace the stored authorization or association.

An internal `provider.retrieve` attempt with source kind `verified_provider_retrieval` but no payment status, amount or currency is unavailable verification evidence, not a payment-identity assertion. The historical source-kind name records provenance; it does not authorize settlement. Inbox review excludes only that server-generated unavailable-data tuple from payment classification, and status updates leave its audit record intact. Legacy empty/null fields and already-inconsistent attempt rows remain recoverable without rewriting or deleting history. No schema or identity/uniqueness constraint changes are needed.

Complete contradictory observations still quarantine. Explicit provider identity-conflict quarantine also remains blocking on later normal inbox retries, including payment-id and location mismatches whose returned identity was not previously retained in the snapshot fields. Untrusted observations cannot claim internal retrieval provenance. Every successful recovery still performs fresh injected retrieval, validates the stored expected identity, and commits one matching settlement under the existing transaction gate. Direct trusted verification remains the existing explicit investigation path.

Regression coverage includes same/new-event retries after 429, 500, malformed JSON and timeout; legacy failed snapshots; genuine identity conflicts; and acknowledgement loss before/after real local COMMIT. An unacknowledged result is resolved by re-reading committed evidence, never by creating another payment. This remains local synthetic testing, with no provider API calls or CI execution.

Local targeted validation passed 60 settlement tests and all 52 unchanged PostgreSQL isolation tests, with no failures or skips. The adapter-owned correction separately passed its 30 contract and 16 sandbox-provider tests before integration. These results do not claim GitHub CI approval of unpublished local commits.

### Remaining boundary

This is an isolated prototype connection policy, not authorization to deploy or contact a remote database. It does not defend against arbitrary code replacing the driver, direct SQL clients outside the component, or a compromised local PostgreSQL server. The CI bootstrap is a separate fixed-destination path. The global transaction gate remains cooperative and serializes database phases. Synthetic provider authentication and the previously documented disposable CI container-password exposure remain separate limitations. Publishing the settlement correction, updating the dependent bridge and resuming the final audit require separate authorization; no push, PR change, merge, deployment, provider API call or payment activation is part of this phase.
