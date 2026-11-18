import { addDays, type DateStr } from '../../lib/dates.ts';
import { sampleFiles } from '../m22_weekly/sample.ts';

/** A fictional tenant export for the Placement Scorecard, built on the weekly
 * action report's sample portfolio so the same delinquency file works for
 * both demos. Every name, agent and figure is invented, and the pattern in it
 * (one outside agent's placements fall behind more often) is planted so the
 * screen has something to show. The export deliberately has NO subsidy-program
 * column: the scorecard never reads one (see scorecard.ts). */

const us = (d: DateStr): string => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;

const AGENTS = ['In-house', 'In-house', 'Metro Rentals (outside)', 'Keystone Leasing (outside)', 'In-house'];
const SOURCES = ['Zillow', 'Apartments.com', 'Referral', 'Yard sign'];

export function samplePlacements(asOf: DateStr): { placements: string[][]; delinquency: string[][] } {
  const base = sampleFiles(asOf);
  const head = base.rentRoll.findIndex((r) => r[0] === 'Property');
  const out: string[][] = [
    ['Tenant Directory with Leasing Detail'], [`As of: ${us(asOf)}`], [],
    ['Property', 'Unit', 'Tenant', 'Move In', 'Move Out', 'Rent', 'Tenant Rent', 'Leasing Agent', 'Lead Source', 'Screening Decision'],
  ];
  base.rentRoll.slice(head + 1).forEach((r, i) => {
    if (r[0] === 'Total' || /^vacant/i.test(r[2] || '')) return;
    const behindish = i % 13 === 5 || i % 11 === 3 || i % 6 === 1;
    const agent = behindish && i % 3 !== 0 ? 'Keystone Leasing (outside)' : AGENTS[i % AGENTS.length]!;
    const source = i === 9 || i === 30 ? 'Facebook' : SOURCES[i % SOURCES.length]!;
    out.push([r[0]!, r[1]!, r[2]!, r[9]!, '', r[5]!, r[6]!, agent, source, i % 7 === 3 ? 'Approved with conditions' : 'Approved']);
  });
  // past tenants, so early move-outs have something to count
  const past: [string, string, string, number, number, string, string][] = [
    // property, unit, name, moved in (days ago), stayed (days), agent, source
    ['Riverside Commons', '103', 'Former Resident A', 900, 700, 'In-house', 'Zillow'],
    ['Riverside Commons', '205', 'Former Resident B', 500, 210, 'Keystone Leasing (outside)', 'Apartments.com'],
    ['Oakwood Terrace', '2', 'Former Resident C', 820, 640, 'In-house', 'Referral'],
    ['Hillcrest Four', '3', 'Former Resident D', 430, 150, 'Keystone Leasing (outside)', 'Zillow'],
    ['Maple View', '1', 'Former Resident E', 760, 410, 'Metro Rentals (outside)', 'Yard sign'],
    ['Cedar Gate', '4', 'Former Resident F', 610, 300, 'Keystone Leasing (outside)', 'Apartments.com'],
    ['Linden Row', '2', 'Former Resident G', 980, 900, 'In-house', 'Referral'],
    ['Birch Hollow', '3', 'Former Resident H', 540, 380, 'Metro Rentals (outside)', 'Zillow'],
    ['Riverside Commons', '301', 'Former Resident I', 470, 260, 'In-house', 'Yard sign'],
  ];
  for (const [property, unit, name, ago, stayed, agent, source] of past) {
    const moveIn = addDays(asOf, -ago);
    out.push([property, unit, name, us(moveIn), us(addDays(moveIn, stayed)), '1,650.00', '1,650.00', agent, source, 'Approved']);
  }
  return { placements: out, delinquency: base.delinquency };
}
