import { q, q1, val, insert, run, j, js } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import { nowIso, addDays, addMonths, monthKey, lastOfMonth, mkDate } from '../lib/dates.ts';
import { sysCtx } from '../lib/auth.ts';
import { postJE } from '../modules/m9_accounting/service.ts';
import { createInvoice, submitInvoice, approveInvoice, createPaymentRun } from '../modules/m9_accounting/ap.ts';
import { ensureBankAccounts, importAllFeeds, createRecon, autoMatch, postAdjustment, completeRecon } from '../modules/m9_accounting/banking.ts';
import { closePeriod, createRecurringJe, runRecurringJes } from '../modules/m9_accounting/close.ts';
import { seedFromActuals, approveBudget, budgetVsActual } from '../modules/m9_accounting/budgets.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';

/** Phase 10 seed (§8): 14 months of AP through the real pipeline, opening
 * balances, recurring amortizations, a reconciled bank history through last
 * month (July intentionally unreconciled), closed periods through June, an
 * approved FY2026 budget with plausible variances, one intercompany payment,
 * and a capital project with coded invoice lines. */

interface Recur {
  vendorCat: string;
  gl: string;
  label: string;
  base: number; // cents/month for a 100-unit property
  jitter: number; // ± fraction
  everyNMonths?: number;
}

const RECURRING_SPEND: Recur[] = [
  { vendorCat: 'landscaping', gl: '5030', label: 'Grounds & landscaping contract', base: 320000, jitter: 0.1 },
  { vendorCat: 'cleaning', gl: '5040', label: 'Common-area cleaning', base: 210000, jitter: 0.12 },
  { vendorCat: 'pest', gl: '5050', label: 'Pest control service', base: 60000, jitter: 0.08 },
  { vendorCat: 'general', gl: '5110', label: 'Common-area electric', base: 260000, jitter: 0.22 },
  { vendorCat: 'general', gl: '5120', label: 'Water & sewer — common', base: 340000, jitter: 0.18 },
  { vendorCat: 'general', gl: '5140', label: 'Trash & recycling hauling', base: 120000, jitter: 0.06 },
  { vendorCat: 'plumbing', gl: '5010', label: 'Plumbing repairs', base: 180000, jitter: 0.45 },
  { vendorCat: 'hvac', gl: '5010', label: 'HVAC service calls', base: 160000, jitter: 0.5 },
  { vendorCat: 'painting', gl: '5020', label: 'Turn painting', base: 220000, jitter: 0.4 },
  { vendorCat: 'restoration', gl: '5810', label: 'Office & admin services', base: 90000, jitter: 0.15, everyNMonths: 2 },
];

export async function seedAccounting(s2: SeedCtx): Promise<void> {
  const s = s2;
  const ctx = sysCtx(s.orgId);
  const props = q<any>('SELECT * FROM properties WHERE org_id=? ORDER BY created_at', s.orgId);
  const vendors = q<any>('SELECT * FROM vendors WHERE org_id=?', s.orgId);
  const vendorBy = (cat: string): any => vendors.find((v) => v.category === cat) || vendors[0];
  const units = new Map<string, number>(
    props.map((p) => [p.id, val<number>('SELECT COUNT(*) FROM units WHERE property_id=?', p.id) || 100]),
  );

  ensureBankAccounts(s.orgId);

  // ---------- opening balances (history start) ----------
  const historyStart = val<string>('SELECT MIN(date) FROM charges WHERE org_id=?', s.orgId) || addMonths(s.businessDate, -14);
  const opening = addDays(historyStart, -1);
  for (const p of props) {
    const scale = (units.get(p.id) || 100) / 100;
    const workingCapital = Math.round((15000000 * scale) / 100) * 100; // ~$150k per 100 units
    const prepaidInsurance = Math.round((3600000 * scale) / 100) * 100; // annual premium ~$36k
    for (const basis of ['accrual', 'cash'] as const) {
      postJE(ctx, {
        propertyId: p.id, date: opening, basis,
        memo: `Opening balances — ${p.name}`, sourceKind: 'opening',
        lines: [
          { account: '1010', debit: workingCapital, memo: 'operating cash funding' },
          { account: '1200', debit: prepaidInsurance, memo: 'prepaid insurance (annual)' },
          { account: '3020', credit: workingCapital + prepaidInsurance, memo: 'owner contribution' },
        ],
      });
    }
  }
  log(`opening balances posted (${opening})`);

  // ---------- recurring JEs: insurance amortization ----------
  for (const p of props) {
    const scale = (units.get(p.id) || 100) / 100;
    const monthly = Math.round((300000 * scale) / 100) * 100;
    createRecurringJe(ctx, {
      propertyId: p.id, name: 'Insurance amortization', memo: 'monthly recognition of prepaid premium',
      lines: [
        { account: '5410', debit: monthly, memo: 'insurance expense' },
        { account: '1200', credit: monthly, memo: 'prepaid draw-down' },
      ],
      dayOfMonth: 1, startMonth: monthKey(historyStart), basis: 'both',
    });
  }
  runRecurringJes(ctx, s.businessDate);
  log('recurring insurance amortization posted through history');

  // ---------- capital project ----------
  const foundry = props.find((p) => p.slug === 'foundry-lofts') || props[1] || props[0];
  const projectId = id('cpj');
  insert('capital_projects', {
    id: projectId, org_id: s.orgId, property_id: foundry.id, name: 'Roof replacement — Building B',
    description: 'Full tear-off and TPO membrane replacement, parapet flashing, and drainage improvements.',
    budget_cents: 18500000,
    cost_codes: js([
      { code: 'RB-100', label: 'Tear-off & disposal', budget_cents: 3500000 },
      { code: 'RB-200', label: 'Membrane & insulation', budget_cents: 9800000 },
      { code: 'RB-300', label: 'Flashing & sheet metal', budget_cents: 3200000 },
      { code: 'RB-400', label: 'Contingency', budget_cents: 2000000 },
    ]),
    status: 'active', start_date: addMonths(s.businessDate, -2), target_date: addMonths(s.businessDate, 1), created_at: nowIso(),
  });

  // ---------- 14 months of vendor invoices through the real pipeline ----------
  let m = monthKey(historyStart);
  const currentMonth = monthKey(s.businessDate);
  let invoiceCount = 0;
  let runCount = 0;
  const invSeq = new Map<string, number>();
  const nextInvNo = (vendorId: string): string => {
    const n = (invSeq.get(vendorId) || 1000 + (s.rng.int(100, 900))) + s.rng.int(2, 9);
    invSeq.set(vendorId, n);
    return String(n);
  };

  while (m <= currentMonth) {
    const [yy, mm] = [Number(m.slice(0, 4)), Number(m.slice(5, 7))];
    const monthInvoices: string[] = [];
    for (const p of props) {
      const scale = (units.get(p.id) || 100) / 100;
      for (const r of RECURRING_SPEND) {
        if (r.everyNMonths && (mm % r.everyNMonths) !== 0) continue;
        // seasonal shading for utilities
        const seasonal = r.gl === '5110' ? (mm >= 6 && mm <= 9 ? 1.3 : 0.85) : r.gl === '5130' ? (mm <= 3 || mm === 12 ? 1.35 : 0.8) : 1;
        const amt = Math.round((r.base * scale * seasonal * (1 + (s.rng.next() * 2 - 1) * r.jitter)) / 100) * 100;
        if (amt <= 0) continue;
        const vendor = vendorBy(r.vendorCat);
        const invDate = mkDate(yy, mm, s.rng.int(2, 12));
        if (invDate > s.businessDate) continue;
        const invId = createInvoice(ctx, {
          vendorId: vendor.id, propertyId: p.id, invoiceNumber: nextInvNo(vendor.id), invoiceDate: invDate,
          memo: r.label, source: 'recurring',
          lines: [{ glAccount: r.gl, description: r.label, amountCents: amt }],
        });
        approveInvoice(ctx, invId);
        monthInvoices.push(invId);
        invoiceCount++;
      }
      // quarterly property taxes
      if ([3, 6, 9, 12].includes(mm)) {
        const vendor = vendorBy('general');
        const tax = Math.round((2400000 * scale) / 100) * 100;
        const invDate = mkDate(yy, mm, 10);
        if (invDate <= s.businessDate) {
          const invId = createInvoice(ctx, {
            vendorId: vendor.id, propertyId: p.id, invoiceNumber: nextInvNo(vendor.id), invoiceDate: invDate,
            memo: 'Quarterly property tax escrow', source: 'recurring',
            lines: [{ glAccount: '5510', description: 'Property tax — quarterly', amountCents: tax }],
          });
          approveInvoice(ctx, invId);
          monthInvoices.push(invId);
          invoiceCount++;
        }
      }
    }
    // capital project draws over the last two months
    if (m >= monthKey(addMonths(s.businessDate, -2)) && m < currentMonth) {
      const roofer = vendorBy('roofing');
      const draws: [string, string, number][] = m === monthKey(addMonths(s.businessDate, -2))
        ? [['RB-100', 'Tear-off & disposal — draw 1', 3350000], ['RB-200', 'Membrane materials — draw 1', 4200000]]
        : [['RB-200', 'Membrane install — draw 2', 4900000], ['RB-300', 'Flashing & sheet metal', 2950000]];
      const invId = createInvoice(ctx, {
        vendorId: roofer.id, propertyId: foundry.id, invoiceNumber: nextInvNo(roofer.id),
        invoiceDate: mkDate(yy, mm, 18), memo: 'Roof replacement progress billing', source: 'manual',
        lines: draws.map(([code, label, amt]) => ({ glAccount: '1500', description: label, amountCents: amt, projectId, costCode: code })),
      });
      approveInvoice(ctx, invId);
      monthInvoices.push(invId);
      invoiceCount++;
    }

    // pay everything approved and invoiced this month on the 25th (check run) —
    // including utility provider invoices from the Phase 11 hook — except the
    // current month (leave open payables for the demo)
    if (m < currentMonth) {
      const payable = q<any>(
        `SELECT id FROM vendor_invoices WHERE org_id=? AND status='approved' AND substr(invoice_date,1,7)=?`,
        s2.orgId, m,
      ).map((x) => x.id);
      if (payable.length) {
        const runDate = mkDate(yy, mm, 25);
        createPaymentRun(ctx, { runDate, method: mm % 3 === 0 ? 'ach' : 'check', invoiceIds: payable });
        runCount++;
      }
    }
    m = mm === 12 ? `${yy + 1}-01` : `${yy}-${String(mm + 1).padStart(2, '0')}`;
  }
  log(`AP history: ${invoiceCount} vendor invoices, ${runCount} payment runs`);

  // ---------- one intercompany payment (Summit Ridge pays a Cardinal bill) ----------
  const summit = props.find((p) => p.slug === 'summit-ridge') || props[0];
  const cardinal = props.find((p) => p.slug === 'cardinal-commons') || props[2] || props[0];
  const restor = vendorBy('restoration');
  const icInv = createInvoice(ctx, {
    vendorId: restor.id, propertyId: cardinal.id, invoiceNumber: nextInvNo(restor.id),
    invoiceDate: addDays(s.businessDate, -20), memo: 'Emergency water mitigation — paid from central account',
    lines: [{ glAccount: '5010', description: 'Water mitigation after supply-line failure', amountCents: 412500 }],
  });
  approveInvoice(ctx, icInv);
  createPaymentRun(ctx, { runDate: addDays(s.businessDate, -18), method: 'check', invoiceIds: [icInv], payFromPropertyId: summit.id });
  log('intercompany payment posted (due-to/due-from)');

  // ---------- live AP queue for the demo ----------
  const hvac = vendorBy('hvac');
  const bigInv = createInvoice(ctx, {
    vendorId: hvac.id, propertyId: summit.id, invoiceNumber: nextInvNo(hvac.id),
    invoiceDate: addDays(s.businessDate, -3), memo: 'Rooftop unit compressor replacement — building C',
    lines: [
      { glAccount: '5010', description: 'RTU-3 compressor + labor', amountCents: 685000 },
      { glAccount: '5910', description: 'Refrigerant & materials', amountCents: 89500 },
    ],
  });
  submitInvoice(ctx, bigInv); // over the $2,500 threshold — routes to a controller
  const pest = vendorBy('pest');
  createInvoice(ctx, {
    vendorId: pest.id, propertyId: cardinal.id, invoiceNumber: nextInvNo(pest.id),
    invoiceDate: s.businessDate, memo: 'Monthly service — draft, not yet submitted',
    lines: [{ glAccount: '5050', description: 'Pest control service', amountCents: 21500 }],
  });
  log('live AP queue: 1 pending approval, 1 draft');

  // ---------- bank feed + reconciliations through LAST month ----------
  importAllFeeds(s.orgId, s.businessDate);
  const accounts = q<any>('SELECT * FROM bank_accounts WHERE org_id=? AND active=1', s.orgId);
  const lastFull = monthKey(addDays(mkDate(Number(currentMonth.slice(0, 4)), Number(currentMonth.slice(5, 7)), 1), -1));
  let recons = 0;
  for (const acct of accounts) {
    let rm = monthKey(opening);
    while (rm <= lastFull) {
      const reconId = createRecon(ctx, acct.id, rm);
      autoMatch(ctx, reconId);
      // bank-only items (fees/interest/noise) become adjustment JEs — real workflow
      for (const t of q<any>(
        `SELECT * FROM bank_txns WHERE bank_account_id=? AND substr(date,1,7)=? AND status='unmatched'`, acct.id, rm,
      )) {
        postAdjustment(ctx, t.id, reconId);
      }
      completeRecon(ctx, reconId);
      recons++;
      const [ry, rmm] = [Number(rm.slice(0, 4)), Number(rm.slice(5, 7))];
      rm = rmm === 12 ? `${ry + 1}-01` : `${ry}-${String(rmm + 1).padStart(2, '0')}`;
    }
  }
  log(`bank reconciliations completed: ${recons} account-months (through ${lastFull}); ${currentMonth} left open for the demo`);

  // ---------- close periods through LAST month ----------
  let closed = 0;
  for (const p of props) {
    let cm = monthKey(opening);
    while (cm <= lastFull) {
      closePeriod(ctx, p.id, cm);
      closed++;
      const [cy, cmm] = [Number(cm.slice(0, 4)), Number(cm.slice(5, 7))];
      cm = cmm === 12 ? `${cy + 1}-01` : `${cy}-${String(cmm + 1).padStart(2, '0')}`;
    }
  }
  log(`accounting periods closed through ${lastFull} (${closed} property-months)`);

  // ---------- FY2026 budget per property (approved, with real variances) ----------
  const year = Number(s.businessDate.slice(0, 4));
  for (const p of props) {
    const bid = seedFromActuals(ctx, p.id, year - 1, year, 3);
    // history starts mid-2025: fill empty budget months with the line average,
    // then nudge — budgets are plans, so variances light up believably
    for (const l of q<any>('SELECT * FROM budget_lines WHERE budget_id=?', bid)) {
      const months = j<number[]>(l.months, []);
      const nz = months.filter((x) => x !== 0);
      if (!nz.length) continue;
      const avg = Math.round(nz.reduce((x, y) => x + y, 0) / nz.length / 100) * 100;
      const bump = 1 + (s.rng.next() * 2 - 1) * 0.12;
      run(
        'UPDATE budget_lines SET months=? WHERE id=?',
        js(months.map((x) => Math.round(((x || avg) * bump) / 100) * 100)), l.id,
      );
    }
    approveBudget(ctx, bid);
  }
  log(`FY${year} budgets approved for ${props.length} properties (seeded from FY${year - 1} actuals +3%, with variances)`);
}
