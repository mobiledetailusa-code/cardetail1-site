-- Isolated Square Sandbox settlement prototype.
-- Local disposable database only. Not a commercial migration.
-- Depends on adapter commit f68c9b46af83d747e55139eaac5fb724db0e43e4 (Draft PR #373).
-- Does not write commercial financial tables, bookings, or the webhook event table.

CREATE TABLE sandbox_payment_obligation (
  obligation_id TEXT PRIMARY KEY,
  booking_ref TEXT NOT NULL CHECK (booking_ref ~ '^TEST-[A-Z0-9-]{1,32}$'),
  purpose TEXT NOT NULL CHECK (purpose = 'sandbox_settlement_test'),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  merchant_id TEXT NOT NULL CHECK (merchant_id ~ '^MERCHANT_TEST_[A-Z0-9_]{1,48}$'),
  location_id TEXT NOT NULL CHECK (location_id ~ '^LOC_TEST_[A-Z0-9_]{1,40}$'),
  status TEXT NOT NULL CHECK (status IN ('authorized', 'settled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sandbox_payment_operation (
  operation_id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL UNIQUE REFERENCES sandbox_payment_obligation (obligation_id),
  provider TEXT NOT NULL CHECK (provider = 'square_sandbox'),
  idempotency_key TEXT NOT NULL UNIQUE,
  square_payment_id TEXT UNIQUE,
  expected_amount_cents INTEGER NOT NULL CHECK (expected_amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  expected_merchant_id TEXT NOT NULL,
  expected_location_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'associated', 'settled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sandbox_payment_event (
  event_id TEXT PRIMARY KEY,
  square_payment_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('payment.created', 'payment.updated', 'provider.retrieve')),
  merchant_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  amount_cents INTEGER,
  currency TEXT,
  processing_status TEXT NOT NULL CHECK (processing_status IN (
    'stored',
    'awaiting_association',
    'pending',
    'settled',
    'already_settled',
    'quarantined',
    'rejected',
    'ignored_stale',
    'inconsistent'
  )),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('trusted_mock', 'authenticated_event')),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sandbox_payment_event_payment_idx
  ON sandbox_payment_event (square_payment_id, observed_at);

CREATE TABLE sandbox_settlement (
  settlement_id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL UNIQUE REFERENCES sandbox_payment_obligation (obligation_id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES sandbox_payment_operation (operation_id),
  square_payment_id TEXT NOT NULL UNIQUE,
  settled_amount_cents INTEGER NOT NULL CHECK (settled_amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
