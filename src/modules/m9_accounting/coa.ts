import { insert, q1 } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { on } from '../../lib/events.ts';

/** Standard multifamily chart of accounts + default posting rules (M9.1-2).
 * Org master chart; per-property books share the chart (property dimension on
 * every journal line). Codes follow common PM conventions. */

type AcctType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export const COA: [string, string, AcctType, string?][] = [
  // code, name, type, control marker
  ['1010', 'Cash — Operating', 'asset', 'cash'],
  ['1020', 'Cash — Security Deposits', 'asset', 'deposit_cash'],
  ['1050', 'Payments Clearing (Undeposited)', 'asset', 'clearing'],
  ['1100', 'Accounts Receivable — Residents', 'asset', 'ar'],
  ['1200', 'Prepaid Expenses', 'asset'],
  ['1300', 'Due from Affiliated Properties', 'asset', 'due_from'],
  ['1500', 'Capital Improvements', 'asset'],
  ['2010', 'Accounts Payable', 'liability', 'ap'],
  ['2300', 'Due to Affiliated Properties', 'liability', 'due_to'],
  ['2100', 'Security Deposits Held', 'liability', 'deposits'],
  ['2150', 'Resident Prepayments & Credits', 'liability', 'prepaid'],
  ['2200', 'Accrued Liabilities', 'liability'],
  ['3010', 'Retained Earnings', 'equity'],
  ['3020', 'Owner Contributions / (Distributions)', 'equity'],
  ['3030', 'Opening Balance Equity (conversion)', 'equity'],
  ['4010', 'Rent Income', 'income'],
  ['4015', 'Month-to-Month Premium Income', 'income'],
  ['4020', 'Late Fee Income', 'income'],
  ['4030', 'Utility Reimbursement Income (RUBS)', 'income'],
  ['4040', 'Parking & Storage Income', 'income'],
  ['4050', 'Pet Income', 'income'],
  ['4060', 'Application Fee Income', 'income'],
  ['4070', 'Admin Fee Income', 'income'],
  ['4080', 'Amenity & Other Income', 'income'],
  ['4090', 'NSF Fee Income', 'income'],
  ['4100', 'Insurance Program Income', 'income'],
  ['4110', 'Deposit Alternative Income', 'income'],
  ['4120', 'Guaranty Program Income', 'income'],
  ['4900', 'Concessions (contra-income)', 'income'],
  ['5010', 'Repairs & Maintenance', 'expense'],
  ['5020', 'Turnover & Make-Ready', 'expense'],
  ['5030', 'Landscaping & Grounds', 'expense'],
  ['5040', 'Cleaning & Janitorial', 'expense'],
  ['5050', 'Pest Control', 'expense'],
  ['5110', 'Utilities — Electric', 'expense'],
  ['5120', 'Utilities — Water & Sewer', 'expense'],
  ['5130', 'Utilities — Gas', 'expense'],
  ['5140', 'Utilities — Trash', 'expense'],
  ['5210', 'Payroll & Contract Labor', 'expense'],
  ['5310', 'Marketing & Advertising', 'expense'],
  ['5410', 'Insurance Expense', 'expense'],
  ['5510', 'Property Taxes', 'expense'],
  ['5610', 'Bad Debt Expense', 'expense'],
  ['5710', 'Bank & Merchant Fees', 'expense'],
  ['5810', 'Office & Administrative', 'expense'],
  ['5910', 'Supplies & Inventory', 'expense'],
];

/** charge kind → income/liability credit account */
export const CHARGE_CREDIT: Record<string, string> = {
  rent: '4010',
  mtm_premium: '4015',
  late_fee: '4020',
  utility: '4030',
  parking: '4040',
  garage: '4040',
  storage: '4040',
  pet_rent: '4050',
  application_fee: '4060',
  admin_fee: '4070',
  amenity: '4080',
  nsf_fee: '4090',
  insurance: '4100',
  deposit_alternative: '4110',
  guaranty: '4120',
  concession: '4900',
  writeoff: '5610', // negative charge → DR 5610 Bad Debt, CR 1100 AR
  deposit: '2100',
  opening_balance: '3030', // migration conversion: AR carried in from the prior system
  damage: '5020', // damage recovery credits turn expense
  utility_flat: '4030',
  reward: '4900',
  other: '4080',
};

export const POSTING_RULES: [string, string, string, string][] = [
  // event_key, description, DR, CR  (charge.* CR resolves per kind at post time)
  ['charge.default', 'Resident charge accrues receivable', '1100', 'per-kind income/liability'],
  ['payment.received', 'Payment intake to clearing', '1050', '1100'],
  ['payment.settled', 'Settlement moves clearing to cash', '1010', '1050'],
  ['payment.deposit_portion', 'Deposit funds held in escrow cash', '1020', '1050'],
  ['payment.nsf', 'NSF reverses receipt', '1100', '1050'],
  ['deposit.applied', 'Deposit applied against balance at move-out', '2100', '1100'],
  ['deposit.refunded', 'Deposit refunded to resident', '2100', '1020'],
  ['writeoff', 'Bad debt write-off', '5610', '1100'],
  ['invoice.approved', 'Vendor invoice accrues payable', 'per-line expense', '2010'],
  ['invoice.paid', 'Payment run clears payable', '2010', '1010'],
];

export function ensureCoa(orgId: string): void {
  if (q1('SELECT id FROM gl_accounts WHERE org_id=? LIMIT 1', orgId)) return;
  COA.forEach(([code, name, type, control], i) => {
    insert('gl_accounts', {
      id: id('gla'), org_id: orgId, code, name, type, is_control: control || null, active: 1, sort: i,
    });
  });
  for (const [event_key, description, dr, cr] of POSTING_RULES) {
    insert('posting_rules', { id: id('prl'), org_id: orgId, event_key, description, dr_code: dr, cr_code: cr });
  }
}

// new orgs get the standard chart automatically
on('org.created', (ctx) => ensureCoa(ctx.orgId));

export function accountName(code: string): string {
  const hit = COA.find(([c]) => c === code);
  return hit ? hit[1] : code;
}
