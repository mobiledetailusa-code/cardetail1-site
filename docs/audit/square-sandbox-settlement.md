# Square Sandbox settlement prototype

This component depends on the Square adapter contract in commit `f68c9b46af83d747e55139eaac5fb724db0e43e4`, which is Draft PR #373. This branch is stacked on that commit. It does not modify PR #373, and it does not include Stripe Draft PR #372.

Observations are stored as unverified evidence. Settlement commits only after this service retrieves the payment through the adapter contract, using the payment id already stored on the operation and an injected mock client. That mock is synthetic test input. It is not Square authentication. Caller-supplied trust labels and timestamps cannot authorize settlement. `financiallySettled` is true only when the call committed a matching `sandbox_settlement` row or a later read confirmed that row.

The connection gate opens only `cardetail1_square_settlement_7d` on loopback port `5432` or `5433`. It does not read `DATABASE_URL`. Local tests use port `5433` unless `SQUARE_SETTLEMENT_TEST_PORT` is explicitly `5432` or `5433`. The GitHub workflow is unchanged. CI still needs a separate change to create this database on its loopback service; until then the settlement tests fail visibly instead of using the commercial CI database.
