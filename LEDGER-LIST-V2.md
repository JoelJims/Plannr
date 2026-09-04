# Plannr Ledger Taxonomy v2

> **Status: PROPOSED, not implemented.** `ledgers.js` still seeds the v1 taxonomy and nothing in the app reads this file. Replacing the seed is a separate change (and, because sub-ledger codes would be reused with new meanings, a destructive one — see the Phase 10a guard in `db.js`).

Built for a fixed unit-rate lump sum contract - one priced at a rate per square foot of final measured built-up area - which is the contract shape Plannr models.

Structured so that any expense marked "included in contract" maps to a nameable line in the builder's Schedule of Work. Sub-ledgers name CATEGORIES only: no brand, supplier, rate or contract clause belongs in one. Add your own with the Ledger List CSV round trip if you want them.

Every main ledger ends with an `N.99 Misc` sub-ledger. The existing CUSTOM mechanism is separate and unchanged.

## Materials

### 1.0 MATERIALS — CONCRETE & STRUCTURE
- 1.1 Cement
- 1.2 Steel TMT bars
- 1.3 Binding wire
- 1.4 M-Sand (manufactured rock sand)
- 1.5 P-Sand
- 1.6 Coarse aggregate / jelly (20mm)
- 1.7 Quarry powder
- 1.8 Ready-mix concrete
- 1.9 Admixtures & curing compounds
- 1.99 Misc

### 2.0 MATERIALS — MASONRY
- 2.1 Rough rubble / boulders
- 2.2 Laterite stone
- 2.3 Cement bricks / blocks
- 2.4 Clay bricks
- 2.99 Misc

### 3.0 MATERIALS — JOINERY
- 3.1 MS window frames
- 3.2 MS ventilator frames
- 3.3 Main entry steel door
- 3.4 Other exterior steel doors
- 3.5 Interior doors (FRP / panel / WPC)
- 3.6 Window shutters & glass panes
- 3.7 SS hardware — hinges, locks, handles
- 3.8 Stair handrail
- 3.9 Grills & MS fabrication
- 3.10 Wood / timber
- 3.99 Misc

### 4.0 MATERIALS — ELECTRICAL
- 4.1 Conduits & concealed pipes
- 4.2 Cables & wires
- 4.3 Modular switches & regulators
- 4.4 Metal boxes
- 4.5 Distribution board
- 4.6 MCB / ELCB
- 4.7 Light fixtures
- 4.8 Fans
- 4.9 Inverter / UPS
- 4.10 Solar panels
- 4.11 Earthing materials
- 4.99 Misc

### 5.0 MATERIALS — PLUMBING & SANITARY
- 5.1 Pipes & fittings
- 5.2 CP fittings — taps, showers
- 5.3 Sanitary ware — WC, wash basin
- 5.4 Geyser
- 5.5 Kitchen sink & wash counter
- 5.6 Water storage tank
- 5.7 Sump
- 5.8 Septic tank & sewage rings
- 5.9 Motor / pump
- 5.99 Misc

### 6.0 MATERIALS — FINISHES
- 6.1 Flooring tiles
- 6.2 Bathroom tiles
- 6.3 Ceramic tiles — work & utility area
- 6.4 Granite
- 6.5 Skirting & borders
- 6.6 Epoxy grouting
- 6.7 Tile adhesive
- 6.8 Waterproofing compounds
- 6.9 White cement
- 6.99 Misc

### 7.0 MATERIALS — PAINT
- 7.1 Exterior putty
- 7.2 Interior putty
- 7.3 Primer
- 7.4 Exterior finish
- 7.5 Interior finish
- 7.6 Enamel — wood & MS
- 7.7 Epoxy primer
- 7.99 Misc

## Labour

### 8.0 LABOUR — EARTHWORK & FOUNDATION
- 8.1 Excavation
- 8.2 Soil removal & disposal
- 8.3 Foundation rubble work
- 8.4 Quarry powder filling
- 8.5 Plinth rubble work
- 8.6 Plinth filling & compaction
- 8.99 Misc

### 9.0 LABOUR — CONCRETE & MASONRY
- 9.1 Belt casting
- 9.2 Laterite masonry
- 9.3 Lintel casting
- 9.4 Sunshade casting
- 9.5 Roof slab casting
- 9.6 Floor PCC
- 9.7 Parapet
- 9.8 Shuttering / centering
- 9.9 Bar bending
- 9.10 Curing
- 9.11 Material unloading
- 9.99 Misc

### 10.0 LABOUR — FINISHING
- 10.1 Plastering
- 10.2 White cement coating
- 10.3 Tiling & flooring
- 10.4 Granite fixing
- 10.5 Waterproofing
- 10.6 Painting
- 10.7 Carpenter / joinery fixing
- 10.8 MS fabrication & welding
- 10.9 False ceiling
- 10.99 Misc

### 11.0 LABOUR — SERVICES
- 11.1 Electrical conduiting
- 11.2 Electrical wiring & fixing
- 11.3 Plumbing rough-in
- 11.4 Plumbing fixture fitting
- 11.5 Septic tank installation
- 11.6 Pest control / anti-termite
- 11.99 Misc

## Pre-construction & statutory

### 12.0 LAND & LEGAL
- 12.1 Land cost
- 12.2 Registration & stamp duty
- 12.3 Survey & utility location
- 12.4 Easements
- 12.5 Legal & documentation
- 12.99 Misc

### 13.0 DESIGN & CONSULTANCY
- 13.1 Plan & elevation design
- 13.2 3D design
- 13.3 Interior design
- 13.4 Structural advice / certificate
- 13.5 Architectural review approvals
- 13.6 Soil report
- 13.7 Revised drawings
- 13.99 Misc

### 14.0 STATUTORY FEES & PERMITS
- 14.1 Building permit
- 14.2 Completion / occupancy certificate
- 14.3 Impact fees
- 14.4 Electricity board connection
- 14.5 Water connection
- 14.6 Loan estimation fees
- 14.7 Property tax registration
- 14.99 Misc

### 15.0 SITE UTILITIES & TEMPORARY WORKS
- 15.1 Site water supply / tanker
- 15.2 Site electricity supply
- 15.3 Borewell
- 15.4 Site storage / shed
- 15.5 Temporary fencing
- 15.6 Equipment rental
- 15.7 Scaffolding
- 15.8 Material transport
- 15.99 Misc

## Contract boundaries

### 16.0 EXCLUDED WORKS — OWNER SCOPE
- 16.1 Light fixture installation
- 16.2 Electrical outside plinth area
- 16.3 Plumbing outside plinth area
- 16.4 Exterior wall cladding
- 16.5 Roof tiling / shingles
- 16.6 Truss work
- 16.7 Structural glass works
- 16.8 Roads, walks & paving
- 16.9 Debris & excavation hauling
- 16.10 Off-site utility connections
- 16.99 Misc

### 17.0 CHANGE ORDERS & EXTRAS
- 17.1 Additional work — builder billed
- 17.2 Supervision charges
- 17.3 Additional foundation work
- 17.4 Additional plinth work
- 17.5 Client-supplied materials
- 17.6 Allowance overrun settlement
- 17.99 Misc

## Post-contract

### 18.0 KITCHEN & INTERIORS
- 18.1 Kitchen countertop
- 18.2 Modular cabinets
- 18.3 Chimney / exhaust
- 18.4 Wardrobes
- 18.5 Furniture
- 18.6 Curtains & blinds
- 18.7 Mirrors & glass work
- 18.99 Misc

### 19.0 APPLIANCES
- 19.1 Refrigerator
- 19.2 Washing machine
- 19.3 Air conditioning
- 19.4 Water purifier
- 19.5 TV & electronics
- 19.6 Installation charges
- 19.99 Misc

### 20.0 EXTERIOR & COMPOUND
- 20.1 Compound wall
- 20.2 Gate
- 20.3 Car porch / parking
- 20.4 Driveway & paving
- 20.5 Steps & ramps
- 20.6 Drainage & storm water
- 20.99 Misc

### 21.0 LANDSCAPING
- 21.1 Garden & planting
- 21.2 Lawn
- 21.3 Outdoor lighting
- 21.4 Rainwater harvesting
- 21.5 Outdoor furniture
- 21.99 Misc

## Money & closing

### 22.0 TAXES, FINANCE & INSURANCE
- 22.1 GST on contractor billing
- 22.2 GST on owner purchases
- 22.3 Loan processing fees
- 22.4 Loan interest
- 22.5 Bank charges
- 22.6 Owner's liability insurance
- 22.7 Fire & casualty insurance
- 22.8 Extended warranties
- 22.99 Misc

### 23.0 HANDOVER & CLEANING
- 23.1 Post-construction cleaning
- 23.2 Debris & scaffolding clearing
- 23.3 Hazardous waste disposal
- 23.4 Plastic waste handover
- 23.5 Deep cleaning
- 23.6 Snagging & rectification
- 23.7 Moving & shifting
- 23.99 Misc

### 24.0 CONTINGENCY & UNPLANNED
- 24.1 Contingency fund
- 24.2 Rework & damage
- 24.3 Theft & loss
- 24.4 Delay costs
- 24.5 Price escalation
- 24.99 Misc

## Notes for implementation

- 24 main ledgers, 24 `N.99 Misc` sub-ledgers, 152 named sub-ledgers.
- Contractor stage payments are deliberately absent — they belong in the contractor-payments table, which already feeds the Overview pie. A ledger main for them would double-count.
- A per-sq-ft allowance cap, where a contract sets one, will usually sit against 6.1 flooring tiles, 6.2 bathroom tiles or 6.4 granite. Plannr seeds no caps of its own - every cap is one the owner enters.
- Picker grouping: Materials 1–7, Labour 8–11, Pre-construction 12–15, Contract boundaries 16–17, Post-contract 18–21, Money 22, Closing 23–24.
