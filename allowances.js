// Plannr — seed data for the contract's ALLOWANCE CAPS (Contract Phase A).
//
// Same role, and the same reasoning, as ledgers.js: this file is SEED DATA ONLY. Nothing reads it
// at runtime. It exists so a contract can be offered the ten caps its written allowance schedule
// actually names, in one tap, instead of the owner retyping ten rows from the paper contract and
// getting a digit wrong. Once seeded, contract_allowances is the source of truth and these rows
// are editable/deletable like any other — a later contract, or an amended one, may have entirely
// different caps and this file is never consulted again.
//
// Opting in is EXPLICIT (POST /api/contracts/:id/allowances/defaults). A contract with no
// allowances is a perfectly normal contract; nothing here is created automatically.
//
// TWO KINDS OF CAP, because the contract has two kinds:
//   · kind 'lump'     — a rupee ceiling on a named item. capPaise is that ceiling.
//   · kind 'per_sqft' — a ceiling on the RATE, in rupees per square foot. capRatePerSqftPaise is
//                       that rate. It is NOT a rupee cap and does not become one until an area is
//                       supplied for it; until then the row shows its ceiling as a rate and no
//                       over/under position. Manufacturing an area to force a rupee figure out of
//                       it would be the same mistake that got contract_services.price_paise removed.
//
// Money is INTEGER PAISE here exactly as it is in the database (₹1 = 100 paise) — ₹35,000 is
// 3500000, never 35000.00.
export const DEFAULT_ALLOWANCES = [
  { name: 'Attached bathroom CP and sanitary', kind: 'lump', capPaise: 3500000 },   // ₹35,000
  { name: 'Common and outside bathrooms', kind: 'lump', capPaise: 1000000 },        // ₹10,000
  { name: 'Kitchen sink and wash area', kind: 'lump', capPaise: 1000000 },          // ₹10,000
  { name: 'Main entry steel door', kind: 'lump', capPaise: 5000000 },               // ₹50,000
  { name: 'Other exterior steel doors', kind: 'lump', capPaise: 2100000 },          // ₹21,000
  { name: 'Interior doors', kind: 'lump', capPaise: 1150000 },                      // ₹11,500
  { name: 'Stair handrail', kind: 'lump', capPaise: 2500000 },                      // ₹25,000
  { name: 'Flooring tiles', kind: 'per_sqft', capRatePerSqftPaise: 7500 },          // ₹75 / sq ft
  { name: 'Bathroom tiles', kind: 'per_sqft', capRatePerSqftPaise: 5000 },          // ₹50 / sq ft
  { name: 'Granite', kind: 'per_sqft', capRatePerSqftPaise: 15000 },                // ₹150 / sq ft
];
