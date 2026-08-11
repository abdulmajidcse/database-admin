-- MySQL/MariaDB fixture, mirroring the Postgres one (PLAN §13).
-- Same intent: every value here must survive an export/import round trip.

-- The docker entrypoint pipes this file through the mysql client, whose connection
-- charset is NOT utf8mb4 by default. Without this the server treats incoming UTF-8
-- bytes as latin1 and double-encodes them, so 'e-acute' lands as mojibake.
-- This is exactly the charset trap PLAN section 7.5 warns about on restore.
SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS sample CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE sample;

CREATE TABLE customers (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  display_name  VARCHAR(255) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata      JSON NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_customers_email (email),
  KEY idx_customers_created (created_at)
) ENGINE=InnoDB COMMENT='People who buy things';

CREATE TABLE orders (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id   BIGINT UNSIGNED NOT NULL,
  status        ENUM('pending','paid','shipped','cancelled') NOT NULL DEFAULT 'pending',
  total_cents   DECIMAL(20,4) NOT NULL,
  placed_on     DATE NOT NULL,
  placed_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  receipt       BLOB NULL,
  note          TEXT NULL,
  KEY idx_orders_customer (customer_id, placed_at),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE line_items (
  order_id      BIGINT UNSIGNED NOT NULL,
  line_no       INT NOT NULL,
  sku           VARCHAR(64) NOT NULL,
  qty           INT NOT NULL,
  unit_price    DECIMAL(12,2) NOT NULL,
  line_total    DECIMAL(14,2) AS (qty * unit_price) STORED,
  PRIMARY KEY (order_id, line_no),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT chk_qty CHECK (qty > 0)
) ENGINE=InnoDB;

CREATE VIEW order_totals AS
  SELECT o.id, o.customer_id, o.status, SUM(li.qty * li.unit_price) AS computed_total
  FROM orders o LEFT JOIN line_items li ON li.order_id = o.id
  GROUP BY o.id, o.customer_id, o.status;

DELIMITER //
CREATE FUNCTION customer_order_count(cid BIGINT UNSIGNED) RETURNS BIGINT
  READS SQL DATA
BEGIN
  DECLARE n BIGINT;
  SELECT COUNT(*) INTO n FROM orders WHERE customer_id = cid;
  RETURN n;
END //

CREATE TRIGGER trg_orders_before_insert BEFORE INSERT ON orders
FOR EACH ROW
BEGIN
  IF NEW.total_cents < 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'total must not be negative';
  END IF;
END //
DELIMITER ;

-- The type-fidelity table.
CREATE TABLE type_torture (
  id             INT PRIMARY KEY,
  big            BIGINT,
  big_unsigned   BIGINT UNSIGNED,
  exact          DECIMAL(38,10),
  tiny_float     DOUBLE,
  when_dt        DATETIME(6),
  when_ts        TIMESTAMP NULL,
  just_date      DATE,
  just_time      TIME(6),
  yr             YEAR,
  blob_col       BLOB,
  bits           BIT(16),
  doc            JSON,
  flag           TINYINT(1),
  nasty_text     TEXT,
  empty_vs_null  VARCHAR(64)
) ENGINE=InnoDB;

INSERT INTO customers (email, display_name, metadata) VALUES
  ('ada@example.com','Ada Lovelace','{"tier":"gold"}'),
  ('grace@example.com','Grace Hopper','{"tier":"gold","note":"nanoseconds"}'),
  ('alan@example.com','Alan Turing','{}'),
  ('katherine@example.com','Katherine Johnson','{"tier":"silver"}');

INSERT INTO orders (customer_id, status, total_cents, placed_on, receipt, note) VALUES
  (1,'paid',1999.5000,'2026-01-15',UNHEX('89504E470D0A1A0A'),'first order'),
  (1,'shipped',12050.0000,'2026-02-01',NULL,'gift wrapped'),
  (2,'pending',499.9900,'2026-03-10',NULL,NULL),
  (3,'cancelled',100.0000,'2026-03-11',NULL,'changed mind');

INSERT INTO line_items (order_id, line_no, sku, qty, unit_price) VALUES
  (1,1,'SKU-001',2,999.75),
  (2,1,'SKU-002',5,2410.00),
  (3,1,'SKU-003',1,499.99);

INSERT INTO type_torture VALUES (
  1,
  9223372036854775807,
  18446744073709551615,
  12345678901234567890.1234567890,
  0.1,
  '2026-06-01 12:34:56.789000',
  '2026-06-01 10:34:56',
  '2026-06-01',
  '12:34:56.789000',
  2026,
  UNHEX('DEADBEEF00FF'),
  b'1010101010101010',
  '{"nested":{"a":[1,2,3]},"unicode":"héllo ☃"}',
  1,
  'comma, "quote", tab\there, newline\nhere, unicode ☃ émoji 🎉, backslash \\ end',
  ''
);

INSERT INTO type_torture (id, big, exact, nasty_text, empty_vs_null) VALUES
  (2, -9223372036854775808, -0.0000000001, NULL, NULL);

CREATE TABLE events (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  occurred DATETIME NOT NULL,
  kind     VARCHAR(32) NOT NULL,
  payload  JSON
) ENGINE=InnoDB;

-- 20k rows so paging and virtualization get a real workout.
-- cte_max_recursion_depth defaults to 1000, which aborts this generator.
SET SESSION cte_max_recursion_depth = 100000;
INSERT INTO events (occurred, kind, payload)
WITH RECURSIVE seq(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20000
)
SELECT NOW() - INTERVAL n MINUTE,
       ELT(1 + (n % 4), 'click', 'view', 'purchase', 'refund'),
       JSON_OBJECT('n', n, 'bucket', n % 7)
FROM seq;

GRANT ALL PRIVILEGES ON sample.* TO 'dbadmin'@'%';
FLUSH PRIVILEGES;
