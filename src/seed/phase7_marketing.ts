import { q, insert, run, js, q1 } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import type { SeedCtx } from './seed.ts';
import { log } from './seed.ts';
import { DEFAULT_MARKETING, type Marketing } from '../modules/m4_marketing/public.ts';

/** Phase 7 seed: per-property marketing content + ILS publications for
 * vacant-ready units. */
export function seedMarketing(s: SeedCtx): void {
  const props = q<any>('SELECT * FROM properties WHERE org_id=?', s.orgId);
  const content: Record<string, Partial<Marketing>> = {
    'summit-ridge': {
      theme: '#2f7a5e',
      heroTitle: 'Mountain views. Garden calm. City close.',
      heroSub: 'Spacious garden-style homes in southeast Denver with renovated interiors and a resident-first team.',
      about: 'Summit Ridge pairs mature landscaping and mountain views with renovated interiors, a saltwater pool, and maintenance that actually shows up. Ten minutes to DTC, four blocks to the Highline Canal trail.',
      neighborhood: 'Walk to Eisenhower Park and the Highline Canal. Whole Foods, Target and light rail within five minutes; DTC and downtown commutes both under 25.',
      amenities: ['Saltwater pool & cabana', 'Renovated interiors available', 'Fitness studio', 'Dog park & pet spa', 'Garages & storage', 'Online rent & requests', 'EV charging', '24/7 emergency maintenance'],
    },
    'foundry-lofts': {
      theme: '#b3541e',
      heroTitle: 'Industrial bones. Modern soul.',
      heroSub: 'Loft living on Austin\'s east side — concrete floors, skyline views, rooftop fires.',
      about: 'A converted ironworks reborn as 150 lofts: exposed brick, 12-foot ceilings, and a rooftop with the best skyline view on the east side. Steps from the Plaza Saltillo line.',
      neighborhood: 'East 6th tacos, Lady Bird Lake trails, and a two-stop hop downtown. Everything Austin, none of the parking drama.',
      amenities: ['Rooftop lounge & grills', 'Skyline views', 'Concrete floors & exposed brick', 'Maker studio', 'Conference room / WFH suites', 'Controlled garage parking', 'Pet friendly', 'Package lockers'],
    },
    'cardinal-commons': {
      theme: '#a3272f',
      heroTitle: 'Live steps from campus.',
      heroSub: 'By-the-bed student living with individual leases, study lounges and all-inclusive simplicity.',
      about: 'Purpose-built 4×4 suites for students: individual liability leases, roommate matching, furnished options and a 24/7 study lounge. Parents co-sign online in minutes.',
      neighborhood: 'Seven minutes to the main quad by bike, two blocks to the stadium shuttle, and late-night eats on High Street.',
      amenities: ['Individual liability leases', 'Roommate matching', '24/7 study lounge', 'Furnished options', 'All-inclusive utility bundles', 'Bike storage', 'Controlled access', 'Community events'],
    },
  };
  for (const p of props) {
    const mk: Marketing = { ...DEFAULT_MARKETING, ...(content[p.slug] || {}), published: true };
    run('UPDATE properties SET marketing=? WHERE id=?', js(mk), p.id);
  }
  // publications: vacant-ready units → zillow + apartments_com
  const units = q<any>(`SELECT * FROM units WHERE org_id=? AND status='vacant_ready'`, s.orgId);
  let pubs = 0;
  for (const u of units) {
    for (const ch of ['zillow', 'apartments_com'] as const) {
      if (!q1<any>('SELECT id FROM listing_publications WHERE unit_id=? AND channel=?', u.id, ch)) {
        insert('listing_publications', {
          id: id('pub'), org_id: s.orgId, property_id: u.property_id, unit_id: u.id,
          channel: ch, status: 'active', published_at: s.businessDate,
        });
        pubs++;
      }
    }
  }
  log(`marketing: 3 sites published, ${pubs} ILS listings live`);
}
