# Phase 7E.9J local verified-bridge integration

Base: PR #375 head `42ed4790bada0107d6bea2234a184061e7cc79c8`.

Normal local merge: `693f792061bcca55246ad2b7e991350ab604a601`, with
settlement correction `7fe52ad6c07dd058fdf789f4178b242a3e319ea8` as its second parent.
Existing PR and Cursor branches are preserved. Nothing is pushed.

Follow-up normal merge: `b6451fdcfe8baddcd0b74ab8f742ce814b65b930`, inheriting
registration ordering correction `a476bd3dbc2f98fc367a5a46363c5f4b161d1e1b`.

Bridge implementation, HMAC verifier, adapter, production payment paths, credentials,
deployment configuration and GitHub Actions remain unchanged. Settlement changes
are inherited through the merge. This branch adds signed bridge regressions and
this integration note only.

The synthetic path is HMAC verification -> durable observation -> stored payment
association -> committed verification fence -> injected retrieval outside database
transactions -> durable outcome -> current quarantine/fence revalidation -> atomic
settlement COMMIT -> financial response.

Ten additional bridge cases cover:

* A held valid retrieval versus durable amount or payment-ID quarantine.
* A signed conflict after settlement, retaining the financial row and surfacing
  `investigationRequired` on the initial and subsequent signed delivery.
* Settlement committing between operation read and verification registration.
  A real COMMIT barrier reproduces the gap; registration confirms the existing
  row without starting a late retrieval.
* Real PostgreSQL history-update failure with both same-event and new-event retries:
  a good response cannot clear the unknown attempt; re-observing the conflict records
  quarantine, after which normal reconciliation blocks without another retrieval.
* History registration INSERT failure (no retrieval starts), failed COMMIT before
  execution, lost acknowledgement after actual COMMIT, and cleanup failure after
  a committed quarantine. No failed persistence is reported as completed quarantine.

All added end-to-end cases use the real bridge entry point with synthetic signatures,
injected GET callbacks and the disposable local PostgreSQL fixture. No provider API
or remote financial database is contacted. Previous P1-1, P1-2, concurrency, uniqueness,
rollback, HMAC and commercial-isolation cases remain required.

See [settlement recovery contract](../square-settlement/QUARANTINE-DURABILITY.md).
An unresolved verification is a deliberate settlement block requiring investigation;
this phase does not authorize a reset or automatic release. These tests do not prove
live Square account identity, a real Sandbox webhook, or commercial readiness.
