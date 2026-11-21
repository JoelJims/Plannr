-- Made by make-legacy-shapes.js from 01-7cfcf89.sql. MADE-UP data, made-up older shape:
-- user_version 1 with tenant_id everywhere (fixture 01 as it is) plus a second household: the second user owns a copy of one row in each tenant table except contract_payment_dates (its own live contract) and two settings rows, one under a key the first household also has. The Step 2a collapse keeps only the first household's rows
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
CREATE TABLE contract (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      contractor_name         TEXT,
      area_of_work            TEXT,             -- Phase 2: required on new writes
      ledger_code             TEXT,             -- headline category: fixed code (e.g. '5.0'), 'CUSTOM', or NULL
      subledger_code          TEXT,             -- fixed sub code, 'CUSTOM', or NULL (none)
      ledger_custom_name      TEXT,             -- typed ledger name when ledger_code = 'CUSTOM'
      subledger_custom_name   TEXT,             -- typed sub-ledger name when subledger_code = 'CUSTOM'
      amount_paise            INTEGER,          -- OPTIONAL free-form amount, paise (₹1=100) or NULL
      price_of_contract_paise INTEGER,          -- REQUIRED stated amount, paise (dues math starts here)
      contract_end_date       TEXT,             -- OPTIONAL 'date ends', ISO 'YYYY-MM-DD' or NULL
      date_signed             TEXT,             -- Phase 2: required, ISO 'YYYY-MM-DD'
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at              TEXT,             -- soft-delete: NULL = live
      tenant_id               INTEGER NOT NULL REFERENCES users(id), -- Tenancy Phase 2: owning household (a users.id)
      company                 TEXT              -- Services phase (Part F): OPTIONAL company/firm; presentation only, never in dues math
    );
INSERT INTO "contract" ("id", "contractor_name", "area_of_work", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "amount_paise", "price_of_contract_paise", "contract_end_date", "date_signed", "created_at", "updated_at", "deleted_at", "tenant_id", "company") VALUES (1, 'Example Builders', 'Civil work', '4.0', '4.2', NULL, NULL, 900000000, 900000000, '2026-12-31', '2025-05-30', '2025-07-16 06:15:00', '2025-08-17 07:15:00', NULL, 1, 'Example Builders Pvt Ltd');
INSERT INTO "contract" ("id", "contractor_name", "area_of_work", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "amount_paise", "price_of_contract_paise", "contract_end_date", "date_signed", "created_at", "updated_at", "deleted_at", "tenant_id", "company") VALUES (2, 'Old Painter', 'Painting', 'CUSTOM', NULL, 'Painting work', NULL, 4500000, NULL, NULL, '2025-04-01', '2025-08-17 07:15:00', '2025-01-18 08:15:00', '2025-02-19 09:15:00', 1, NULL);
INSERT INTO "contract" ("id", "contractor_name", "area_of_work", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "amount_paise", "price_of_contract_paise", "contract_end_date", "date_signed", "created_at", "updated_at", "deleted_at", "tenant_id", "company") VALUES (3, 'Example Builders', 'Civil work', '4.0', '4.2', NULL, NULL, 900000000, 900000000, '2026-12-31', '2025-05-30', '2025-07-16 06:15:00', '2025-08-17 07:15:00', NULL, 2, 'Example Builders Pvt Ltd');
CREATE TABLE contract_payment_dates (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
      pay_date    TEXT    NOT NULL,             -- ISO 'YYYY-MM-DD' scheduled payment date
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      tenant_id   INTEGER NOT NULL REFERENCES users(id) -- Tenancy Phase 2: owning household (mirrors the parent contract's tenant)
    );
INSERT INTO "contract_payment_dates" ("id", "contract_id", "pay_date", "created_at", "tenant_id") VALUES (1, 1, '2025-07-01', '2025-04-11 01:15:00', 1);
INSERT INTO "contract_payment_dates" ("id", "contract_id", "pay_date", "created_at", "tenant_id") VALUES (2, 1, '2025-09-01', '2025-05-12 02:15:00', 1);
INSERT INTO "contract_payment_dates" ("id", "contract_id", "pay_date", "created_at", "tenant_id") VALUES (3, 1, '2025-11-01', '2025-06-13 03:15:00', 1);
CREATE TABLE contractor_payments (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id           INTEGER NOT NULL REFERENCES contract(id), -- required parent contract
      pay_date              TEXT    NOT NULL,   -- ISO 'YYYY-MM-DD' date of payment
      amount_paise          INTEGER NOT NULL,   -- paise (₹1=100); amount paid, > 0
      ledger_code           TEXT,               -- OPTIONAL tag: fixed code, 'CUSTOM', or NULL
      subledger_code        TEXT,               -- fixed sub code, 'CUSTOM', or NULL
      ledger_custom_name    TEXT,               -- typed ledger name when ledger_code = 'CUSTOM'
      subledger_custom_name TEXT,               -- typed sub name when subledger_code = 'CUSTOM'
      phase                 INTEGER,            -- OPTIONAL positive whole number (>=1)
      subpart               TEXT,               -- OPTIONAL single lowercase letter a-z
      remarks               TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at            TEXT,               -- soft-delete: NULL = live
      tenant_id             INTEGER NOT NULL REFERENCES users(id) -- Tenancy Phase 2: owning household (a users.id)
    );
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (1, 1, '2025-07-02', 150000000, '22.0', '22.5', NULL, NULL, NULL, NULL, 'Advance — ₹1.5L', '2025-05-12 02:15:00', '2025-06-13 03:15:00', NULL, 1);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (2, 1, '2025-09-03', 200000000, 'CUSTOM', NULL, 'Contractor extras', 'Stage 2', 2, 'b', 'Second stage', '2025-06-13 03:15:00', '2025-07-14 04:15:00', NULL, 1);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (3, 1, '2025-09-04', 99, '22.0', '22.5', NULL, NULL, NULL, NULL, NULL, '2025-07-14 04:15:00', '2025-08-15 05:15:00', '2025-01-16 06:15:00', 1);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (4, 1, '2025-11-02', 250000000, '22.0', '22.5', NULL, NULL, 2, 'b', 'Roof slab', '2025-08-15 05:15:00', '2025-01-16 06:15:00', NULL, 1);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (5, 1, '2025-07-02', 150000000, '22.0', '22.5', NULL, NULL, NULL, NULL, 'Advance — ₹1.5L', '2025-05-12 02:15:00', '2025-06-13 03:15:00', NULL, 2);
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
INSERT INTO "contract_services" ("id", "contract_id", "name", "price_paise", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (4, 1, 'Excavation', 1500000, '2025-01-18 08:15:00', '2025-02-19 09:15:00', NULL, 2);
CREATE TABLE cash_in (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise INTEGER NOT NULL,            -- paise (₹1=100)
      tx_date      TEXT,                         -- Phase 4C: user-chosen inflow date, ISO 'YYYY-MM-DD' (mirrors cash_out.tx_date; required on new writes)
      by_type      TEXT    NOT NULL,            -- 'user' | 'relative' | 'custom'
      by_user_id   INTEGER REFERENCES users(id),-- set when by_type='user'
      by_label     TEXT,                        -- custom/relative display text when not a user
      reason       TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at   TEXT,                        -- soft-delete: NULL = live
      tenant_id    INTEGER NOT NULL REFERENCES users(id) -- Tenancy Phase 2: owning household (a users.id)
    );
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (1, 50000000, '2025-06-01', 'user', 1, NULL, 'Savings', '2025-07-14 04:15:00', '2025-08-15 05:15:00', NULL, 1);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (2, 25000000, '2025-06-02', 'user', 2, NULL, 'Salary', '2025-08-15 05:15:00', '2025-01-16 06:15:00', NULL, 1);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (3, 1234500, '2025-06-03', 'relative', NULL, 'Father', 'Family contribution', '2025-01-16 06:15:00', '2025-02-17 07:15:00', NULL, 1);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (4, 99, '2025-06-04', 'relative', NULL, 'Brother — भाई', NULL, '2025-02-17 07:15:00', '2025-03-18 08:15:00', '2025-04-19 09:15:00', 1);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (5, 300000000, '2025-06-05', 'user', 1, NULL, 'Loan disbursement', '2025-03-18 08:15:00', '2025-04-19 09:15:00', NULL, 1);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (6, 7500000, '2025-06-06', 'relative', NULL, 'Relative', 'Gift', '2025-04-19 09:15:00', '2025-05-10 00:15:00', NULL, 1);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (37, 50000000, '2025-06-01', 'user', 1, NULL, 'Savings', '2025-07-14 04:15:00', '2025-08-15 05:15:00', NULL, 2);
INSERT INTO "cash_in" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "reason", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (38, 50000000, '2025-06-01', 'user', 1, NULL, 'Savings', '2025-07-14 04:15:00', '2025-08-15 05:15:00', NULL, 2);
CREATE TABLE cash_out (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise        INTEGER NOT NULL,      -- paise (₹1=100); actual amount spent
      tx_date             TEXT,                  -- user-chosen transaction date, ISO 'YYYY-MM-DD' (required on new writes; see Phase 1)
      by_type             TEXT    NOT NULL,      -- 'user' | 'custom' (legacy 'contractor' possible but NO LONGER WRITTEN; verified 0 in the live DB — all 11 rows are 'user')
      by_user_id          INTEGER REFERENCES users(id),
      by_label            TEXT,
      ledger_code         TEXT    NOT NULL,      -- e.g. '4.2' (fixed 23-ledger list), or 'CUSTOM'
      subledger_code      TEXT,                  -- fixed sub code, 'CUSTOM', or NULL (none)
      ledger_custom_name    TEXT,                -- typed ledger name when ledger_code = 'CUSTOM'
      subledger_custom_name TEXT,                -- typed sub-ledger name when subledger_code = 'CUSTOM'
      reason              TEXT,
      contract_scope      TEXT    NOT NULL,      -- 'included' | 'extra'
      contract_stated_paise INTEGER,             -- Phase 5E (Option C): when contract_scope='included',
                                                 -- the contract's STATED amount for this item (paise) — the
                                                 -- reimbursement offset against dues. NULL when 'extra'.
      phase               INTEGER,               -- OPTIONAL: a positive whole number (>=1), or NULL
      subpart             TEXT,                  -- OPTIONAL: a single lowercase letter a-z, or NULL
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at          TEXT,                  -- soft-delete: NULL = live
      tenant_id           INTEGER NOT NULL REFERENCES users(id), -- Tenancy Phase 2: owning household (a users.id)
      -- Services phase (Part C/D): the contract_services row this debit's contract_stated_paise was
      -- sourced from — provenance, and the key for the ONE-SERVICE-ONE-OFFSET guard. NULL when the
      -- debit is 'extra' or the stated amount was typed manually. A partial UNIQUE index
      -- (idx_cash_out_service_live, WHERE deleted_at IS NULL) enforces that at most one LIVE debit
      -- links any given service, so a single substitution can never offset dues twice.
      contract_service_id INTEGER REFERENCES contract_services(id)
    );
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (1, 123456, '2025-07-10', 'user', 1, NULL, '4.0', '4.2', NULL, NULL, 'Stamp duty', 'extra', NULL, NULL, NULL, '2025-05-10 00:15:00', '2025-06-11 01:15:00', NULL, 1, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (2, 99, '2025-07-11', 'user', 2, NULL, '22.0', '22.5', NULL, NULL, 'Cement 50 bags', 'included', 98, 2, 'b', '2025-06-11 01:15:00', '2025-07-12 02:15:00', NULL, 1, 1);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (3, 4500000, '2025-07-12', 'custom', NULL, 'Mason', '5.0', NULL, NULL, NULL, 'Steel rods', 'extra', NULL, NULL, NULL, '2025-07-12 02:15:00', '2025-08-13 03:15:00', NULL, 1, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (4, 78000, '2025-07-13', 'user', 2, NULL, '4.0', '4.2', NULL, NULL, NULL, 'included', NULL, NULL, NULL, '2025-08-13 03:15:00', '2025-01-14 04:15:00', NULL, 1, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (5, 250000, '2025-07-14', 'user', 1, NULL, 'CUSTOM', NULL, 'Pooja flowers', 'Marigold — गेंदा', 'Pooja', 'extra', NULL, NULL, NULL, '2025-01-14 04:15:00', '2025-02-15 05:15:00', NULL, 1, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (6, 1000000, '2025-07-15', 'custom', NULL, 'Mason', '5.0', NULL, NULL, NULL, 'Sand load', 'included', NULL, 2, 'b', '2025-02-15 05:15:00', '2025-03-16 06:15:00', NULL, 1, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (7, 333, '2025-07-16', 'user', 1, NULL, '4.0', '4.2', NULL, NULL, 'Nails', 'extra', NULL, NULL, NULL, '2025-03-16 06:15:00', '2025-04-17 07:15:00', NULL, 1, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (8, 5600000, '2025-07-17', 'user', 2, NULL, '22.0', '22.5', NULL, NULL, 'Tiles', 'included', NULL, NULL, NULL, '2025-04-17 07:15:00', '2025-05-18 08:15:00', '2025-06-19 09:15:00', 1, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (9, 120000, '2025-07-18', 'custom', NULL, 'Mason', '5.0', NULL, NULL, NULL, 'Paint', 'extra', NULL, NULL, NULL, '2025-05-18 08:15:00', '2025-06-19 09:15:00', NULL, 1, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (10, 98000, NULL, 'user', 2, NULL, '4.0', '4.2', NULL, NULL, 'Transport', 'included', NULL, 2, 'b', '2025-06-19 09:15:00', '2025-07-10 00:15:00', NULL, 1, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "tenant_id", "contract_service_id") VALUES (41, 123456, '2025-07-10', 'user', 1, NULL, '4.0', '4.2', NULL, NULL, 'Stamp duty', 'extra', NULL, NULL, NULL, '2025-05-10 00:15:00', '2025-06-11 01:15:00', NULL, 2, NULL);
CREATE TABLE loans (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_paise  INTEGER,                     -- paise (₹1=100)
      bank_name     TEXT,
      interest_rate REAL,                        -- annual percentage rate (a rate, not money); informational
      tenure        TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at    TEXT,                        -- soft-delete: NULL = live
      tenant_id     INTEGER NOT NULL REFERENCES users(id) -- Tenancy Phase 2: owning household (a users.id)
    );
INSERT INTO "loans" ("id", "amount_paise", "bank_name", "interest_rate", "tenure", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (1, 2500000000, 'Example Bank', 8.4, '15 years', '2025-07-10 00:15:00', '2025-08-11 01:15:00', NULL, 1);
INSERT INTO "loans" ("id", "amount_paise", "bank_name", "interest_rate", "tenure", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (2, 50000000, 'Cooperative Society', 10.25, '3 years', '2025-08-11 01:15:00', '2025-01-12 02:15:00', '2025-02-13 03:15:00', 1);
INSERT INTO "loans" ("id", "amount_paise", "bank_name", "interest_rate", "tenure", "created_at", "updated_at", "deleted_at", "tenant_id") VALUES (3, 2500000000, 'Example Bank', 8.4, '15 years', '2025-07-10 00:15:00', '2025-08-11 01:15:00', NULL, 2);
CREATE TABLE settings (
      -- Per-tenant key/value via a COMPOSITE primary key. tenant_id is a scoping integer (a users.id;
      -- 0 is RESERVED for global, non-account rows). Deliberately NO foreign key: settings is a config
      -- store; the global sentinel (0) has no user row, and a setting must survive account deletion
      -- without an orphan-FK error. COMPOSITE key rather than NAMESPACED keys so a value can still be
      -- read by key ALONE (WHERE key = ?) with no tenant filter; namespacing would bury the tenant
      -- inside the key and force every read to become tenant-aware. Writes UPSERT on (tenant_id, key).
      tenant_id INTEGER NOT NULL,
      key       TEXT    NOT NULL,
      value     TEXT,
      PRIMARY KEY (tenant_id, key)
    );
INSERT INTO "settings" ("tenant_id", "key", "value") VALUES (1, 'budget_paise', '5000000000');
INSERT INTO "settings" ("tenant_id", "key", "value") VALUES (1, 'backup_reminder_days', '14');
INSERT INTO "settings" ("tenant_id", "key", "value") VALUES (2, 'backup_reminder_days', 'second household');
INSERT INTO "settings" ("tenant_id", "key", "value") VALUES (2, 'second_household_only', '1');
CREATE TABLE ledger_customs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  INTEGER NOT NULL REFERENCES users(id), -- the owning user (per-user list)
      name       TEXT    NOT NULL,                       -- the custom ledger name
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
INSERT INTO "ledger_customs" ("id", "tenant_id", "name", "created_at") VALUES (1, 1, 'Temple donation for bhoomi pooja', '2025-06-15 05:15:00');
INSERT INTO "ledger_customs" ("id", "tenant_id", "name", "created_at") VALUES (4, 1, 'Neighbour wall repair — गेट', '2025-07-16 06:15:00');
INSERT INTO "ledger_customs" ("id", "tenant_id", "name", "created_at") VALUES (5, 2, 'Second household custom', '2025-06-15 05:15:00');
CREATE TABLE edit_locks (
      scope               TEXT PRIMARY KEY,
      holder_user_id      INTEGER,
      holder_display_name TEXT,
      acquired_at         TEXT,
      last_heartbeat_at   TEXT
    );
INSERT INTO "edit_locks" ("scope", "holder_user_id", "holder_display_name", "acquired_at", "last_heartbeat_at") VALUES ('ledger', 1, 'Owner', '2025-04-13 03:15:00', '2025-04-13 03:15:00');
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence (name, seq) VALUES ('cash_in', 38);
INSERT INTO sqlite_sequence (name, seq) VALUES ('cash_out', 41);
INSERT INTO sqlite_sequence (name, seq) VALUES ('contract', 3);
INSERT INTO sqlite_sequence (name, seq) VALUES ('contract_payment_dates', 3);
INSERT INTO sqlite_sequence (name, seq) VALUES ('contract_services', 4);
INSERT INTO sqlite_sequence (name, seq) VALUES ('contractor_payments', 5);
INSERT INTO sqlite_sequence (name, seq) VALUES ('ledger_customs', 5);
INSERT INTO sqlite_sequence (name, seq) VALUES ('loans', 3);
INSERT INTO sqlite_sequence (name, seq) VALUES ('users', 2);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_cash_out_ledger_code         ON cash_out(ledger_code);
CREATE INDEX idx_cash_in_by_user_id           ON cash_in(by_user_id);
CREATE INDEX idx_contract_payment_dates_cid   ON contract_payment_dates(contract_id);
CREATE INDEX idx_contractor_payments_cid      ON contractor_payments(contract_id);
CREATE INDEX idx_contract_services_cid         ON contract_services(contract_id);
CREATE UNIQUE INDEX idx_ledger_customs_tenant_name ON ledger_customs(tenant_id, name);
CREATE UNIQUE INDEX idx_contract_single_live_tenant ON contract(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_cash_out_txdate_live ON cash_out(tx_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_contractor_payments_paydate_live ON contractor_payments(pay_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_cash_out_amount_live ON cash_out(amount_paise) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_cash_out_service_live ON cash_out(contract_service_id) WHERE contract_service_id IS NOT NULL AND deleted_at IS NULL;
PRAGMA user_version = 1;
COMMIT;
