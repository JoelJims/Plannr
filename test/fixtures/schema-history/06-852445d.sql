-- Plannr test database: the schema db.js built at commit 852445d (2026-08-24 Phase 10b: user-editable ledger taxonomy via CSV round trip),
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
INSERT INTO "users" ("id", "username", "display_name", "password_hash", "created_at") VALUES (1, 'owner', 'Owner', 'local-single-user-no-auth', '2026-11-17 13:36:17');
INSERT INTO "users" ("id", "username", "display_name", "password_hash", "created_at") VALUES (2, 'site-helper', 'Site helper (Ravi)', 'local-single-user-no-auth', '2025-02-11 01:15:00');
CREATE TABLE ledger_mains (
      code       TEXT PRIMARY KEY,
      name       TEXT    NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('1.0', 'LAND & LEGAL', 0, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('2.0', 'DESIGN & CONSULTANCY', 5, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('3.0', 'APPROVALS & STATUTORY FEES', 13, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('4.0', 'SITE PREPARATION', 20, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('5.0', 'TEMPORARY SITE SETUP', 28, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('6.0', 'MATERIALS — STRUCTURAL', 32, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('7.0', 'MATERIALS — MASONRY', 41, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.0', 'MATERIALS — DOORS, WINDOWS & JOINERY', 46, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.0', 'MATERIALS — ELECTRICAL', 59, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('10.0', 'MATERIALS — PLUMBING & SANITARY', 71, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.0', 'MATERIALS — FINISHES', 81, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.0', 'LABOUR — CIVIL & STRUCTURE', 95, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.0', 'LABOUR — FINISHING', 107, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('14.0', 'LABOUR — SERVICES', 118, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('15.0', 'KITCHEN', 125, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('16.0', 'INTERIORS & FURNISHING', 130, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('17.0', 'APPLIANCES', 137, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('18.0', 'EXTERIOR & COMPOUND', 141, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('19.0', 'LANDSCAPING & OUTDOOR', 150, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('20.0', 'UTILITY CONNECTIONS', 155, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('21.0', 'EQUIPMENT & TRANSPORT', 162, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('22.0', 'TAXES, FINANCE & INSURANCE', 167, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('23.0', 'POST-COMPLETION & HANDOVER', 176, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('24.0', 'CONTINGENCY & UNPLANNED', 182, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_mains" ("code", "name", "sort_order", "created_at", "updated_at") VALUES ('90', 'GARDEN & LANDSCAPING', 900, '2025-05-14 04:15:00', '2025-05-14 04:15:00');
CREATE TABLE ledger_subs (
      code       TEXT PRIMARY KEY,
      main_code  TEXT NOT NULL REFERENCES ledger_mains(code),
      name       TEXT    NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('1.1', '1.0', 'Land cost (renamed)', 1, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('1.2', '1.0', 'Registration & stamp duty', 2, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('1.3', '1.0', 'Site survey & utility location', 3, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('1.99', '1.0', 'Misc', 4, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('2.1', '2.0', 'Plan & elevation design', 6, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('2.2', '2.0', '3D design', 7, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('2.3', '2.0', 'Interior design', 8, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('2.4', '2.0', 'Structural engineer', 9, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('2.5', '2.0', 'Plan-completion', 10, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('2.6', '2.0', 'Soil test report', 11, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('2.99', '2.0', 'Misc', 12, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('3.1', '3.0', 'Building plan approval', 14, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('3.2', '3.0', 'Building permit fees', 15, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('3.3', '3.0', 'Impact fees', 16, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('3.4', '3.0', 'Completion / occupancy certificate', 17, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('3.5', '3.0', 'Property tax registration', 18, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('3.99', '3.0', 'Misc', 19, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('4.1', '4.0', 'Pre-construction cleaning', 21, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('4.2', '4.0', 'Demolition', 22, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('4.3', '4.0', 'Land levelling / earthwork', 23, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('4.4', '4.0', 'Excavation', 24, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('4.5', '4.0', 'Landfill — mud', 25, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('4.6', '4.0', 'Debris hauling', 26, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('4.99', '4.0', 'Misc', 27, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('5.1', '5.0', 'Site water supply', 29, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('5.2', '5.0', 'Site electricity supply', 30, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('5.99', '5.0', 'Misc', 31, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('6.1', '6.0', 'Cement', 33, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('6.2', '6.0', 'Steel rods (TMT)', 34, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('6.3', '6.0', 'M-Sand', 35, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('6.4', '6.0', 'P-Sand', 36, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('6.5', '6.0', 'Aggregate / jelly', 37, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('6.6', '6.0', 'Quarry powder', 38, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('6.7', '6.0', 'Boulders / rough rubble', 39, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('6.99', '6.0', 'Misc', 40, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('7.1', '7.0', 'Laterite stone', 42, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('7.2', '7.0', 'Bricks', 43, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('7.3', '7.0', 'Cement bricks / blocks', 44, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('7.99', '7.0', 'Misc', 45, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.1', '8.0', 'Main entry door', 47, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.2', '8.0', 'Exterior doors', 48, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.3', '8.0', 'Bedroom doors', 49, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.4', '8.0', 'Bathroom doors', 50, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.5', '8.0', 'Window frames', 51, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.6', '8.0', 'Ventilator frames', 52, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.7', '8.0', 'Window shutters & glass panes', 53, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.8', '8.0', 'Grills & MS fabrication', 54, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.9', '8.0', 'Hardware — hinges, locks, handles', 55, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.10', '8.0', 'Stair handrail', 56, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.11', '8.0', 'Wood / timber', 57, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('8.99', '8.0', 'Misc', 58, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.1', '9.0', 'Conduits / pipes', 60, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.2', '9.0', 'Wires & cables', 61, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.3', '9.0', 'Switches & regulators', 62, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.4', '9.0', 'Switchboards & metal boxes', 63, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.5', '9.0', 'Distribution board', 64, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.6', '9.0', 'MCB / ELCB', 65, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.7', '9.0', 'Light fixtures', 66, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.8', '9.0', 'Fans', 67, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.9', '9.0', 'Inverter / UPS', 68, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.10', '9.0', 'Solar panels', 69, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('9.99', '9.0', 'Misc', 70, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('10.1', '10.0', 'Pipes & fittings', 72, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('10.2', '10.0', 'CP fittings — taps, showers', 73, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('10.3', '10.0', 'Sanitary ware — WC, wash basin', 74, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('10.4', '10.0', 'Geyser', 75, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('10.5', '10.0', 'Kitchen sink & wash counter', 76, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('10.6', '10.0', 'Water storage tank', 77, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('10.7', '10.0', 'Sump', 78, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('10.8', '10.0', 'Septic tank & sewage rings', 79, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('10.99', '10.0', 'Misc', 80, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.1', '11.0', 'Flooring tiles', 82, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.2', '11.0', 'Bathroom tiles', 83, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.3', '11.0', 'Ceramic tiles — work area', 84, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.4', '11.0', 'Granite', 85, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.5', '11.0', 'Paint — exterior', 86, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.6', '11.0', 'Paint — interior', 87, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.7', '11.0', 'Enamel & epoxy primer', 88, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.8', '11.0', 'Putty', 89, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.9', '11.0', 'Primer', 90, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.10', '11.0', 'White cement', 91, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.11', '11.0', 'Waterproofing materials', 92, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.12', '11.0', 'Epoxy grouting', 93, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('11.99', '11.0', 'Misc', 94, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.1', '12.0', 'Material unloading', 96, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.2', '12.0', 'Foundation', 97, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.3', '12.0', 'Plinth work', 98, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.4', '12.0', 'Plinth filling', 99, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.5', '12.0', 'Masonry / brick work', 100, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.6', '12.0', 'Lintel & sunshade', 101, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.7', '12.0', 'RCC / concreting', 102, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.8', '12.0', 'Roof concrete', 103, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.9', '12.0', 'Floor PCC', 104, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.10', '12.0', 'Parapet', 105, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('12.99', '12.0', 'Misc', 106, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.1', '13.0', 'Plastering', 108, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.2', '13.0', 'White cement coating', 109, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.3', '13.0', 'Painting', 110, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.4', '13.0', 'Tiling & flooring', 111, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.5', '13.0', 'Granite fixing', 112, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.6', '13.0', 'Carpenter / joinery', 113, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.7', '13.0', 'Waterproofing', 114, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.8', '13.0', 'False ceiling', 115, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.9', '13.0', 'MS fabrication', 116, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('13.99', '13.0', 'Misc', 117, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('14.1', '14.0', 'Electrical — conduiting', 119, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('14.2', '14.0', 'Electrical — wiring & fixing', 120, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('14.3', '14.0', 'Plumbing — rough-in', 121, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('14.4', '14.0', 'Plumbing — fixture fitting', 122, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('14.5', '14.0', 'Pest control', 123, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('14.99', '14.0', 'Misc', 124, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('15.1', '15.0', 'Countertop / platform', 126, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('15.2', '15.0', 'Modular cabinets', 127, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('15.3', '15.0', 'Chimney / exhaust', 128, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('15.99', '15.0', 'Misc', 129, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('16.1', '16.0', 'Furniture', 131, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('16.2', '16.0', 'Wardrobes', 132, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('16.3', '16.0', 'Curtains & blinds', 133, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('16.4', '16.0', 'False ceiling materials', 134, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('16.5', '16.0', 'Glass works', 135, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('16.99', '16.0', 'Misc', 136, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('17.1', '17.0', 'Appliances — fridge, washing machine, AC', 138, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('17.2', '17.0', 'Water purifier', 139, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('17.99', '17.0', 'Misc', 140, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('18.1', '18.0', 'Compound wall', 142, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('18.2', '18.0', 'Gate', 143, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('18.3', '18.0', 'Car porch / parking', 144, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('18.4', '18.0', 'Exterior cladding', 145, '2026-11-17 13:36:17', '2026-11-17 13:36:17');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('18.5', '18.0', 'Roof tiling / shingles', 146, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('18.6', '18.0', 'Truss work', 147, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('18.7', '18.0', 'Roads, walks & paving', 148, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('18.99', '18.0', 'Misc', 149, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('19.1', '19.0', 'Landscaping / garden', 151, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('19.2', '19.0', 'Outdoor lighting', 152, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('19.3', '19.0', 'Rainwater harvesting', 153, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('19.99', '19.0', 'Misc', 154, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('20.1', '20.0', 'Electricity connection (KSEB)', 156, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('20.2', '20.0', 'Water connection', 157, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('20.3', '20.0', 'LPG / gas connection', 158, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('20.4', '20.0', 'Internet / cable wiring', 159, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('20.5', '20.0', 'Off-site utility connections', 160, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('20.99', '20.0', 'Misc', 161, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('21.1', '21.0', 'Equipment rental — mixer, JCB', 163, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('21.2', '21.0', 'Scaffolding', 164, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('21.3', '21.0', 'Material transport', 165, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('21.99', '21.0', 'Misc', 166, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('22.1', '22.0', 'GST on contractor billing', 168, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('22.2', '22.0', 'Other taxes & duties', 169, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('22.3', '22.0', 'Loan processing fees', 170, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('22.4', '22.0', 'Loan estimation fees', 171, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('22.5', '22.0', 'Loan interest', 172, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('22.6', '22.0', 'Property / structure insurance', 173, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('22.7', '22.0', 'Owner liability insurance', 174, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('22.99', '22.0', 'Misc', 175, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('23.1', '23.0', 'Post-construction cleaning', 177, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('23.2', '23.0', 'Debris & scaffolding clearing', 178, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('23.3', '23.0', 'Hazardous waste disposal', 179, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('23.4', '23.0', 'Plastic waste — Harithakarmasena', 180, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('23.99', '23.0', 'Misc', 181, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('24.1', '24.0', 'Contingency fund', 183, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('24.2', '24.0', 'Foundation depth beyond 2.5 ft', 184, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('24.3', '24.0', 'Plinth height beyond 1.5 ft', 185, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('24.99', '24.0', 'Misc', 186, '2026-11-17 13:36:18', '2026-11-17 13:36:18');
INSERT INTO "ledger_subs" ("code", "main_code", "name", "sort_order", "created_at", "updated_at") VALUES ('90.1', '90', 'Lawn & turf', 1, '2025-05-14 04:15:00', '2025-06-15 05:15:00');
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
INSERT INTO "contract" ("id", "contractor_name", "area_of_work", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "amount_paise", "price_of_contract_paise", "contract_end_date", "date_signed", "created_at", "updated_at", "deleted_at", "company") VALUES (1, 'Example Builders', 'Civil work', '1.0', '1.1', NULL, NULL, 900000000, 900000000, '2026-12-31', '2025-05-30', '2025-07-16 06:15:00', '2025-08-17 07:15:00', NULL, 'Example Builders Pvt Ltd');
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
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (1, 1, '2025-07-02', 150000000, '2.0', '2.3', NULL, NULL, NULL, NULL, 'Advance — ₹1.5L', '2025-05-12 02:15:00', '2025-06-13 03:15:00', NULL);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (2, 1, '2025-09-03', 200000000, 'CUSTOM', NULL, 'Contractor extras', 'Stage 2', 2, 'b', 'Second stage', '2025-06-13 03:15:00', '2025-07-14 04:15:00', NULL);
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (3, 1, '2025-09-04', 99, '2.0', '2.3', NULL, NULL, NULL, NULL, NULL, '2025-07-14 04:15:00', '2025-08-15 05:15:00', '2025-01-16 06:15:00');
INSERT INTO "contractor_payments" ("id", "contract_id", "pay_date", "amount_paise", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "phase", "subpart", "remarks", "created_at", "updated_at", "deleted_at") VALUES (4, 1, '2025-11-02', 250000000, '2.0', '2.3', NULL, NULL, 2, 'b', 'Roof slab', '2025-08-15 05:15:00', '2025-01-16 06:15:00', NULL);
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
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (1, 123456, '2025-07-10', 'user', 1, NULL, '1.0', '1.1', NULL, NULL, 'Stamp duty', 'extra', NULL, NULL, NULL, '2025-05-10 00:15:00', '2025-06-11 01:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (2, 99, '2025-07-11', 'user', 2, NULL, '2.0', '2.3', NULL, NULL, 'Cement 50 bags', 'included', 98, 2, 'b', '2025-06-11 01:15:00', '2025-07-12 02:15:00', NULL, 1);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (3, 4500000, '2025-07-12', 'custom', NULL, 'Mason', '4.0', NULL, NULL, NULL, 'Steel rods', 'extra', NULL, NULL, NULL, '2025-07-12 02:15:00', '2025-08-13 03:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (4, 78000, '2025-07-13', 'user', 2, NULL, '90', '90.1', NULL, NULL, NULL, 'included', NULL, NULL, NULL, '2025-08-13 03:15:00', '2025-01-14 04:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (5, 250000, '2025-07-14', 'user', 1, NULL, 'CUSTOM', NULL, 'Pooja flowers', 'Marigold — गेंदा', 'Pooja', 'extra', NULL, NULL, NULL, '2025-01-14 04:15:00', '2025-02-15 05:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (6, 1000000, '2025-07-15', 'custom', NULL, 'Mason', '2.0', '2.3', NULL, NULL, 'Sand load', 'included', NULL, 2, 'b', '2025-02-15 05:15:00', '2025-03-16 06:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (7, 333, '2025-07-16', 'user', 1, NULL, '4.0', NULL, NULL, NULL, 'Nails', 'extra', NULL, NULL, NULL, '2025-03-16 06:15:00', '2025-04-17 07:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (8, 5600000, '2025-07-17', 'user', 2, NULL, '90', '90.1', NULL, NULL, 'Tiles', 'included', NULL, NULL, NULL, '2025-04-17 07:15:00', '2025-05-18 08:15:00', '2025-06-19 09:15:00', NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (9, 120000, '2025-07-18', 'custom', NULL, 'Mason', '1.0', '1.1', NULL, NULL, 'Paint', 'extra', NULL, NULL, NULL, '2025-05-18 08:15:00', '2025-06-19 09:15:00', NULL, NULL);
INSERT INTO "cash_out" ("id", "amount_paise", "tx_date", "by_type", "by_user_id", "by_label", "ledger_code", "subledger_code", "ledger_custom_name", "subledger_custom_name", "reason", "contract_scope", "contract_stated_paise", "phase", "subpart", "created_at", "updated_at", "deleted_at", "contract_service_id") VALUES (10, 98000, NULL, 'user', 2, NULL, '2.0', '2.3', NULL, NULL, 'Transport', 'included', NULL, 2, 'b', '2025-06-19 09:15:00', '2025-07-10 00:15:00', NULL, NULL);
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
CREATE INDEX idx_ledger_subs_main_code ON ledger_subs(main_code);
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
