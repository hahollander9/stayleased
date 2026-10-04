import { q1 } from './db.ts';
import { getSetting } from './settings.ts';
import type { Ctx } from './auth.ts';

/** Standard or Advanced: which version of the product one person sees.
 *
 * Resolved per person, because the switch sits in the navigation bar where
 * anyone can reach it, and a control that visible must only change the screen
 * of whoever pressed it. Were it organization-wide, a property manager opening
 * the full accounts mid-afternoon would rearrange the owner's navigation under
 * them — and a demo's.
 *
 * The organization's `simple_mode` setting is the starting point: what a
 * person sees until they choose. New orgs start everyone in Standard; orgs
 * that existed before the mode did start everyone in Advanced, so nobody's
 * chrome changed on the deploy that introduced it.
 *
 * Only staff have a mode. Residents and vendors have their own portals, and
 * the system context has no screen at all. */
export type UiMode = 'standard' | 'advanced';

export function uiMode(ctx: Ctx | null | undefined): UiMode {
  if (!ctx?.orgId || (ctx.kind !== 'staff' && ctx.kind !== 'platform')) return 'advanced';
  const chosen = q1<{ ui_mode: string | null }>('SELECT ui_mode FROM users WHERE id=?', ctx.userId)?.ui_mode;
  if (chosen === 'standard' || chosen === 'advanced') return chosen;
  return orgDefaultMode(ctx);
}

/** What a person who has not chosen sees. */
export function orgDefaultMode(ctx: Ctx): UiMode {
  return getSetting<boolean>(ctx, 'simple_mode') === true ? 'standard' : 'advanced';
}

/** Whether this person's mode is their own choice or inherited — the settings
 * page says which, so "why am I in Advanced?" has an answer on the screen. */
export function modeIsChosen(ctx: Ctx): boolean {
  const chosen = q1<{ ui_mode: string | null }>('SELECT ui_mode FROM users WHERE id=?', ctx.userId)?.ui_mode;
  return chosen === 'standard' || chosen === 'advanced';
}
