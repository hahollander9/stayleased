import { q1, insert } from '../lib/db.ts';
import { id } from '../lib/ids.ts';
import { nowIso, addDays } from '../lib/dates.ts';
import type { SeedCtx } from './seed.ts';
import type { CastIds } from './phase2_residents.ts';
import { log } from './seed.ts';

/** Phase 4 seed: the named cast's portal state — Maya Torres has one open
 * work order (per §8) plus a completed one to demo ratings. Full facilities
 * volume arrives with Phase 5. */

export function seedPortalCast(s: SeedCtx, cast: CastIds): void {
  const maya = q1<any>(
    `SELECT l.*, r.id AS resident_id, r.first_name, r.last_name FROM leases l
     JOIN household_members hm ON hm.lease_id=l.id AND hm.role='primary'
     JOIN residents r ON r.id=hm.resident_id
     WHERE l.id=?`,
    cast.mayaLeaseId,
  );
  if (!maya) return;

  const mkWo = (row: Record<string, unknown>, events: [string, string, number][]): string => {
    const woId = id('wo');
    insert('work_orders', {
      id: woId, org_id: s.orgId, property_id: maya.property_id, unit_id: maya.unit_id, lease_id: maya.id,
      resident_id: maya.resident_id, permission_to_enter: 1, pet_on_premises: 0, source: 'portal',
      created_by: 'seed', created_at: nowIso(), ...row,
    });
    for (const [kind, body, daysAgo] of events) {
      insert('wo_events', {
        id: id('woe'), org_id: s.orgId, work_order_id: woId, kind, body,
        actor: kind === 'status' && body.includes('received') ? `${maya.first_name} ${maya.last_name}` : 'Sam Whitaker',
        at: nowIso(), business_date: addDays(s.businessDate, -daysAgo), visible_to_resident: 1,
      });
    }
    return woId;
  };

  // open WO (cast requirement)
  mkWo(
    {
      category: 'appliance', priority: 'normal', status: 'scheduled',
      summary: 'Dishwasher not draining after cycle',
      description: 'Standing water in the bottom after every run. Started this weekend.',
      preferred_times: 'Weekdays after 4pm', created_date: addDays(s.businessDate, -3),
      scheduled_date: addDays(s.businessDate, 1), sla_hours: 72, sla_due: addDays(s.businessDate, 0),
    },
    [
      ['status', 'Request received', 3],
      ['status', 'Triaged — normal priority, appliance', 2],
      ['status', 'Scheduled with Sam W. for tomorrow', 1],
    ],
  );

  // completed WO with rating pending → demos the rating flow
  mkWo(
    {
      category: 'plumbing', priority: 'normal', status: 'completed',
      summary: 'Bathroom faucet dripping', description: 'Slow drip from the cold handle.',
      created_date: addDays(s.businessDate, -21), completed_at: nowIso(), completed_date: addDays(s.businessDate, -19),
      sla_hours: 72,
    },
    [
      ['status', 'Request received', 21],
      ['status', 'Assigned to Sam W.', 20],
      ['note', 'Replaced cartridge and O-ring; tested hot/cold.', 19],
      ['status', 'Completed', 19],
    ],
  );

  log('portal cast: Maya Torres — 1 open + 1 completed work order');
}
