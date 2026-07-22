import { q, q1, val, j } from '../../lib/db.ts';
import type { Ctx } from '../../lib/auth.ts';
import { usd } from '../../lib/money.ts';
import { llm } from '../../lib/sim/llm.ts';
import { propose } from './framework.ts';

/** M17.6 ELI Essentials: content generation grounded in real property data —
 * listing descriptions, template drafts, review responses, alt text. Surfaced
 * as generate buttons in the M4 CMS and M15 template library. */

export function generateListing(ctx: Ctx, propertyId: string, floorplanId?: string | null): string {
  const prop = q1<any>('SELECT * FROM properties WHERE id=?', propertyId);
  const fp = floorplanId
    ? q1<any>('SELECT * FROM floorplans WHERE id=?', floorplanId)
    : q1<any>('SELECT * FROM floorplans WHERE property_id=? ORDER BY market_rent_cents LIMIT 1', propertyId);
  const startingAt = val<number>(
    `SELECT MIN(market_rent_cents) FROM units WHERE floorplan_id=? AND status='vacant_ready'`, fp?.id,
  ) || fp?.market_rent_cents || 0;
  const mk = q1<any>(`SELECT value FROM settings WHERE org_id=? AND key='marketing' AND property_id=?`, ctx.orgId, propertyId);
  const amenities = j<{ amenities?: string[] }>(mk?.value || '{}', {}).amenities
    || ['on-site maintenance', 'controlled access', 'resident lounge'];
  const text = llm().complete('listing_description', {
    property: prop.name,
    plan: fp?.name || '',
    beds: fp ? (fp.beds === 0 ? 'studio' : `${fp.beds}-bedroom`) : 'apartment',
    sqft: (fp?.sqft || 800).toLocaleString(),
    amenityLine: `${amenities.slice(0, 3).join(', ')} included.`,
    neighborhood: `${prop.city}'s best coffee, transit and trails`,
    price: usd(startingAt),
    special: '',
  });
  propose(ctx, {
    agent: 'content', propertyId, entity: 'floorplan', entityId: fp?.id,
    title: `Listing description generated — ${prop.name} ${fp?.name || ''}`,
    input: { propertyId, floorplanId: fp?.id, startingAt },
    output: { kind: 'noop.analysis', draft: text },
    confidence: 0.9,
  });
  return text;
}

export function generateTemplateDraft(ctx: Ctx, purpose: string): { subject: string; body: string; sms: string } {
  const subjectMap: [RegExp, string, string][] = [
    [/pool|amenity|closure/i, '{{property}}: heads up — brief amenity closure', 'The COMMON AREA will be closed briefly for maintenance. We expect it back the following morning — thanks for your patience!'],
    [/park|tow|snow/i, '{{property}}: parking reminder for this week', 'A quick reminder about guest parking: please register vehicles in the portal so no one gets an unwelcome surprise. Snow routes clear at 7am.'],
    [/pay|balance|rent/i, 'A friendly note about your {{property}} account', 'Your account shows {{balance}} open. If you have already paid — thank you! Money tight this month? Reply and we will figure out a plan together.'],
    [/welcome|move.?in/i, 'Welcome home to {{property}}, {{first_name}}! 🏡', 'Your portal is live — pay rent, request maintenance, and see community news in one place. Your first visit: set up autopay and never think about the 1st again.'],
    [/renew/i, 'Your {{property}} renewal — options inside', 'Your lease ends soon and we would love to keep you. Your personalized options are in the portal — accept in one tap or reply with questions.'],
  ];
  const hit = subjectMap.find(([re]) => re.test(purpose)) || [/./, `{{property}}: ${purpose.slice(0, 40)}`, `A note from the office about: ${purpose}. Reply here with any questions — we read everything.`];
  const body = llm().complete('template_draft', { body: hit[2] });
  propose(ctx, {
    agent: 'content',
    title: `Template drafted — "${purpose.slice(0, 40)}"`,
    input: { purpose },
    output: { kind: 'noop.analysis', draft: body, subject: hit[1] },
    confidence: 0.85,
  });
  return { subject: hit[1], body, sms: `{{property}}: ${hit[2].split('.')[0]}.` };
}

export function generateReviewResponse(ctx: Ctx, review: string, stars: number, reviewer: string): string {
  const mention = /maintenance|repair/i.test(review) ? 'the maintenance team' : /office|staff|manager/i.test(review) ? 'the office team' : /pool|gym|amenit/i.test(review) ? 'the amenity spaces' : '';
  const text = llm().complete('review_response', { reviewer, stars, mention });
  propose(ctx, {
    agent: 'content',
    title: `Review response drafted — ${stars}★ from ${reviewer}`,
    input: { review: review.slice(0, 200), stars },
    output: { kind: 'noop.analysis', draft: text },
    confidence: 0.9,
  });
  return text;
}

export function generateAltText(ctx: Ctx, subject: string, propertyId: string): string {
  const prop = q1<any>('SELECT name, city FROM properties WHERE id=?', propertyId);
  return llm().complete('alt_text', { subject, property: prop?.name || 'the community', detail: `photographed for the ${prop?.city || ''} community site` });
}
