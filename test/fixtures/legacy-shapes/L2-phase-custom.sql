-- Made by make-legacy-shapes.js from 01-7cfcf89.sql. MADE-UP data, made-up older shape:
-- user_version 0, before tenancy, cash_out in the old phase/subpart design (text values, 'CUSTOM' sentinels, phase_custom_name / subpart_custom_name), without the services link; cash_in already dated; taxonomy already moved and the service price drop approved in settings
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL COLLATE NOCASE UNIQUE,
      display_name  TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
INSERT INTO "users" ("id", "username", "display_name", "password_hash", "created_at") VALUES (1, 'owner', 'Owner', 'local-single-user-no-auth', '2025-01-10 00:15:00');
INSERT INTO "users" ("id", "username", "display_name", "password_hash", "created_at") VALUES (2, 'site-helper', 'Site helper (Ravi)', 'local-single-user-no-auth', '2025-02-11 01:15:00');
CREATE TABLE sessions (
      token_hash TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT    NOT NULL DEFAULT (datetime('now', '+90 days'))
    , ip TEXT, user_agent TEXT);
INSERT INTO "sessions" ("token_hash", "user_id", "created_at", "expires_at", "ip", "user_agent") VALUES ('abababababababababababababababababababababababababababababababab', 1, '2025-03-12 02:15:00', '2025-12-01 00:00:00', '127.0.0.1', 'test agent');
CREATE TABLE contract_services (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,             -- service name (required)
      price_paise INTEGER,                      -- OPTIONAL price, paise (₹1=100); NULL = unpriced (can't be picked on a debit)
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at  TEXT,                         -- soft-delete: NULL = live
      tenant_id   INTEGER NOT NULL REFERENCES users(id) -- Services phase: owning household (mirrors the parent contract's tenant)
    );
INSERT INTO "contract_services" ("id", "contract_id", "name", "price_paise", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (1, 1, 'Excavation', 1500000, '2025-01-18 08:15:00', '2025-02-19 09:15:00', NULL, 1);
INSERT INTO "contract_services" ("id", "contract_id", "name", "price_paise", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (2, 1, 'Plastering — प्लास्टर', NULL, '2025-02-19 09:15:00', '2025-03-10 00:15:00', NULL, 1);
INSERT INTO "contract_services" ("id", "contract_id", "name", "price_paise", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (3, 1, 'Waterproofing', 250000, '2025-03-10 00:15:00', '2025-04-11 01:15:00', '2025-05-12 02:15:00', 1);
CREATE TABLE ledger_customs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES users(id), -- the owning user (per-user list)
      name       TEXT    NOT NULL,                       -- the custom ledger name
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
CREATE TABLE edit_locks (
      scope               TEXT PRIMARY KEY,
      holder_user_id      INTEGER,
      holder_display_name TEXT,
      acquired_at         TEXT,
      last_heartbeat_at   TEXT
    );
INSERT INTO "edit_locks" ("scope", "holder_user_id", "holder_display_name", "acquired_at", "last_heartbeat_at") VALUES ('ledger', 1, 'Owner', '2025-04-13 03:15:00', '2025-04-13 03:15:00');
CREATE TABLE cash_in (id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, by_type TEXT NOT NULL, by_user_id INTEGER REFERENCES users(id), by_label TEXT, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT, tx_date TEXT);
INSERT INTO "cash_in" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tx_date") VALUES (1, 50000000, 'user', 1, NULL, 'Savings', '2025-07-14 04:15:00', '2025-08-15 05:15:00', NULL, '2025-07-14');
INSERT INTO "cash_in" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tx_date") VALUES (2, 25000000, 'user', 2, NULL, 'Salary', '2025-08-15 05:15:00', '2025-01-16 06:15:00', NULL, '2025-08-15');
INSERT INTO "cash_in" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tx_date") VALUES (3, 1234500, 'relative', NULL, 'Father', 'Family contribution', '2025-01-16 06:15:00', '2025-02-17 07:15:00', NULL, '2025-01-16');
INSERT INTO "cash_in" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tx_date") VALUES (4, 99, 'relative', NULL, 'Brother — भाई', NULL, '2025-02-17 07:15:00', '2025-03-18 08:15:00', '2025-04-19 09:15:00', '2025-02-17');
INSERT INTO "cash_in" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tx_date") VALUES (5, 300000000, 'user', 1, NULL, 'Loan disbursement', '2025-03-18 08:15:00', '2025-04-19 09:15:00', NULL, '2025-03-18');
INSERT INTO "cash_in" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tx_date") VALUES (6, 7500000, 'relative', NULL, 'Relative', 'Gift', '2025-04-19 09:15:00', '2025-05-10 00:15:00', NULL, '2025-04-19');
CREATE TABLE loans (id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, bank_name TEXT, interest_rate REAL, tenure TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
INSERT INTO "loans" ("id", "amount_paise", "bank_name", "interest_rate", "tenure", "created_at", "updated_at", "deleted_at") VALUES (1, 2500000000, 'Example Bank', 8.4, '15 years', '2025-07-10 00:15:00', '2025-08-11 01:15:00', NULL);
INSERT INTO "loans" ("id", "amount_paise", "bank_name", "interest_rate", "tenure", "created_at", "updated_at", "deleted_at") VALUES (2, 50000000, 'Cooperative Society', 10.25, '3 years', '2025-08-11 01:15:00', '2025-01-12 02:15:00', '2025-02-13 03:15:00');
CREATE TABLE contract (id INTEGER PRIMARY KEY AUTOINCREMENT, contractor_name TEXT NOT NULL, area_of_work TEXT, ledger_code TEXT, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, amount_paise INTEGER, price_of_contract_paise INTEGER, date_signed TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
INSERT INTO "contract" ("id", "contractor_name", "area_of_work", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "amount_paise", "price_of_contract_paise", "date_signed", "created_at", "updated_at", "deleted_at") VALUES (1, 'Example Builders', 'Civil work', '4.0', '4.2', NULL, NULL, 900000000, 900000000, '2025-05-30', '2025-07-16 06:15:00', '2025-08-17 07:15:00', NULL);
INSERT INTO "contract" ("id", "contractor_name", "area_of_work", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "amount_paise", "price_of_contract_paise", "date_signed", "created_at", "updated_at", "deleted_at") VALUES (2, 'Old Painter', 'Painting', 'CUSTOM', NULL, 'Painting work', NULL, 4500000, NULL, '2025-04-01', '2025-08-17 07:15:00', '2025-01-18 08:15:00', '2025-02-19 09:15:00');
CREATE TABLE contract_payment_dates (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE, pay_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
INSERT INTO "contract_payment_dates" ("id", "contract_id", "pay_date", "created_at") VALUES (1, 1, '2025-07-01', '2025-04-11 01:15:00');
INSERT INTO "contract_payment_dates" ("id", "contract_id", "pay_date", "created_at") VALUES (2, 1, '2025-09-01', '2025-05-12 02:15:00');
INSERT INTO "contract_payment_dates" ("id", "contract_id", "pay_date", "created_at") VALUES (3, 1, '2025-11-01', '2025-06-13 03:15:00');
CREATE TABLE contractor_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contract(id), pay_date TEXT NOT NULL, amount_paise INTEGER NOT NULL, ledger_code TEXT, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, phase INTEGER, subpart TEXT, remarks TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (1, 1, '2025-07-02', 150000000, '22.0', '22.5', NULL, NULL, NULL, NULL, 'Advance — ₹1.5L', '2025-05-12 02:15:00', '2025-06-13 03:15:00', NULL);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (2, 1, '2025-09-03', 200000000, 'CUSTOM', NULL, 'Contractor extras', 'Stage 2', 2, 'b', 'Second stage', '2025-06-13 03:15:00', '2025-07-14 04:15:00', NULL);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (3, 1, '2025-09-04', 99, '22.0', '22.5', NULL, NULL, NULL, NULL, NULL, '2025-07-14 04:15:00', '2025-08-15 05:15:00', '2025-01-16 06:15:00');
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (4, 1, '2025-11-02', 250000000, '22.0', '22.5', NULL, NULL, 2, 'b', 'Roof slab', '2025-08-15 05:15:00', '2025-01-16 06:15:00', NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO "settings" ("key", "value") VALUES ('budget_paise', '5000000000');
INSERT INTO "settings" ("key", "value") VALUES ('backup_reminder_days', '14');
INSERT INTO "settings" ("key", "value") VALUES ('_migrated_ledger_taxonomy_v1', '1');
INSERT INTO "settings" ("key", "value") VALUES ('_service_price_drop_approved', '1');
CREATE TABLE cash_out (id INTEGER PRIMARY KEY AUTOINCREMENT, amount_paise INTEGER NOT NULL, by_type TEXT NOT NULL, by_user_id INTEGER REFERENCES users(id), by_label TEXT, ledger_code TEXT NOT NULL, subledger_code TEXT, ledger_custom_name TEXT, subledger_custom_name TEXT, reason TEXT, contract_scope TEXT NOT NULL, phase TEXT, subpart TEXT, phase_custom_name TEXT, subpart_custom_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT);
INSERT INTO "cash_out" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "phase", "subpart", "phase_custom_name", "subpart_custom_name", "created_at", "updated_at", "deleted_at") VALUES (1, 123456, 'user', 1, NULL, '4.0', '4.2', NULL, NULL, 'Stamp duty', 'extra', 'CUSTOM', 'CUSTOM', 'Plinth extra', 'Side wall', '2025-05-10 00:15:00', '2025-06-11 01:15:00', NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "phase", "subpart", "phase_custom_name", "subpart_custom_name", "created_at", "updated_at", "deleted_at") VALUES (2, 99, 'user', 2, NULL, '22.0', '22.5', NULL, NULL, 'Cement 50 bags', 'included', '2a', 'ab', NULL, NULL, '2025-06-11 01:15:00', '2025-07-12 02:15:00', NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "phase", "subpart", "phase_custom_name", "subpart_custom_name", "created_at", "updated_at", "deleted_at") VALUES (3, 4500000, 'custom', NULL, 'Mason', '5.0', NULL, NULL, NULL, 'Steel rods', 'extra', NULL, 'c', NULL, NULL, '2025-07-12 02:15:00', '2025-08-13 03:15:00', NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "phase", "subpart", "phase_custom_name", "subpart_custom_name", "created_at", "updated_at", "deleted_at") VALUES (4, 78000, 'user', 2, NULL, '4.0', '4.2', NULL, NULL, NULL, 'included', '1', 'B', NULL, NULL, '2025-08-13 03:15:00', '2025-01-14 04:15:00', NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "phase", "subpart", "phase_custom_name", "subpart_custom_name", "created_at", "updated_at", "deleted_at") VALUES (5, 250000, 'user', 1, NULL, 'CUSTOM', NULL, 'Pooja flowers', 'Marigold — गेंदा', 'Pooja', 'extra', '3', 'CUSTOM', NULL, 'Side wall', '2025-01-14 04:15:00', '2025-02-15 05:15:00', NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "phase", "subpart", "phase_custom_name", "subpart_custom_name", "created_at", "updated_at", "deleted_at") VALUES (6, 1000000, 'custom', NULL, 'Mason', '5.0', NULL, NULL, NULL, 'Sand load', 'included', 'CUSTOM', 'ab', 'Plinth extra', NULL, '2025-02-15 05:15:00', '2025-03-16 06:15:00', NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "phase", "subpart", "phase_custom_name", "subpart_custom_name", "created_at", "updated_at", "deleted_at") VALUES (7, 333, 'user', 1, NULL, '4.0', '4.2', NULL, NULL, 'Nails', 'extra', '2a', 'c', NULL, NULL, '2025-03-16 06:15:00', '2025-04-17 07:15:00', NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "phase", "subpart", "phase_custom_name", "subpart_custom_name", "created_at", "updated_at", "deleted_at") VALUES (8, 5600000, 'user', 2, NULL, '22.0', '22.5', NULL, NULL, 'Tiles', 'included', NULL, 'B', NULL, NULL, '2025-04-17 07:15:00', '2025-05-18 08:15:00', '2025-06-19 09:15:00');
INSERT INTO "cash_out" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "phase", "subpart", "phase_custom_name", "subpart_custom_name", "created_at", "updated_at", "deleted_at") VALUES (9, 120000, 'custom', NULL, 'Mason', '5.0', NULL, NULL, NULL, 'Paint', 'extra', '1', 'CUSTOM', NULL, 'Side wall', '2025-05-18 08:15:00', '2025-06-19 09:15:00', NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "phase", "subpart", "phase_custom_name", "subpart_custom_name", "created_at", "updated_at", "deleted_at") VALUES (10, 98000, 'user', 2, NULL, '4.0', '4.2', NULL, NULL, 'Transport', 'included', '3', 'ab', NULL, NULL, '2025-06-19 09:15:00', '2025-07-10 00:15:00', NULL);
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
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_contract_services_cid         ON contract_services(contract_id);
CREATE UNIQUE INDEX idx_ledger_customs_tenant_name ON ledger_customs(tenant_id, name);
CREATE UNIQUE INDEX idx_contract_single_live ON contract((1)) WHERE deleted_at IS NULL;
PRAGMA user_version = 0;
COMMIT;
