-- Dedicated Square Sandbox webhook inbox.
-- Apply this file only to the sandbox database named by
-- SQUARE_SANDBOX_WEBHOOK_DATABASE_URL.
-- Do not apply it to the commercial Cardetail1 database.
-- Nothing in CI or in the webhook function runs this file.

CREATE TABLE IF NOT EXISTS square_sandbox_webhook_event (
  event_id TEXT PRIMARY KEY,
  merchant_id TEXT,
  event_type TEXT,
  payment_id TEXT,
  payment_status TEXT,
  event_created_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verification_result TEXT NOT NULL,
  processing_state TEXT NOT NULL,
  amount_cents INTEGER,
  currency TEXT,
  CONSTRAINT square_sandbox_webhook_event_state_check
    CHECK (processing_state IN ('stored', 'unsupported', 'rejected_merchant')),
  CONSTRAINT square_sandbox_webhook_event_verification_check
    CHECK (verification_result = 'verified')
);
