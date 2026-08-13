/** Yardi Voyager "Rent Roll with Lease Charges" — the exact structure of the
 * file uploaded on 2026-08-12, with synthetic names and numbers. Shared by the
 * unit gate (tests/import_recon.test.ts) and the e2e gate (e2e/setup.test.ts)
 * so both read the SAME document: the unit tests prove the transforms, the e2e
 * proves the upload route actually wires them together.
 *
 * The structure is the point. It carries, in one file:
 *   · a title banner naming the property, above a stacked two-row header;
 *   · a roster split into "Current/Notice/Vacant Residents" and
 *     "Future Residents/Applicants" headings that sit in the UNIT column;
 *   · one block per unit — a unit row, a row per charge code, then a Total;
 *   · unit 245, whose ONE charge carries the subsidy code rather than the rent
 *     code (the case that put the rent/extras split $1,417 off on the real
 *     file while the monthly total still tied);
 *   · future-applicant rows re-listing units that appear above;
 *   · genuinely-$0 deposit and balance columns;
 *   · the report's own trailer: a "Summary Groups" table and a
 *     "Summary of Charges by Charge Code" table, which every computed number
 *     is tied out against.
 */
export const YARDI_BLOCK_ROLL: string[][] = [
  ['Rent Roll with Lease Charges', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Ridgeline Court at Fairview', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['As Of = 08/11/2026', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Month Year = 08/2026', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Unit', 'Unit Type', 'Unit', 'Resident', 'Name', 'Market', 'Charge', 'Amount', 'Resident', 'Other', 'Move In', 'Lease', 'Move Out', 'Balance'],
  ['', '', 'Sq Ft', '', '', 'Rent', 'Code', '', 'Deposit', 'Deposit', '', 'Expiration', '', ''],
  ['Current/Notice/Vacant Residents', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // one charge, and it is rent
  ['201', '1009t016', '500', 't0002302', 'Avery Lane', '1323', 'rntnt', '1491', '0', '0', '2021-10-21', '2022-09-30', '', '0'],
  ['', '', '', '', '', '', 'Total', '1491', '', '', '', '', '', ''],
  // two charges: tenant portion on the unit row, subsidy in a sub-row
  ['205', '1009t016', '500', 't0003347', 'Rowan Mesa', '1323', 'rntnt', '348', '0', '0', '2022-05-23', '2023-04-30', '', '0'],
  ['', '', '', '', '', '', 'rnsvchr', '766', '', '', '', '', '', ''],
  ['', '', '', '', '', '', 'Total', '1114', '', '', '', '', '', ''],
  // ONE charge and it is NOT rent — the $1,417 case
  ['245', '1009t116', '500', 't0003501', 'Sky Danner', '1417', 'rnsvchr', '1417', '0', '0', '2022-03-17', '2023-02-28', '', '0'],
  ['', '', '', '', '', '', 'Total', '1417', '', '', '', '', '', ''],
  ['523', '1009t116', '500', 'VACANT', 'VACANT', '1417', '', '0', '0', '0', '', '', '', '0'],
  ['', '', '', '', '', '', 'Total', '0', '', '', '', '', '', ''],
  ['Future Residents/Applicants', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // a future applicant for the vacant unit above, and one for a unit not listed
  ['523', '1009t116', '500', 't0008353', 'Wren Halcott', '1417', '', '0', '0', '0', '2026-12-17', '2027-11-30', '', '0'],
  ['', '', '', '', '', '', 'Total', '0', '', '', '', '', '', ''],
  ['601', '1009t016', '500', 't0008472', 'Ellis Prater', '1417', '', '0', '0', '0', '2026-11-26', '2027-10-31', '', '0'],
  ['', '', '', '', '', '', 'Total', '0', '', '', '', '', '', ''],
  ['', '', '', 'Total', 'Ridgeline Court at Fairview', '5480', '', '4022', '0', '0', '', '', '', '0'],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Summary Groups', '', '', '', '', 'Square', 'Market', 'Lease', 'Security', 'Other', '# Of', '% Unit', '% Sqft', 'Balance'],
  ['', '', '', '', '', 'Footage', 'Rent', 'Charges', 'Deposit', 'Deposits', 'Units', 'Occupancy', 'Occupied', ''],
  ['Current/Notice/Vacant Residents', '', '', '', '', '2,000.00', '5,480.00', '4,022.00', '0.00', '0.00', '4', '75.00', '75.00', '0.00'],
  ['Future Residents/Applicants', '', '', '', '', '1,000.00', '2,834.00', '0.00', '0.00', '0.00', '2', '', '', '0.00'],
  ['Occupied Units', '', '', '', '', '1,500.00', '4,063.00', '', '', '', '3', '75.00', '75.00', ''],
  ['Total Vacant Units', '', '', '', '', '500.00', '1,417.00', '', '', '', '1', '25.00', '25.00', ''],
  ['Totals:', '', '', '', '', '2,000.00', '5,480.00', '4,022.00', '0.00', '0.00', '4', '100.00', '100.00', '0.00'],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Summary of Charges by Charge Code', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['(Current/Notice Residents)', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Charge Code', '', '', 'Amount', '', '', '', '', '', '', '', '', '', ''],
  ['rntnt', '', '', '1839', '', '', '', '', '', '', '', '', '', ''],
  ['rnsvchr', '', '', '2183', '', '', '', '', '', '', '', '', '', ''],
  ['Total', '', '', '4,022.00', '', '', '', '', '', '', '', '', '', ''],
];

/** What the fixture's own trailer reports — the tie-out target. */
export const YARDI_EXPECTED = {
  units: 4,
  occupied: 3,
  vacant: 1,
  futureApplicants: 2,
  marketRentCents: 548000,
  leaseChargesCents: 402200,
  rentCents: 183900,      // rntnt
  extraMonthlyCents: 218300, // rnsvchr
  depositCents: 0,
  balanceCents: 0,
  property: 'Ridgeline Court at Fairview',
};
