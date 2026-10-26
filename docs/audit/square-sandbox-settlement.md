# Square Sandbox settlement prototype

This component depends on the Square adapter contract in commit `f68c9b46af83d747e55139eaac5fb724db0e43e4`, which is Draft PR #373. This branch is stacked on that commit. It does not modify PR #373, and it does not include Stripe Draft PR #372.

The schema in `sandbox/square-settlement/schema.sql` is applied only to the disposable local database `cardetail1_square_settlement_7d` on `127.0.0.1` port `5433`. It is not a commercial migration. The service does not write a commercial payment attempt, a commercial ledger row, a booking, or the Square webhook event table.

A settlement row is the only committed internal settlement. Square `COMPLETED` can make the payment eligible. It does not by itself set `financiallySettled`. Durable operation storage for a commercial processor is still future work; this prototype's idempotency is enforced by the local unique key, not by Square.
