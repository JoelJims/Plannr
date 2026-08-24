// Plannr — the fixed 24-ledger reference list (Phase 10a).
//
// This is a FIXED reference taxonomy, NOT an editable table. It maps a
// cash_out.ledger_code / subledger_code (e.g. "6.2") to a human-readable
// category name. Single source of truth, usable by BOTH sides:
//   • server:  const { LEDGERS } = require('./public/ledgers.js');
//   • browser: <script type="module" src="/ledgers.js"></script>  ->  window.LEDGERS
//
// Phase 10a replaces the old 23-category phase-based taxonomy with a 24-category one
// derived from the real construction contract and the owner's own tracking spreadsheet.
// Two structural additions over the old taxonomy:
//   1. Every main ledger now has a fixed "Misc" sub-ledger, coded N.99 (e.g. 6.99, 24.99) —
//      a REAL code that rolls up under its parent in the Overview pie, distinct from CUSTOM.
//   2. The CUSTOM mechanism (ledger_code/subledger_code = 'CUSTOM' + a typed free-text name)
//      is unchanged — still available on every ledger and sub-ledger picker, exactly as before.
//
// NOTE: loan INTEREST is recorded under 22.0 (Taxes, Finance & Insurance) as an ordinary
// cash_out row — sub-ledger 22.5 (Loan interest) — so real money paid on a construction loan
// is counted in total spend rather than being structurally invisible. It is NOT double-counted:
// `loans.interest_rate` is informational only and drives no calculation anywhere, so there is
// no derived interest figure for a ledger line to duplicate.
//
// Shape: [{ code, name, subLedgers: [{ code, name }, ...] }, ...]
export const LEDGERS = [
    { code: '1.0', name: 'LAND & LEGAL', subLedgers: [
      { code: '1.1', name: 'Land cost' },
      { code: '1.2', name: 'Registration & stamp duty' },
      { code: '1.3', name: 'Site survey & utility location' },
      { code: '1.99', name: 'Misc' },
    ] },
    { code: '2.0', name: 'DESIGN & CONSULTANCY', subLedgers: [
      { code: '2.1', name: 'Plan & elevation design' },
      { code: '2.2', name: '3D design' },
      { code: '2.3', name: 'Interior design' },
      { code: '2.4', name: 'Structural engineer' },
      { code: '2.5', name: 'Plan-completion' },
      { code: '2.6', name: 'Soil test report' },
      { code: '2.99', name: 'Misc' },
    ] },
    { code: '3.0', name: 'APPROVALS & STATUTORY FEES', subLedgers: [
      { code: '3.1', name: 'Building plan approval' },
      { code: '3.2', name: 'Building permit fees' },
      { code: '3.3', name: 'Impact fees' },
      { code: '3.4', name: 'Completion / occupancy certificate' },
      { code: '3.5', name: 'Property tax registration' },
      { code: '3.99', name: 'Misc' },
    ] },
    { code: '4.0', name: 'SITE PREPARATION', subLedgers: [
      { code: '4.1', name: 'Pre-construction cleaning' },
      { code: '4.2', name: 'Demolition' },
      { code: '4.3', name: 'Land levelling / earthwork' },
      { code: '4.4', name: 'Excavation' },
      { code: '4.5', name: 'Landfill — mud' },
      { code: '4.6', name: 'Debris hauling' },
      { code: '4.99', name: 'Misc' },
    ] },
    { code: '5.0', name: 'TEMPORARY SITE SETUP', subLedgers: [
      { code: '5.1', name: 'Site water supply' },
      { code: '5.2', name: 'Site electricity supply' },
      { code: '5.99', name: 'Misc' },
    ] },
    { code: '6.0', name: 'MATERIALS — STRUCTURAL', subLedgers: [
      { code: '6.1', name: 'Cement' },
      { code: '6.2', name: 'Steel rods (TMT)' },
      { code: '6.3', name: 'M-Sand' },
      { code: '6.4', name: 'P-Sand' },
      { code: '6.5', name: 'Aggregate / jelly' },
      { code: '6.6', name: 'Quarry powder' },
      { code: '6.7', name: 'Boulders / rough rubble' },
      { code: '6.99', name: 'Misc' },
    ] },
    { code: '7.0', name: 'MATERIALS — MASONRY', subLedgers: [
      { code: '7.1', name: 'Laterite stone' },
      { code: '7.2', name: 'Bricks' },
      { code: '7.3', name: 'Cement bricks / blocks' },
      { code: '7.99', name: 'Misc' },
    ] },
    { code: '8.0', name: 'MATERIALS — DOORS, WINDOWS & JOINERY', subLedgers: [
      { code: '8.1', name: 'Main entry door' },
      { code: '8.2', name: 'Exterior doors' },
      { code: '8.3', name: 'Bedroom doors' },
      { code: '8.4', name: 'Bathroom doors' },
      { code: '8.5', name: 'Window frames' },
      { code: '8.6', name: 'Ventilator frames' },
      { code: '8.7', name: 'Window shutters & glass panes' },
      { code: '8.8', name: 'Grills & MS fabrication' },
      { code: '8.9', name: 'Hardware — hinges, locks, handles' },
      { code: '8.10', name: 'Stair handrail' },
      { code: '8.11', name: 'Wood / timber' },
      { code: '8.99', name: 'Misc' },
    ] },
    { code: '9.0', name: 'MATERIALS — ELECTRICAL', subLedgers: [
      { code: '9.1', name: 'Conduits / pipes' },
      { code: '9.2', name: 'Wires & cables' },
      { code: '9.3', name: 'Switches & regulators' },
      { code: '9.4', name: 'Switchboards & metal boxes' },
      { code: '9.5', name: 'Distribution board' },
      { code: '9.6', name: 'MCB / ELCB' },
      { code: '9.7', name: 'Light fixtures' },
      { code: '9.8', name: 'Fans' },
      { code: '9.9', name: 'Inverter / UPS' },
      { code: '9.10', name: 'Solar panels' },
      { code: '9.99', name: 'Misc' },
    ] },
    { code: '10.0', name: 'MATERIALS — PLUMBING & SANITARY', subLedgers: [
      { code: '10.1', name: 'Pipes & fittings' },
      { code: '10.2', name: 'CP fittings — taps, showers' },
      { code: '10.3', name: 'Sanitary ware — WC, wash basin' },
      { code: '10.4', name: 'Geyser' },
      { code: '10.5', name: 'Kitchen sink & wash counter' },
      { code: '10.6', name: 'Water storage tank' },
      { code: '10.7', name: 'Sump' },
      { code: '10.8', name: 'Septic tank & sewage rings' },
      { code: '10.99', name: 'Misc' },
    ] },
    { code: '11.0', name: 'MATERIALS — FINISHES', subLedgers: [
      { code: '11.1', name: 'Flooring tiles' },
      { code: '11.2', name: 'Bathroom tiles' },
      { code: '11.3', name: 'Ceramic tiles — work area' },
      { code: '11.4', name: 'Granite' },
      { code: '11.5', name: 'Paint — exterior' },
      { code: '11.6', name: 'Paint — interior' },
      { code: '11.7', name: 'Enamel & epoxy primer' },
      { code: '11.8', name: 'Putty' },
      { code: '11.9', name: 'Primer' },
      { code: '11.10', name: 'White cement' },
      { code: '11.11', name: 'Waterproofing materials' },
      { code: '11.12', name: 'Epoxy grouting' },
      { code: '11.99', name: 'Misc' },
    ] },
    { code: '12.0', name: 'LABOUR — CIVIL & STRUCTURE', subLedgers: [
      { code: '12.1', name: 'Material unloading' },
      { code: '12.2', name: 'Foundation' },
      { code: '12.3', name: 'Plinth work' },
      { code: '12.4', name: 'Plinth filling' },
      { code: '12.5', name: 'Masonry / brick work' },
      { code: '12.6', name: 'Lintel & sunshade' },
      { code: '12.7', name: 'RCC / concreting' },
      { code: '12.8', name: 'Roof concrete' },
      { code: '12.9', name: 'Floor PCC' },
      { code: '12.10', name: 'Parapet' },
      { code: '12.99', name: 'Misc' },
    ] },
    { code: '13.0', name: 'LABOUR — FINISHING', subLedgers: [
      { code: '13.1', name: 'Plastering' },
      { code: '13.2', name: 'White cement coating' },
      { code: '13.3', name: 'Painting' },
      { code: '13.4', name: 'Tiling & flooring' },
      { code: '13.5', name: 'Granite fixing' },
      { code: '13.6', name: 'Carpenter / joinery' },
      { code: '13.7', name: 'Waterproofing' },
      { code: '13.8', name: 'False ceiling' },
      { code: '13.9', name: 'MS fabrication' },
      { code: '13.99', name: 'Misc' },
    ] },
    { code: '14.0', name: 'LABOUR — SERVICES', subLedgers: [
      { code: '14.1', name: 'Electrical — conduiting' },
      { code: '14.2', name: 'Electrical — wiring & fixing' },
      { code: '14.3', name: 'Plumbing — rough-in' },
      { code: '14.4', name: 'Plumbing — fixture fitting' },
      { code: '14.5', name: 'Pest control' },
      { code: '14.99', name: 'Misc' },
    ] },
    { code: '15.0', name: 'KITCHEN', subLedgers: [
      { code: '15.1', name: 'Countertop / platform' },
      { code: '15.2', name: 'Modular cabinets' },
      { code: '15.3', name: 'Chimney / exhaust' },
      { code: '15.99', name: 'Misc' },
    ] },
    { code: '16.0', name: 'INTERIORS & FURNISHING', subLedgers: [
      { code: '16.1', name: 'Furniture' },
      { code: '16.2', name: 'Wardrobes' },
      { code: '16.3', name: 'Curtains & blinds' },
      { code: '16.4', name: 'False ceiling materials' },
      { code: '16.5', name: 'Glass works' },
      { code: '16.99', name: 'Misc' },
    ] },
    { code: '17.0', name: 'APPLIANCES', subLedgers: [
      { code: '17.1', name: 'Appliances — fridge, washing machine, AC' },
      { code: '17.2', name: 'Water purifier' },
      { code: '17.99', name: 'Misc' },
    ] },
    { code: '18.0', name: 'EXTERIOR & COMPOUND', subLedgers: [
      { code: '18.1', name: 'Compound wall' },
      { code: '18.2', name: 'Gate' },
      { code: '18.3', name: 'Car porch / parking' },
      { code: '18.4', name: 'Exterior cladding' },
      { code: '18.5', name: 'Roof tiling / shingles' },
      { code: '18.6', name: 'Truss work' },
      { code: '18.7', name: 'Roads, walks & paving' },
      { code: '18.99', name: 'Misc' },
    ] },
    { code: '19.0', name: 'LANDSCAPING & OUTDOOR', subLedgers: [
      { code: '19.1', name: 'Landscaping / garden' },
      { code: '19.2', name: 'Outdoor lighting' },
      { code: '19.3', name: 'Rainwater harvesting' },
      { code: '19.99', name: 'Misc' },
    ] },
    { code: '20.0', name: 'UTILITY CONNECTIONS', subLedgers: [
      { code: '20.1', name: 'Electricity connection (KSEB)' },
      { code: '20.2', name: 'Water connection' },
      { code: '20.3', name: 'LPG / gas connection' },
      { code: '20.4', name: 'Internet / cable wiring' },
      { code: '20.5', name: 'Off-site utility connections' },
      { code: '20.99', name: 'Misc' },
    ] },
    { code: '21.0', name: 'EQUIPMENT & TRANSPORT', subLedgers: [
      { code: '21.1', name: 'Equipment rental — mixer, JCB' },
      { code: '21.2', name: 'Scaffolding' },
      { code: '21.3', name: 'Material transport' },
      { code: '21.99', name: 'Misc' },
    ] },
    { code: '22.0', name: 'TAXES, FINANCE & INSURANCE', subLedgers: [
      { code: '22.1', name: 'GST on contractor billing' },
      { code: '22.2', name: 'Other taxes & duties' },
      { code: '22.3', name: 'Loan processing fees' },
      { code: '22.4', name: 'Loan estimation fees' },
      { code: '22.5', name: 'Loan interest' },
      { code: '22.6', name: 'Property / structure insurance' },
      { code: '22.7', name: 'Owner liability insurance' },
      { code: '22.99', name: 'Misc' },
    ] },
    { code: '23.0', name: 'POST-COMPLETION & HANDOVER', subLedgers: [
      { code: '23.1', name: 'Post-construction cleaning' },
      { code: '23.2', name: 'Debris & scaffolding clearing' },
      { code: '23.3', name: 'Hazardous waste disposal' },
      { code: '23.4', name: 'Plastic waste — Harithakarmasena' },
      { code: '23.99', name: 'Misc' },
    ] },
    { code: '24.0', name: 'CONTINGENCY & UNPLANNED', subLedgers: [
      { code: '24.1', name: 'Contingency fund' },
      { code: '24.2', name: 'Foundation depth beyond 2.5 ft' },
      { code: '24.3', name: 'Plinth height beyond 1.5 ft' },
      { code: '24.99', name: 'Misc' },
    ] },
];

if (typeof window !== 'undefined') window.LEDGERS = LEDGERS;
