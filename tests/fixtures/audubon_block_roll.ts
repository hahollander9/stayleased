/** Yardi Voyager "Rent Roll with Lease Charges" — the shapes of the 606-unit
 * Section 18/RAD file uploaded on 2026-08-13, with synthetic names and small
 * consistent numbers. That upload read 539 of 606 units: every row this
 * fixture carries is one of the shapes the reader dropped or nearly dropped.
 *
 * What it exercises, in one roster:
 *   · a normal split-code block with an ancillary sub-row (301);
 *   · a NEGATIVE/positive coded sub-row PAIR inside a block — a payer-split
 *     transfer between voucher and tenant, net zero to the total but not to
 *     the split (302). The real file carried rnsvchr -1,619 / rntnt +1,619
 *     and both rows fell out as "No unit number — row skipped";
 *   · a subsidy-only unit (303) and a ZERO-amount rntnt sub-row (307) — the
 *     fully-voucher-paid household whose $0 tenant-portion row must attach to
 *     its block rather than orphan;
 *   · an occupied unit with NO charge rows at all but a real deposit and a
 *     five-figure balance (304) — the shape that skipped the real file's
 *     largest debtors;
 *   · an EMPLOYEE unit: market rent 0, one NEGATIVE rtempcon charge on the
 *     unit row, a growing credit balance (305) — the concession must not ride
 *     through as negative rent, and must not vanish either;
 *   · lease end BEFORE lease start on a household with a $41k balance (306) —
 *     a holdover to flag, not a row to discard;
 *   · occupied PARKING with market 0 and no charges (A-01, A-02) and vacant
 *     parking with market rent (A-03) — real licenses, real credit balances;
 *   · Sq Ft 0 on every row — the reader must not invent an area;
 *   · a future-section row whose move-in is already PAST (A-03's renewal,
 *     listed as an applicant while the same person also holds the space) and
 *     a normal future resident (309);
 *   · the report's own trailer, which every computed number ties against —
 *     including a NEGATIVE amount in the charge-code summary.
 */
export const AUDUBON_BLOCK_ROLL: string[][] = [
  ['Rent Roll with Lease Charges', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Audubon Mills (1018)', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['As Of = 08/11/2026', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Month Year = 08/2026', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Unit', 'Unit Type', 'Unit', 'Resident', 'Name', 'Market', 'Charge', 'Amount', 'Resident', 'Other', 'Move In', 'Lease', 'Move Out', 'Balance'],
  ['', '', 'Sq Ft', '', '', 'Rent', 'Code', '', 'Deposit', 'Deposit', '', 'Expiration', '', ''],
  ['Current/Notice/Vacant Residents', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // 301 — split codes + ancillary extra; long-expired lease (MTM holdover)
  ['301', '11S18', '0', 't0000001', 'Avery Lane', '2450', 'rnsvchr', '1812', '100', '0', '2004-11-15', '2023-11-15', '', '850.25'],
  ['', '', '', '', '', '', 'rntnt', '283', '', '', '', '', '', ''],
  ['', '', '', '', '', '', 'tsinunit', '4.20', '', '', '', '', '', ''],
  ['', '', '', '', '', '', 'Total', '2099.20', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // 302 — negative/positive coded PAIR inside the block (payer-split transfer)
  ['302', '11S18', '0', 't0000002', 'Rowan Mesa', '2450', 'rntnt', '716', '142', '0', '1978-10-01', '2023-10-01', '', '-304.96'],
  ['', '', '', '', '', '', 'rnsvchr', '1319', '', '', '', '', '', ''],
  ['', '', '', '', '', '', 'rnsvchr', '-119', '', '', '', '', '', ''],
  ['', '', '', '', '', '', 'rntnt', '119', '', '', '', '', '', ''],
  ['', '', '', '', '', '', 'Total', '2035', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // 303 — subsidy-only unit, active lease
  ['303', '21S18', '0', 't0000003', 'Sky Danner', '2735', 'rnsvchr', '2735', '0', '0', '2019-07-11', '2026-12-31', '', '12000'],
  ['', '', '', '', '', '', 'Total', '2735', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // 304 — occupied, NO charges at all, real deposit + balance
  ['304', '21S18', '0', 't0000004', 'Quinn Harbor', '2735', '', '0', '80', '0', '2019-07-11', '2023-07-11', '', '5406'],
  ['', '', '', '', '', '', 'Total', '0', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // 305 — employee unit: single NEGATIVE rtempcon on the unit row, market 0
  ['305', '31S18', '0', 't0000005', 'Sam Steward', '0', 'rtempcon', '-3322', '0', '0', '2025-05-31', '2026-05-30', '', '-26576'],
  ['', '', '', '', '', '', 'Total', '-3322', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // 306 — lease end BEFORE lease start; split codes; big balance
  ['306', '11S18', '0', 't0000006', 'Lena Holdover', '2276', 'rnsvchr', '2055', '224', '0', '2024-08-01', '2023-03-25', '', '41088.33'],
  ['', '', '', '', '', '', 'rntnt', '221', '', '', '', '', '', ''],
  ['', '', '', '', '', '', 'Total', '2276', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // 307 — fully-voucher household: rntnt sub-row with amount 0 must attach
  ['307', '11S18', '0', 't0000007', 'Zaid Fullvoucher', '1543', 'rnsvchr', '1543', '0', '0', '2020-01-01', '2023-01-01', '', '0'],
  ['', '', '', '', '', '', 'rntnt', '0', '', '', '', '', '', ''],
  ['', '', '', '', '', '', 'Total', '1543', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // 308 — vacant residential
  ['308', '11S18', '0', 'VACANT', 'VACANT', '1543', '', '0', '0', '0', '', '', '', '0'],
  ['', '', '', '', '', '', 'Total', '0', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // 310 — a plain tenant-pay unit (keeps rntnt the roster's majority code)
  ['310', '11S18', '0', 't0000012', 'Nora Plain', '2450', 'rntnt', '2450', '300', '0', '2022-03-01', '2026-02-28', '', '150'],
  ['', '', '', '', '', '', 'Total', '2450', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // 311 — a block whose ONLY charge is ancillary, in a SUB-row (empty unit-row
  // amount): the $4.20 that must never be promoted to rent
  ['311', '11S18', '0', 't0000013', 'Tess Trashonly', '1543', '', '', '0', '0', '2021-01-01', '2023-01-01', '', '0'],
  ['', '', '', '', '', '', 'tsinunit', '4.20', '', '', '', '', '', ''],
  ['', '', '', '', '', '', 'Total', '4.20', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // A-01 — occupied parking: market 0, no charges, credit balance
  ['A-01', 'A_Park', '0', 't0000008', 'Illeana Leon', '0', '', '0', '0', '0', '2025-09-01', '2026-08-31', '', '-2648'],
  ['', '', '', '', '', '', 'Total', '0', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // A-02 — occupied parking: zero everything except the tenancy itself
  ['A-02', 'A_Park', '0', 't0000009', 'GLADYS CAPS', '0', '', '0', '0', '0', '2025-09-01', '2026-08-31', '', '0'],
  ['', '', '', '', '', '', 'Total', '0', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // A-03 — vacant parking WITH a market rent
  ['A-03', 'A_Park', '0', 'VACANT', 'VACANT', '293.76', '', '0', '0', '0', '', '', '', '0'],
  ['', '', '', '', '', '', 'Total', '0', '', '', '', '', '', ''],
  ['Future Residents/Applicants', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  // renewal-in-applicant-status: same space as above, move-in already PAST
  ['A-03', 'A_Park', '0', 't0000010', 'PALMIRA PEN', '293.76', '', '0', '0', '0', '2025-10-25', '2026-08-31', '', '0'],
  ['', '', '', '', '', '', 'Total', '0', '', '', '', '', '', ''],
  // a normal future resident on a unit not listed above
  ['309', '11S18', '0', 't0000011', 'Maria Guz', '2450', '', '0', '0', '0', '2026-09-01', '2027-08-31', '', '0'],
  ['', '', '', '', '', '', 'Total', '0', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Summary Groups', '', '', '', '', 'Square', 'Market', 'Lease', 'Security', 'Other', '# Of', '% Unit', '% Sqft', 'Balance'],
  ['', '', '', '', '', 'Footage', 'Rent', 'Charges', 'Deposit', 'Deposits', 'Units', 'Occupancy', 'Occupied', ''],
  ['Occupied Units', '', '', '', '', '0.00', '18,182.00', '', '', '', '11', '84.61', '0.00', ''],
  ['Total Non Rev Units', '', '', '', '', '0.00', '0.00', '', '', '', '0', '0.00', '0.00', ''],
  ['Total Vacant Units', '', '', '', '', '0.00', '1,836.76', '', '', '', '2', '15.38', '0.00', ''],
  ['Totals:', '', '', '', '', '0.00', '20,018.76', '9,820.40', '846.00', '0.00', '13', '100.00', '0.00', '29,965.62'],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Summary of Charges by Charge Code', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['(Current/Notice Residents Only)', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Charge Code', '', '', 'Amount', '', '', '', '', '', '', '', '', '', ''],
  ['rnsvchr', '', '', '9345', '', '', '', '', '', '', '', '', '', ''],
  ['rntnt', '', '', '3789', '', '', '', '', '', '', '', '', '', ''],
  ['tsinunit', '', '', '8.4', '', '', '', '', '', '', '', '', '', ''],
  ['rtempcon', '', '', '-3322', '', '', '', '', '', '', '', '', '', ''],
  ['Total', '', '', '9,820.40', '', '', '', '', '', '', '', '', '', ''],
];
