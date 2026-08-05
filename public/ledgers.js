// Plannr — the fixed 23-ledger reference list (Phase A).
//
// This is a FIXED reference taxonomy, NOT an editable table. It maps a
// cash_out.ledger_code / subledger_code (e.g. "4.2") to a human-readable
// category name. Single source of truth, usable by BOTH sides:
//   • server:  const { LEDGERS } = require('./public/ledgers.js');
//   • browser: <script src="/ledgers.js"></script>  ->  window.LEDGERS
//
// NOTE: loan INTEREST is recorded under 20.0 (Taxes & Finance Charges) as an ordinary cash_out row —
// sub-ledger 20.3 (Loan interest) — so real money paid on a construction loan is counted in total
// spend rather than being structurally invisible. It is NOT double-counted: `loans.interest_rate` is
// informational only and drives no calculation anywhere, so there is no derived interest figure for a
// ledger line to duplicate. 20.0 also holds 20.1 (Loan processing fees) and 20.2 (GST on contractor
// billing). Interest is never part of a contract, so it is always logged out-of-contract ('extra').
//
// Shape: [{ code, name, subLedgers: [{ code, name }, ...] }, ...]
(function (root) {
  const LEDGERS = [
    { code: '1.0', name: 'LAND & LEGAL', subLedgers: [
      { code: '1.1', name: 'Land cost (if not already owned)' },
      { code: '1.2', name: 'Land registration & stamp duty' },
    ] },
    { code: '2.0', name: 'DESIGN & STATUTORY APPROVALS', subLedgers: [
      { code: '2.1', name: 'Architect / design fees' },
      { code: '2.2', name: 'Structural engineer fees' },
      { code: '2.3', name: 'Building plan approval (Panchayat/Municipality/Corporation)' },
      { code: '2.4', name: 'Building permit fees' },
    ] },
    { code: '3.0', name: 'SITE PREPARATION', subLedgers: [
      { code: '3.1', name: 'Demolition of existing structure (if applicable)' },
      { code: '3.2', name: 'Land leveling / earthwork' },
      { code: '3.3', name: 'Excavation' },
    ] },
    { code: '4.0', name: 'STRUCTURAL RAW MATERIALS', subLedgers: [
      { code: '4.1', name: 'Steel (TMT bars)' },
      { code: '4.2', name: 'Cement' },
      { code: '4.3', name: 'Sand' },
      { code: '4.4', name: 'Aggregate/jelly' },
      { code: '4.5', name: 'Laterite stone / bricks / blocks' },
    ] },
    { code: '5.0', name: 'STRUCTURAL WORK (RCC)', subLedgers: [
      { code: '5.1', name: 'Foundation work (PCC, footing)' },
      { code: '5.2', name: 'RCC (columns, beams, slab)' },
    ] },
    { code: '6.0', name: 'ROOFING', subLedgers: [
      { code: '6.1', name: 'Roof slab or sloped roof structure' },
    ] },
    { code: '7.0', name: 'WATERPROOFING', subLedgers: [
      { code: '7.1', name: 'Roof waterproofing' },
      { code: '7.2', name: 'Bathroom waterproofing' },
    ] },
    { code: '8.0', name: 'PLUMBING WORKS', subLedgers: [
      { code: '8.1', name: 'Pipes and fittings (rough-in)' },
      { code: '8.2', name: 'Bathroom fittings (taps, shower, geyser, wash basin, WC)' },
    ] },
    { code: '9.0', name: 'ELECTRICAL WORKS', subLedgers: [
      { code: '9.1', name: 'Electrical conduits and wiring (rough-in)' },
      { code: '9.2', name: 'Switches, sockets, switchboards' },
      { code: '9.3', name: 'Light fixtures' },
      { code: '9.4', name: 'Fans' },
      { code: '9.5', name: 'MCB/distribution board' },
      { code: '9.6', name: 'Inverter/UPS' },
      { code: '9.7', name: 'Solar panels (if opting in)' },
    ] },
    { code: '10.0', name: 'INTERIOR FINISHING', subLedgers: [
      { code: '10.1', name: 'Plastering (interior & exterior)' },
      { code: '10.2', name: 'Putty & primer' },
      { code: '10.3', name: 'Painting (interior & exterior)' },
      { code: '10.4', name: 'False ceiling (if wanted)' },
    ] },
    { code: '11.0', name: 'FLOORING', subLedgers: [
      { code: '11.1', name: 'Flooring (tiles/granite/marble/vitrified)' },
      { code: '11.2', name: 'Bathroom tiles' },
    ] },
    { code: '12.0', name: 'DOORS, WINDOWS & HARDWARE', subLedgers: [
      { code: '12.1', name: 'Doors (frames + shutters)' },
      { code: '12.2', name: 'Windows (frames + glass/grills)' },
      { code: '12.3', name: 'Hardware (hinges, locks, handles)' },
    ] },
    { code: '13.0', name: 'KITCHEN', subLedgers: [
      { code: '13.1', name: 'Kitchen platform/countertop' },
      { code: '13.2', name: 'Modular kitchen / cabinets' },
      { code: '13.3', name: 'Kitchen chimney/exhaust' },
    ] },
    { code: '14.0', name: 'COMPOUND & EXTERIOR STRUCTURES', subLedgers: [
      { code: '14.1', name: 'Compound wall' },
      { code: '14.2', name: 'Gate' },
      { code: '14.3', name: 'Car porch/parking' },
    ] },
    { code: '15.0', name: 'SITE DEVELOPMENT', subLedgers: [
      { code: '15.1', name: 'Landscaping/garden' },
      { code: '15.2', name: 'Outdoor lighting' },
    ] },
    { code: '16.0', name: 'WATER & SANITATION SYSTEMS', subLedgers: [
      { code: '16.1', name: 'Sump + overhead tank' },
      { code: '16.2', name: 'Rainwater harvesting system' },
      { code: '16.3', name: 'Septic tank / sewage system' },
    ] },
    { code: '17.0', name: 'UTILITY CONNECTIONS', subLedgers: [
      { code: '17.1', name: 'Electricity connection (KSEB)' },
      { code: '17.2', name: 'Water connection (municipal/panchayat)' },
      { code: '17.3', name: 'LPG/gas connection' },
      { code: '17.4', name: 'Internet/cable wiring' },
    ] },
    { code: '18.0', name: 'FURNITURE & FURNISHING', subLedgers: [
      { code: '18.1', name: 'Furniture' },
      { code: '18.2', name: 'Wardrobes' },
      { code: '18.3', name: 'Curtains/blinds' },
    ] },
    { code: '19.0', name: 'APPLIANCES', subLedgers: [
      { code: '19.1', name: 'Appliances (fridge, washing machine, AC, etc.)' },
      { code: '19.2', name: 'Water purifier' },
    ] },
    { code: '20.0', name: 'TAXES & FINANCE CHARGES', subLedgers: [
      { code: '20.1', name: 'Loan processing fees' },
      { code: '20.2', name: 'GST on contractor billing' },
      { code: '20.3', name: 'Loan interest' },
    ] },
    { code: '21.0', name: 'INSURANCE', subLedgers: [
      { code: '21.1', name: 'Property/structure insurance' },
    ] },
    { code: '22.0', name: 'POST-COMPLETION ADMINISTRATION', subLedgers: [
      { code: '22.1', name: 'Completion/occupancy certificate fees' },
      { code: '22.2', name: 'Property tax registration' },
    ] },
    { code: '23.0', name: 'SITE OVERHEADS & CONTINGENCY', subLedgers: [
      { code: '23.1', name: 'Equipment rental (mixer, JCB, scaffolding)' },
      { code: '23.2', name: 'Material transport costs' },
      { code: '23.3', name: 'Contingency fund (10–15% of total budget)' },
    ] },
  ];

  if (typeof module !== 'undefined' && module.exports) module.exports = { LEDGERS };
  else root.LEDGERS = LEDGERS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
