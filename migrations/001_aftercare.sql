CREATE TABLE IF NOT EXISTS tenants (
  merchant_id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS resources (
  merchant_id text NOT NULL REFERENCES tenants(merchant_id),
  kind text NOT NULL CHECK (kind IN ('policy','order','variant','quote','confirmation','request','operation')),
  id text NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (merchant_id, kind, id),
  CHECK (kind <> 'variant' OR ((body->>'stock')::integer >= 0 AND (body->>'version')::integer > 0)),
  CHECK (kind <> 'request' OR ((body->>'refundCents')::bigint >= 0 AND body->>'refundStatus' = 'not_started'))
);
CREATE UNIQUE INDEX IF NOT EXISTS request_quote_unique ON resources (merchant_id, (body->>'quoteId')) WHERE kind = 'request';
CREATE UNIQUE INDEX IF NOT EXISTS confirmation_quote_unique ON resources (merchant_id, (body->>'customerId'), (body->>'quoteId')) WHERE kind = 'confirmation';
