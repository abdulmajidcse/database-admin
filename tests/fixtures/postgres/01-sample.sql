-- Fixture schema for the dev `dbs` profile and the conformance suite (PLAN §13).
-- Deliberately full of the types that drivers silently corrupt: bigint beyond
-- 2^53, high-precision numeric, timestamptz, bytea, json, arrays, enums, and
-- text containing delimiters, quotes, newlines and unicode.

CREATE SCHEMA IF NOT EXISTS shop;

CREATE TYPE shop.order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE shop.customers (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  tags          text[] DEFAULT '{}',
  metadata      jsonb DEFAULT '{}'::jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  CONSTRAINT email_has_at CHECK (position('@' in email) > 1)
);
COMMENT ON TABLE shop.customers IS 'People who buy things';
COMMENT ON COLUMN shop.customers.tags IS 'Free-form labels';

CREATE INDEX idx_customers_created ON shop.customers (created_at DESC);
CREATE INDEX idx_customers_active ON shop.customers (email) WHERE is_active;

CREATE TABLE shop.orders (
  id            bigserial PRIMARY KEY,
  customer_id   bigint NOT NULL REFERENCES shop.customers(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  status        shop.order_status NOT NULL DEFAULT 'pending',
  total_cents   numeric(20,4) NOT NULL,
  placed_on     date NOT NULL,
  placed_at     timestamptz NOT NULL DEFAULT now(),
  duration      interval,
  receipt       bytea,
  note          text,
  line_count    integer GENERATED ALWAYS AS (1) STORED
);

CREATE INDEX idx_orders_customer ON shop.orders (customer_id, placed_at DESC);

CREATE TABLE shop.line_items (
  order_id      bigint NOT NULL REFERENCES shop.orders(id) ON DELETE CASCADE,
  line_no       integer NOT NULL,
  sku           varchar(64) NOT NULL,
  qty           integer NOT NULL CHECK (qty > 0),
  unit_price    numeric(12,2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE VIEW shop.order_totals AS
  SELECT o.id, o.customer_id, o.status, sum(li.qty * li.unit_price) AS computed_total
  FROM shop.orders o
  LEFT JOIN shop.line_items li ON li.order_id = o.id
  GROUP BY o.id, o.customer_id, o.status;

CREATE FUNCTION shop.customer_order_count(cid bigint) RETURNS bigint
  LANGUAGE sql STABLE AS $$ SELECT count(*) FROM shop.orders WHERE customer_id = cid $$;

CREATE FUNCTION shop.touch_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := COALESCE(NEW.created_at, now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_touch_customer BEFORE INSERT ON shop.customers
  FOR EACH ROW EXECUTE FUNCTION shop.touch_customer();

-- The type-fidelity table: every value here must survive a round trip.
CREATE TABLE shop.type_torture (
  id             integer PRIMARY KEY,
  big            bigint,           -- beyond 2^53, breaks JS numbers
  exact          numeric(38,10),   -- loses precision as a float
  tiny_float     double precision,
  when_tz        timestamptz,
  when_naive     timestamp,
  just_date      date,
  just_time      time,
  span           interval,
  blob           bytea,
  doc            jsonb,
  arr            integer[],
  txt_arr        text[],
  uid            uuid,
  flag           boolean,
  nasty_text     text,             -- delimiters, quotes, newlines, unicode
  empty_vs_null  text
);

INSERT INTO shop.customers (email, display_name, tags, metadata) VALUES
  ('ada@example.com',    'Ada Lovelace',  ARRAY['vip','early'], '{"tier":"gold"}'),
  ('grace@example.com',  'Grace Hopper',  ARRAY['vip'],         '{"tier":"gold","note":"nanoseconds"}'),
  ('alan@example.com',   'Alan Turing',   '{}',                 '{}'),
  ('katherine@example.com', 'Katherine Johnson', ARRAY['nasa'], '{"tier":"silver"}');

INSERT INTO shop.orders (customer_id, status, total_cents, placed_on, duration, receipt, note) VALUES
  (1, 'paid',      1999.5000, '2026-01-15', '2 days 3 hours', '\x89504e470d0a1a0a'::bytea, 'first order'),
  (1, 'shipped',  12050.0000, '2026-02-01', '45 minutes',     NULL, 'gift wrapped'),
  (2, 'pending',    499.9900, '2026-03-10', NULL,             NULL, NULL),
  (3, 'cancelled',  100.0000, '2026-03-11', NULL,             NULL, 'changed mind');

INSERT INTO shop.line_items (order_id, line_no, sku, qty, unit_price) VALUES
  (1, 1, 'SKU-001', 2, 999.75),
  (2, 1, 'SKU-002', 5, 2410.00),
  (3, 1, 'SKU-003', 1, 499.99);

INSERT INTO shop.type_torture VALUES (
  1,
  9223372036854775807,
  12345678901234567890.1234567890,
  0.1,
  '2026-06-01 12:34:56.789+02',
  '2026-06-01 12:34:56.789',
  '2026-06-01',
  '12:34:56.789',
  '1 year 2 months 3 days 04:05:06',
  '\xdeadbeef00ff'::bytea,
  '{"nested":{"a":[1,2,3]},"unicode":"héllo ☃"}',
  ARRAY[1,2,3],
  ARRAY['a,b', 'c"d', E'e\nf'],
  '11111111-2222-3333-4444-555555555555',
  true,
  E'comma, "quote", tab\there, newline\nhere, unicode ☃ émoji 🎉, backslash \\ end',
  ''
);

INSERT INTO shop.type_torture (id, big, exact, nasty_text, empty_vs_null) VALUES
  (2, -9223372036854775808, -0.0000000001, NULL, NULL);

-- A wide-ish table so paging and virtualization get exercised.
CREATE TABLE shop.events (
  id         bigserial PRIMARY KEY,
  occurred   timestamptz NOT NULL,
  kind       text NOT NULL,
  payload    jsonb
);
INSERT INTO shop.events (occurred, kind, payload)
SELECT now() - (g || ' minutes')::interval,
       (ARRAY['click','view','purchase','refund'])[1 + (g % 4)],
       jsonb_build_object('n', g, 'bucket', g % 7)
FROM generate_series(1, 20000) g;
