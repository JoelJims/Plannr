-- Plannr test database: the schema db.js built at commit f89af97 (2026-08-24 Phase 10a: replace ledger taxonomy with contract-derived 24-category list),
-- with made-up rows in every table (no real data). Made by make-fixtures.js; do not edit by hand.
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL COLLATE NOCASE UNIQUE,
      display_name  TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
INSERT INTO "users" ("id", "username", "display_name", "password_hash", "created_at") VALUES (1, 'owner', 'Owner', 'local-single-user-no-auth', '2026-11-17 13:36:16');
INSERT INTO "users" ("id", "username", "display_name", "password_hash", "created_at") VALUES (2, 'site-helper', 'Site helper (Ravi)', 'local-single-user-no-auth', '2025-02-11 01:15:00');
CREATE TABLE "settings" (key TEXT NOT NULL PRIMARY KEY, value TEXT);
INSERT INTO "settings" ("key", "value") VALUES ('_migrated_ledger_taxonomy_v1', '1');
INSERT INTO "settings" ("key", "value") VALUES ('budget_paise', '5000000000');
INSERT INTO "settings" ("key", "value") VALUES ('backup_reminder_days', '14');
CREATE TABLE "contract" (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      contractor_name         TEXT,
      area_of_work            TEXT,
      ledger_code             TEXT,
      subledger_code          TEXT,
      ledger_custom_name      TEXT,
      subledger_custom_name   TEXT,
      amount_paise            INTEGER,
      price_of_contract_paise INTEGER,
      contract_end_date       TEXT,
      date_signed             TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at              TEXT,
      company                 TEXT
    );
INSERT INTO "contract" ("id", "contractor_name", "area_of_work", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "amount_paise", "price_of_contract_paise", "contract_end_date", "date_signed", "created_at", "updated_at", "deleted_at", "company") VALUES (1, 'Example Builders', 'Civil work', '4.0', '4.2', NULL, NULL, 900000000, 900000000, '2026-12-31', '2025-05-30', '2025-07-16 06:15:00', '2025-08-17 07:15:00', NULL, 'Example Builders Pvt Ltd');
INSERT INTO "contract" ("id", "contractor_name", "area_of_work", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "amount_paise", "price_of_contract_paise", "contract_end_date", "date_signed", "created_at", "updated_at", "deleted_at", "company") VALUES (2, 'Old Painter', 'Painting', 'CUSTOM', NULL, 'Painting work', NULL, 4500000, NULL, NULL, '2025-04-01', '2025-08-17 07:15:00', '2025-01-18 08:15:00', '2025-02-19 09:15:00', NULL);
CREATE TABLE "contract_payment_dates" (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
      pay_date    TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
INSERT INTO "contract_payment_dates" ("id", "contract_id", "pay_date", "created_at") VALUES (1, 1, '2025-07-01', '2025-04-11 01:15:00');
INSERT INTO "contract_payment_dates" ("id", "contract_id", "pay_date", "created_at") VALUES (2, 1, '2025-09-01', '2025-05-12 02:15:00');
INSERT INTO "contract_payment_dates" ("id", "contract_id", "pay_date", "created_at") VALUES (3, 1, '2025-11-01', '2025-06-13 03:15:00');
CREATE TABLE "contractor_payments" (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id           INTEGER NOT NULL REFERENCES contract(id),
      pay_date              TEXT    NOT NULL,
      amount_paise          INTEGER NOT NULL,
      ledger_code           TEXT,
      subledger_code        TEXT,
      ledger_custom_name    TEXT,
      subledger_custom_name TEXT,
      phase                 INTEGER,
      subpart               TEXT,
      remarks               TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at            TEXT
    );
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (1, 1, '2025-07-02', 150000000, '22.0', '22.5', NULL, NULL, NULL, NULL, 'Advance — ₹1.5L', '2025-05-12 02:15:00', '2025-06-13 03:15:00', NULL);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (2, 1, '2025-09-03', 200000000, 'CUSTOM', NULL, 'Contractor extras', 'Stage 2', 2, 'b', 'Second stage', '2025-06-13 03:15:00', '2025-07-14 04:15:00', NULL);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (3, 1, '2025-09-04', 99, '22.0', '22.5', NULL, NULL, NULL, NULL, NULL, '2025-07-14 04:15:00', '2025-08-15 05:15:00', '2025-01-16 06:15:00');
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (4, 1, '2025-11-02', 250000000, '22.0', '22.5', NULL, NULL, 2, 'b', 'Roof slab', '2025-08-15 05:15:00', '2025-01-16 06:15:00', NULL);
CREATE TABLE "contract_services" (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      price_paise INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at  TEXT
    );
INSERT INTO "contract_services" ("id", "contract_id", "name", "price_paise", "created_at", "updated_at", "deleted_at") VALUES (1, 1, 'Excavation', 1500000, '2025-01-18 08:15:00', '2025-02-19 09:15:00', NULL);
INSERT INTO "contract_services" ("id", "contract_id", "name", "price_paise", "created_at", "updated_at", "deleted_at") VALUES (2, 1, 'Plastering — प्लास्टर', NULL, '2025-02-19 09:15:00', '2025-03-10 00:15:00', NULL);
INSERT INTO "contract_services" ("id", "contract_id", "name", "price_paise", "created_at", "updated_at", "deleted_at") VALUES (3, 1, 'Waterproofing', 250000, '2025-03-10 00:15:00', '2025-04-11 01:15:00', '2025-05-12 02:15:00');
CREATE TABLE "cash_in" (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise INTEGER NOT NULL,
      tx_date      TEXT,
      by_type      TEXT    NOT NULL,
      by_user_id   INTEGER REFERENCES users(id),
      by_label     TEXT,
      reason       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at   TEXT
    );
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at") VALUES (1, 50000000, '2025-06-01', 'user', 1, NULL, 'Savings', '2025-07-14 04:15:00', '2025-08-15 05:15:00', NULL);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at") VALUES (2, 25000000, '2025-06-02', 'user', 2, NULL, 'Salary', '2025-08-15 05:15:00', '2025-01-16 06:15:00', NULL);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at") VALUES (3, 1234500, '2025-06-03', 'relative', NULL, 'Father', 'Family contribution', '2025-01-16 06:15:00', '2025-02-17 07:15:00', NULL);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at") VALUES (4, 99, '2025-06-04', 'relative', NULL, 'Brother — भाई', NULL, '2025-02-17 07:15:00', '2025-03-18 08:15:00', '2025-04-19 09:15:00');
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at") VALUES (5, 300000000, '2025-06-05', 'user', 1, NULL, 'Loan disbursement', '2025-03-18 08:15:00', '2025-04-19 09:15:00', NULL);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at") VALUES (6, 7500000, '2025-06-06', 'relative', NULL, 'Relative', 'Gift', '2025-04-19 09:15:00', '2025-05-10 00:15:00', NULL);
CREATE TABLE "cash_out" (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise          INTEGER NOT NULL,
      tx_date               TEXT,
      by_type               TEXT    NOT NULL,
      by_user_id            INTEGER REFERENCES users(id),
      by_label              TEXT,
      ledger_code           TEXT    NOT NULL,
      subledger_code        TEXT,
      ledger_custom_name    TEXT,
      subledger_custom_name TEXT,
      reason                TEXT,
      contract_scope        TEXT    NOT NULL,
      contract_stated_paise INTEGER,
      phase                 INTEGER,
      subpart               TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at            TEXT,
      contract_service_id   INTEGER REFERENCES contract_services(id)
    );
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (1, 123456, '2025-07-10', 'user', 1, NULL, '4.0', '4.2', NULL, NULL, 'Stamp duty', 'extra', NULL, NULL, NULL, '2025-05-10 00:15:00', '2025-06-11 01:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (2, 99, '2025-07-11', 'user', 2, NULL, '22.0', '22.5', NULL, NULL, 'Cement 50 bags', 'included', 98, 2, 'b', '2025-06-11 01:15:00', '2025-07-12 02:15:00', NULL, 1);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (3, 4500000, '2025-07-12', 'custom', NULL, 'Mason', '5.0', NULL, NULL, NULL, 'Steel rods', 'extra', NULL, NULL, NULL, '2025-07-12 02:15:00', '2025-08-13 03:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (4, 78000, '2025-07-13', 'user', 2, NULL, '4.0', '4.2', NULL, NULL, NULL, 'included', NULL, NULL, NULL, '2025-08-13 03:15:00', '2025-01-14 04:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (5, 250000, '2025-07-14', 'user', 1, NULL, 'CUSTOM', NULL, 'Pooja flowers', 'Marigold — गेंदा', 'Pooja', 'extra', NULL, NULL, NULL, '2025-01-14 04:15:00', '2025-02-15 05:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (6, 1000000, '2025-07-15', 'custom', NULL, 'Mason', '5.0', NULL, NULL, NULL, 'Sand load', 'included', NULL, 2, 'b', '2025-02-15 05:15:00', '2025-03-16 06:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (7, 333, '2025-07-16', 'user', 1, NULL, '4.0', '4.2', NULL, NULL, 'Nails', 'extra', NULL, NULL, NULL, '2025-03-16 06:15:00', '2025-04-17 07:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (8, 5600000, '2025-07-17', 'user', 2, NULL, '22.0', '22.5', NULL, NULL, 'Tiles', 'included', NULL, NULL, NULL, '2025-04-17 07:15:00', '2025-05-18 08:15:00', '2025-06-19 09:15:00', NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (9, 120000, '2025-07-18', 'custom', NULL, 'Mason', '5.0', NULL, NULL, NULL, 'Paint', 'extra', NULL, NULL, NULL, '2025-05-18 08:15:00', '2025-06-19 09:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (10, 98000, NULL, 'user', 2, NULL, '4.0', '4.2', NULL, NULL, 'Transport', 'included', NULL, 2, 'b', '2025-06-19 09:15:00', '2025-07-10 00:15:00', NULL, NULL);
CREATE TABLE "loans" (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise  INTEGER,
      bank_name     TEXT,
      interest_rate REAL,
      tenure        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at    TEXT
    );
INSERT INTO "loans" ("id", "amount_paise", "bank_name", "interest_rate", "tenure", "created_at", "updated_at", "deleted_at") VALUES (1, 2500000000, 'Example Bank', 8.4, '15 years', '2025-07-10 00:15:00', '2025-08-11 01:15:00', NULL);
INSERT INTO "loans" ("id", "amount_paise", "bank_name", "interest_rate", "tenure", "created_at", "updated_at", "deleted_at") VALUES (2, 50000000, 'Cooperative Society', 10.25, '3 years', '2025-08-11 01:15:00', '2025-01-12 02:15:00', '2025-02-13 03:15:00');
CREATE TABLE "ledger_customs" (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
INSERT INTO "ledger_customs" ("id", "name", "created_at") VALUES (1, 'Temple donation for bhoomi pooja', '2025-06-15 05:15:00');
INSERT INTO "ledger_customs" ("id", "name", "created_at") VALUES (4, 'Neighbour wall repair — गेट', '2025-07-16 06:15:00');
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence (name, seq) VALUES ('cash_in', 36);
INSERT INTO sqlite_sequence (name, seq) VALUES ('cash_out', 40);
INSERT INTO sqlite_sequence (name, seq) VALUES ('contract', 2);
INSERT INTO sqlite_sequence (name, seq) VALUES ('contract_payment_dates', 3);
INSERT INTO sqlite_sequence (name, seq) VALUES ('contract_services', 3);
INSERT INTO sqlite_sequence (name, seq) VALUES ('contractor_payments', 4);
INSERT INTO sqlite_sequence (name, seq) VALUES ('ledger_customs', 4);
INSERT INTO sqlite_sequence (name, seq) VALUES ('loans', 2);
INSERT INTO sqlite_sequence (name, seq) VALUES ('users', 2);
CREATE INDEX idx_contract_payment_dates_cid   ON contract_payment_dates(contract_id);
CREATE INDEX idx_contractor_payments_cid      ON contractor_payments(contract_id);
CREATE INDEX idx_contractor_payments_paydate_live ON contractor_payments(pay_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_contract_services_cid         ON contract_services(contract_id);
CREATE INDEX idx_cash_in_by_user_id           ON cash_in(by_user_id);
CREATE INDEX idx_cash_out_ledger_code         ON cash_out(ledger_code);
CREATE INDEX idx_cash_out_txdate_live ON cash_out(tx_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_cash_out_amount_live ON cash_out(amount_paise) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_cash_out_service_live ON cash_out(contract_service_id) WHERE contract_service_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX idx_ledger_customs_name ON ledger_customs(name);
PRAGMA user_version = 2;
COMMIT;
