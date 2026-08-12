import { q, q1, run, insert, val, tx, j, js } from '../../lib/db.ts';
import { id } from '../../lib/ids.ts';
import { nowIso } from '../../lib/dates.ts';
import { audit } from '../../lib/audit.ts';
import type { Ctx } from '../../lib/auth.ts';
import { getSettingMerged, narrowOverride, setSetting, SETTING_DEFAULTS } from '../../lib/settings.ts';
import type { PolicyFinding } from './policy_reader.ts';

/** Proposals: what the documents said, waiting for a human to agree.
 *
 * The product's shape everywhere else is "AI drafts, the operator approves".
 * Settings had been the exception — forty questions asked cold, before the
 * operator has any reason to know the answers, when their own leases already
 * state most of them. This closes that: an import reads the documents and
 * queues proposals; the settings page shows each one with the sentence it came
 * from; accepting is what writes a setting. Nothing here writes one on its own.
 *
 * Cross-document disagreement is information, not noise. Five leases that all
 * say $75 is a confident proposal; three saying $75 and two saying $50 is a
 * proposal at $75 that says so, marked low confidence, because a portfolio with
 * two late-fee regimes is a fact the operator needs rather than a tie to break
 * silently. */

export interface ProposalRow {
  id: string;
  org_id: string;
  property_id: string | null;
  key: string;
  path: string | null;
  value: string;
  quote: string | null;
  source_label: string | null;
  source_file_id: string | null;
  agreement: string | null;
  confidence: string;
  status: string;
  created_at: string;
}

export interface SourcedFinding extends PolicyFinding {
  sourceLabel: string;
  sourceFileId?: string | null;
}

const fieldKey = (f: { key: string; path?: string }): string => `${f.key}|${f.path ?? ''}`;

/** Fold every document's findings into one proposal per setting field, and say
 * how much the documents agreed. Silence never becomes a value: a field no
 * document mentioned produces no proposal at all. */
export function reconcileFindings(findings: SourcedFinding[]): {
  key: string; path?: string; value: number; quote: string;
  sourceLabel: string; sourceFileId?: string | null;
  agreement: string; confidence: 'high' | 'low';
}[] {
  const groups = new Map<string, SourcedFinding[]>();
  for (const f of findings) {
    const k = fieldKey(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(f);
  }
  const out: ReturnType<typeof reconcileFindings> = [];
  for (const group of groups.values()) {
    const counts = new Map<number, SourcedFinding[]>();
    for (const f of group) {
      if (!counts.has(f.value)) counts.set(f.value, []);
      counts.get(f.value)!.push(f);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
    const [value, backing] = ranked[0]!;
    const unanimous = ranked.length === 1;
    const lead = backing[0]!;
    out.push({
      key: lead.key, path: lead.path, value, quote: lead.quote,
      sourceLabel: lead.sourceLabel, sourceFileId: lead.sourceFileId,
      agreement: unanimous
        ? (group.length === 1 ? 'one document' : `all ${group.length} documents agree`)
        : `${backing.length} of ${group.length} documents — the others say ${ranked.slice(1).map(([v]) => fmtLike(lead.key, lead.path, v)).join(', ')}`,
      // documents that disagree are the operator's problem to know about, not
      // a tie for this code to break quietly
      confidence: (unanimous ? 'high' : 'low') as 'high' | 'low',
    });
  }
  return out;
}

/** Format a raw value the way its setting reads, for the disagreement note. */
function fmtLike(key: string, path: string | undefined, v: number): string {
  const name = path || key;
  if (/cents/i.test(name)) return `$${(v / 100).toFixed(2)}`;
  if (/pct|percent/i.test(name)) return `${v}%`;
  if (/days/i.test(name)) return `${v} days`;
  return String(v);
}

/** Queue what the documents said. Re-reading the same field replaces a pending
 * proposal (the newest read wins) but never revives one already decided — a
 * dismissed proposal stays dismissed, or every import would re-ask a question
 * the operator has already answered. */
export function recordProposals(
  ctx: Ctx,
  scope: { propertyId: string | null; batchId?: string | null },
  findings: SourcedFinding[],
): number {
  const reconciled = reconcileFindings(findings).filter((r) => r.key in SETTING_DEFAULTS);
  if (!reconciled.length) return 0;
  let queued = 0;
  tx(() => {
    for (const r of reconciled) {
      const decided = q1<{ id: string }>(
        `SELECT id FROM setting_proposals WHERE org_id=? AND IFNULL(property_id,'')=? AND key=? AND IFNULL(path,'')=? AND status!='pending'`,
        ctx.orgId, scope.propertyId || '', r.key, r.path || '',
      );
      if (decided) continue; // already answered; do not ask again
      run(
        `DELETE FROM setting_proposals WHERE org_id=? AND IFNULL(property_id,'')=? AND key=? AND IFNULL(path,'')=? AND status='pending'`,
        ctx.orgId, scope.propertyId || '', r.key, r.path || '',
      );
      insert('setting_proposals', {
        id: id('spr'), org_id: ctx.orgId, property_id: scope.propertyId, key: r.key, path: r.path || null,
        value: js(r.value), quote: r.quote, source_label: r.sourceLabel, source_file_id: r.sourceFileId || null,
        import_batch_id: scope.batchId || null, agreement: r.agreement, confidence: r.confidence,
        status: 'pending', created_at: nowIso(), decided_at: null, decided_by: null,
      });
      queued++;
    }
  });
  if (queued) audit(ctx, 'setting_proposals', scope.batchId || ctx.orgId, 'read_from_documents', null, { queued, propertyId: scope.propertyId });
  return queued;
}

export function pendingProposals(ctx: Ctx): ProposalRow[] {
  return q<ProposalRow>(
    `SELECT * FROM setting_proposals WHERE org_id=? AND status='pending' ORDER BY key, path`,
    ctx.orgId,
  );
}

export function pendingCount(ctx: Ctx): number {
  return val<number>(`SELECT COUNT(*) FROM setting_proposals WHERE org_id=? AND status='pending'`, ctx.orgId) || 0;
}

/** What this proposal would change, in the operator's terms — and whether it
 * CONFLICTS with what is configured now. The conflict is the durable value
 * here: long after onboarding, it means the configured late fee and the leases
 * being signed have drifted apart, which is money. */
export function proposalDelta(ctx: Ctx, p: ProposalRow): { current: unknown; proposed: unknown; conflicts: boolean } {
  const effective = getSettingMerged<unknown>(ctx, p.key, p.property_id || undefined);
  const proposed = j<unknown>(p.value, null);
  const current = p.path && effective && typeof effective === 'object'
    ? (effective as Record<string, unknown>)[p.path]
    : effective;
  return { current, proposed, conflicts: JSON.stringify(current) !== JSON.stringify(proposed) };
}

/** Accept: this is the only path in the feature that writes a setting.
 *
 * A single-property organization gets the value as its ORG default, so a
 * property added later inherits the policy that was read rather than silently
 * falling back to a shipped guess. With more than one property the value is
 * recorded against the building whose lease said it, because that is all the
 * document proves. */
export function acceptProposal(ctx: Ctx, proposalId: string): { key: string; scope: 'org' | 'property' } | null {
  const p = q1<ProposalRow>(`SELECT * FROM setting_proposals WHERE id=? AND org_id=? AND status='pending'`, proposalId, ctx.orgId);
  if (!p) return null;
  const propertyCount = val<number>('SELECT COUNT(*) FROM properties WHERE org_id=?', ctx.orgId) || 0;
  const asOrg = propertyCount <= 1 || !p.property_id;
  const target = asOrg ? null : p.property_id;
  const proposed = j<unknown>(p.value, null);

  tx(() => {
    const base = getSettingMerged<unknown>(ctx, p.key, target || undefined);
    const next = p.path && base && typeof base === 'object'
      ? { ...(base as Record<string, unknown>), [p.path]: proposed }
      : proposed;
    if (target) {
      const orgEffective = getSettingMerged<unknown>(ctx, p.key, null);
      const narrowed = narrowOverride(orgEffective, next);
      if (narrowed === undefined) {
        run('DELETE FROM settings WHERE org_id=? AND property_id=? AND key=?', ctx.orgId, target, p.key);
      } else {
        setSetting(ctx, p.key, narrowed, target);
      }
    } else {
      setSetting(ctx, p.key, next, null);
    }
    run(`UPDATE setting_proposals SET status='accepted', decided_at=?, decided_by=? WHERE id=?`, nowIso(), ctx.userId, p.id);
  });
  audit(ctx, 'setting_proposal', p.id, 'accept', null, { key: p.key, path: p.path, value: proposed, scope: asOrg ? 'org' : 'property' });
  return { key: p.key, scope: asOrg ? 'org' : 'property' };
}

/** Dismiss: the operator's current value stands, and this field is never
 * proposed again from a document. Disagreeing with the lease is a legitimate
 * answer — the setting is what the business does, the lease is one input. */
export function dismissProposal(ctx: Ctx, proposalId: string): ProposalRow | null {
  const p = q1<ProposalRow>(`SELECT * FROM setting_proposals WHERE id=? AND org_id=? AND status='pending'`, proposalId, ctx.orgId);
  if (!p) return null;
  run(`UPDATE setting_proposals SET status='dismissed', decided_at=?, decided_by=? WHERE id=?`, nowIso(), ctx.userId, p.id);
  audit(ctx, 'setting_proposal', p.id, 'dismiss', null, { key: p.key, path: p.path });
  return p;
}
