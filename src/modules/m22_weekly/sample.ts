/** A fictional scattered-site, voucher-heavy portfolio, exported the way an
 * AppFolio report export looks: title rows, property section rows, subtotals.
 *
 * Every name, property and figure here is invented. It exists so the report
 * can be demonstrated — and tested — without anyone's real data, and so a
 * prospective partner can download the four files and see the shape we expect
 * before sending their own (de-identified) exports.
 *
 * The portfolio is built to exercise every branch of the report on purpose:
 * agencies two and three months behind, an abated partial agency payment, a
 * household on a payment plan, a 90+ balance, a partial payment, a catch-up
 * overpayment, a receipt for a unit no longer on the rent roll, vacancies, and
 * stalled work orders. All amounts are generated from the unit index so the
 * same as-of date always produces the same files.
 */

import { addDays, firstOfMonth, lastOfMonth, type DateStr } from '../../lib/dates.ts';
import { toCsv } from '../../lib/csv.ts';

type Program = 'DCHA HCVP' | 'DCHA VASH' | 'DHS Rapid Rehousing' | null;

interface SampleUnit {
  i: number;
  property: string;
  unit: string;
  tenant: string;
  vacant: boolean;
  rent: number; // cents
  tenantRent: number;
  subsidyRent: number;
  program: Program;
  /** months of household rent unpaid (fractional allowed) */
  tenantBehind: number;
  /** months of subsidy unpaid */
  agencyBehind: number;
  /** a one-off shortfall this month on the household side, cents */
  tenantShort: number;
  /** a one-off shortfall this month on the agency side, cents */
  agencyShort: number;
  onPlan: boolean;
  catchUp: boolean;
}

const SMALL = ['Oakwood Terrace', 'Hillcrest Four', 'Maple View', 'Cedar Gate', 'Linden Row', 'Birch Hollow'];
const HOUSES = ['Sycamore House', 'Willow House', 'Aspen House', 'Juniper House', 'Magnolia House'];
const BUILDING = 'Riverside Commons';

const NAMES = [
  'Denise Harper', 'Marcus Bell', 'Tanya Brooks', 'Andre Simmons', 'Keisha Grant', 'Lamont Hayes', 'Rochelle Price',
  '', 'Darnell Foster', 'Monique Ellis', 'Terrence Wade', 'Yolanda Pierce', 'Curtis Mann', 'Shanice Rivers',
  'Gregory Lyons', 'Patrice Holt', 'Raymond Cobb', 'Felicia Dunn', 'Jerome Battle', 'Lisa Moreland', 'Victor Sutton',
  'Angela Cross', 'Derrick Pope', '', 'Tiffany Lowe', 'Calvin Rhodes', 'Brenda Kerr', 'Malik Sharpe', 'Sonya Gaines',
  'Howard Fields', 'Renee Barnes', 'Dwayne Combs', 'Gloria Nash', 'Antoine Doyle', 'Cheryl Blount', 'Kevin Pratt',
  'Latoya Swann', 'Rodney Boyce', '', 'Pamela Ware', 'Isaiah Greer', 'Wanda Tolbert', 'Byron Hicks', 'Nadia Cole',
  'Frank Mosley', 'Ebony Starks', 'Jasmine Reed',
];

const VACANT = new Set([7, 23, 38]);

function units(): SampleUnit[] {
  const out: SampleUnit[] = [];
  const place: { property: string; unit: string; base: number }[] = [];
  for (const p of SMALL) for (const u of ['1', '2', '3', '4']) place.push({ property: p, unit: u, base: 165000 });
  for (const fl of [1, 2, 3]) for (let n = 1; n <= 6; n++) place.push({ property: BUILDING, unit: `${fl}0${n}`, base: 145000 });
  for (const h of HOUSES) place.push({ property: h, unit: 'Main', base: 235000 });
  place.forEach((pl, i) => {
    const vacant = VACANT.has(i);
    const rent = pl.property === BUILDING ? pl.base + (i % 3) * 7500 : pl.base;
    const m = i % 10;
    const program: Program = vacant ? null : m <= 4 ? 'DCHA HCVP' : m === 5 ? 'DCHA VASH' : m === 6 ? 'DHS Rapid Rehousing' : null;
    const tenantRent = !program ? rent : program === 'DHS Rapid Rehousing' ? 17500 : 25000 + ((i * 3700) % 45000);
    const subsidyRent = rent - tenantRent;
    let tenantBehind = 0;
    if (i % 13 === 5) tenantBehind = 4;
    else if (i % 11 === 3) tenantBehind = 2.5;
    else if (i % 6 === 1) tenantBehind = 1;
    let agencyBehind = 0;
    if (program === 'DHS Rapid Rehousing') agencyBehind = i === 16 ? 1 : 3;
    else if (program === 'DCHA HCVP' && i % 9 === 0) agencyBehind = 2;
    else if (program === 'DCHA VASH' && i === 15) agencyBehind = 1;
    out.push({
      i, property: pl.property, unit: pl.unit, tenant: vacant ? '' : NAMES[i] || `Resident ${i}`, vacant,
      rent, tenantRent, subsidyRent, program,
      tenantBehind: vacant ? 0 : tenantBehind,
      agencyBehind: vacant ? 0 : agencyBehind,
      tenantShort: !vacant && tenantBehind === 0 && i % 8 === 2 ? 12000 : 0,
      agencyShort: i === 12 ? 21000 : 0,
      onPlan: i === 14 || i === 25,
      catchUp: i === 20,
    });
  });
  return out;
}

/** Balance chunks, newest first: the current month is 0–30 days old, last
 * month 30–60, and so on. A fractional month lands in the oldest bucket. */
function aged(monthly: number, months: number): [number, number, number, number] {
  const b: [number, number, number, number] = [0, 0, 0, 0];
  let left = months;
  let k = 0;
  while (left > 0) {
    const part = Math.round(monthly * Math.min(1, left));
    b[Math.min(k, 3)] += part;
    left -= 1;
    k++;
  }
  return b;
}

const money = (c: number): string => {
  const neg = c < 0;
  const s = (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `(${s})` : s;
};
const us = (d: DateStr): string => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;

function balances(u: SampleUnit): { total: number; subsidy: number; buckets: [number, number, number, number] } {
  const t = aged(u.tenantRent, u.tenantBehind);
  const a = aged(u.subsidyRent, u.agencyBehind);
  const b: [number, number, number, number] = [t[0] + a[0] + u.tenantShort + u.agencyShort, t[1] + a[1], t[2] + a[2], t[3] + a[3]];
  const subsidy = a.reduce((s, x) => s + x, 0) + u.agencyShort;
  return { total: b[0] + b[1] + b[2] + b[3], subsidy, buckets: b };
}

/** As-of date the sample is generated for: today once agencies have had time
 * to pay (the 12th on), otherwise the end of last month, so the demo never
 * shows an empty "nothing due yet" month. */
export function sampleAsOf(today: DateStr): DateStr {
  return Number(today.slice(8, 10)) >= 12 ? today : lastOfMonth(addDays(firstOfMonth(today), -1));
}

export interface SampleFiles {
  asOf: DateStr;
  rentRoll: string[][];
  delinquency: string[][];
  delinquencyPrior: string[][];
  receipts: string[][];
  workOrders: string[][];
}

export function sampleFiles(asOf: DateStr): SampleFiles {
  const all = units();
  const ms = firstOfMonth(asOf);

  const rentRoll: string[][] = [
    ['Rent Roll'], [`As of: ${us(asOf)}`], [],
    ['Property', 'Unit', 'Tenant', 'Status', 'Market Rent', 'Rent', 'Tenant Rent', 'Subsidy Rent', 'Subsidy Program', 'Lease From', 'Lease To', 'Past Due'],
  ];
  for (const u of all) {
    const leaseFrom = addDays(ms, -((u.i * 41) % 700) - 30);
    rentRoll.push([
      u.property, u.unit, u.vacant ? 'VACANT' : u.tenant, u.vacant ? 'Vacant-Unrented' : 'Current',
      money(u.rent), u.vacant ? '0.00' : money(u.rent),
      u.vacant ? '' : money(u.tenantRent), u.vacant || !u.subsidyRent ? '0.00' : money(u.subsidyRent),
      u.program ?? '', u.vacant ? '' : us(leaseFrom), u.vacant ? '' : us(addDays(leaseFrom, 364)),
      u.vacant ? '0.00' : money(balances(u).total),
    ]);
  }
  rentRoll.push(['Total', '', '', '', '', money(all.filter((u) => !u.vacant).reduce((s, u) => s + u.rent, 0))]);

  const delinquencyGrid = (rows: { u: SampleUnit; total: number; subsidy: number; buckets: number[]; note: string }[], at: DateStr): string[][] => {
    const g: string[][] = [
      ['Delinquency'], [`As of: ${us(at)}`], ['Exported On: ' + us(at)], [],
      ['Unit', 'Name', 'Tenant Status', 'Amount Receivable', 'Delinquent Subsidy Amount', '0-30', '30-60', '60-90', '90+', 'Last Payment', 'Delinquency Notes'],
    ];
    const props = [...new Set(rows.map((r) => r.u.property))];
    let grand = 0;
    for (const p of props) {
      g.push([`-> ${p}`]);
      let sub = 0;
      for (const r of rows.filter((x) => x.u.property === p)) {
        sub += r.total;
        g.push([
          r.u.unit, r.u.tenant, 'Current', money(r.total), money(r.subsidy),
          ...r.buckets.map(money), us(addDays(at, -((r.u.i * 7) % 40) - 3)), r.note,
        ]);
      }
      g.push(['Total', '', '', money(sub)]);
      grand += sub;
    }
    g.push(['Total', '', '', money(grand)]);
    return g;
  };

  const owing = all.filter((u) => !u.vacant).map((u) => ({ u, ...balances(u), note: u.onPlan ? `Payment plan $150/mo since ${us(addDays(ms, -45))}` : '' }))
    .filter((r) => r.total > 0);
  const delinquency = delinquencyGrid(owing, asOf);

  // a week earlier: two households were not yet behind, the agencies were a
  // little less behind, one household had not yet caught up, one has since paid off
  const priorRows = all.filter((u) => !u.vacant).map((u) => {
    let { total, subsidy, buckets } = balances(u);
    if (u.i % 12 === 1 && u.tenantBehind === 1) { total = 0; subsidy = 0; buckets = [0, 0, 0, 0]; }
    if (u.program === 'DHS Rapid Rehousing' && u.agencyBehind === 3) {
      total -= u.subsidyRent; subsidy -= u.subsidyRent; buckets = [buckets[0] - u.subsidyRent, buckets[1], buckets[2], buckets[3]];
    }
    if (u.catchUp) { total = u.tenantRent; buckets = [u.tenantRent, 0, 0, 0]; }
    if (u.i === 33) { total = 45000; buckets = [45000, 0, 0, 0]; }
    return { u, total, subsidy, buckets, note: u.onPlan ? `Payment plan $150/mo since ${us(addDays(ms, -45))}` : '' };
  }).filter((r) => r.total > 0);
  const delinquencyPrior = delinquencyGrid(priorRows, addDays(asOf, -7));

  const receipts: string[][] = [
    ['Receipts Register'], [`${us(addDays(ms, -10))} – ${us(asOf)}`], [],
    ['Date', 'Property', 'Unit', 'Payer', 'Reference', 'Amount', 'Description'],
  ];
  let ref = 4100;
  for (const u of all) {
    if (u.vacant) continue;
    // a few of last month's late payments, to prove the month filter works
    if (u.i % 9 === 4) receipts.push([us(addDays(ms, -4)), u.property, u.unit, u.tenant, `CHK ${ref++}`, money(u.tenantRent), 'Rent']);
    if (u.subsidyRent > 0 && u.agencyBehind === 0) {
      const payer = u.program === 'DHS Rapid Rehousing' ? 'DC Dept of Human Services' : 'DC Housing Authority';
      receipts.push([us(addDays(ms, 2)), u.property, u.unit, payer, `ACH ${ref++}`, money(u.subsidyRent - u.agencyShort), 'Housing assistance payment']);
    }
    if (u.tenantRent > 0 && u.tenantBehind < 1) {
      const amt = u.catchUp ? u.tenantRent * 2 : u.tenantRent - u.tenantShort - Math.round(u.tenantRent * u.tenantBehind);
      if (amt > 0) receipts.push([us(addDays(ms, u.i % 5)), u.property, u.unit, u.tenant, `EPAY ${ref++}`, money(amt), u.catchUp ? 'Rent + balance' : 'Rent']);
    }
    if (u.onPlan) receipts.push([us(addDays(ms, 14)), u.property, u.unit, u.tenant, `MO ${ref++}`, money(15000), 'Payment plan installment']);
  }
  receipts.push([us(addDays(ms, 6)), BUILDING, '12B', 'Former resident', `MO ${ref++}`, money(30000), 'Balance payment']);

  const vendors = ['Capitol Plumbing Co.', 'Metro HVAC Services', 'Eastside Electric', 'In-house maintenance', 'Seal-Tite Roofing'];
  const jobs: [string, 'Urgent' | 'Normal' | 'Low', string, number, number | null][] = [
    // description, priority, status, days open, days since last update
    ['No heat in unit', 'Urgent', 'Assigned', 3, 3],
    ['Water leaking through kitchen ceiling', 'Urgent', 'Waiting on Vendor', 2, 2],
    ['Smoke detector chirping', 'Normal', 'New', 1, null],
    ['Bathroom faucet drips', 'Low', 'New', 9, null],
    ['Refrigerator not cooling', 'Normal', 'Waiting on Parts', 16, 11],
    ['Front door lock sticks', 'Normal', 'Scheduled', 5, 1],
    ['Mold on bathroom ceiling', 'Normal', 'Assigned', 21, 14],
    ['Window will not close', 'Normal', 'Completed', 12, 2],
    ['Roof leak over bedroom', 'Urgent', 'Completed', 6, 4],
    ['Pest treatment (roaches)', 'Normal', 'Scheduled', 8, 6],
    ['Garbage disposal jammed', 'Low', 'Completed', 30, 25],
    ['Hallway light out', 'Low', 'New', 40, null],
    ['Dryer vent cleaning', 'Low', 'Waiting on Vendor', 18, 12],
    ['Stove burner not igniting', 'Normal', 'Assigned', 4, 4],
    ['Annual inspection repairs (DCHA)', 'Urgent', 'Assigned', 6, 5],
    ['Toilet running', 'Normal', 'Completed', 3, 1],
  ];
  const occupied = all.filter((u) => !u.vacant);
  const workOrders: string[][] = [
    ['Work Order Directory'], [], ['Work Order Number', 'Property', 'Unit', 'Status', 'Priority', 'Created At', 'Last Updated', 'Vendor', 'Description'],
  ];
  jobs.forEach(([desc, pri, status, age, idle], k) => {
    const u = occupied[(k * 7) % occupied.length]!;
    workOrders.push([
      `${2210 + k}-1`, u.property, u.unit, status, pri, us(addDays(asOf, -age)), idle === null ? '' : us(addDays(asOf, -idle)),
      status === 'New' ? '' : vendors[k % vendors.length]!, desc,
    ]);
  });

  return { asOf, rentRoll, delinquency, delinquencyPrior, receipts, workOrders };
}

export const SAMPLE_FILE_NAMES = {
  rentRoll: 'sample-rent-roll.csv',
  delinquency: 'sample-delinquency.csv',
  delinquencyPrior: 'sample-delinquency-last-week.csv',
  receipts: 'sample-receipts.csv',
  workOrders: 'sample-work-orders.csv',
} as const;

export function sampleCsv(grid: string[][]): string {
  const width = Math.max(...grid.map((r) => r.length));
  const pad = grid.map((r) => [...r, ...Array(width - r.length).fill('')]);
  return toCsv(pad[0]!, pad.slice(1));
}
