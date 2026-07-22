import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/lib/db.ts';
import { PERMISSIONS, ROLES, ROLE_LABELS, ROLE_PERMS, expandPerms, type Role } from '../src/lib/rbac.ts';

/** Regenerates docs kept in lockstep with code: permission matrix + ERD. */

const docs = join(ROOT, 'docs');
mkdirSync(docs, { recursive: true });

// ---------- permission matrix ----------
const staffRoles = ROLES.filter((r) => !['RESIDENT', 'APPLICANT', 'GUARANTOR', 'VENDOR'].includes(r)) as Role[];
const expanded = new Map(staffRoles.map((r) => [r, expandPerms([r])]));
let md = `# Permission matrix\n\nGenerated from \`src/lib/rbac.ts\` by \`npm run gen:docs\` — do not edit by hand.\nEnforced in three layers: route middleware, service guards, UI affordance hiding.\nPortal roles (RESIDENT, VENDOR, APPLICANT, GUARANTOR) have no staff permissions; their access is record-scoped in portal routes.\n\n| Permission | ${staffRoles.map((r) => ROLE_LABELS[r]).join(' | ')} |\n|---|${staffRoles.map(() => ':-:').join('|')}|\n`;
for (const [mod, actions] of Object.entries(PERMISSIONS)) {
  for (const a of actions) {
    const p = `${mod}:${a}`;
    md += `| \`${p}\` | ${staffRoles.map((r) => (expanded.get(r)!.has(p) ? '●' : '·')).join(' | ')} |\n`;
  }
}
md += `\n## Role intents\n\n`;
for (const r of staffRoles) {
  md += `- **${ROLE_LABELS[r]}** — ${ROLE_PERMS[r].length === 1 && ROLE_PERMS[r][0] === '*' ? 'every permission (platform operations)' : `${expanded.get(r)!.size} permissions`}\n`;
}
writeFileSync(join(docs, 'permission-matrix.md'), md);
console.log('  docs/permission-matrix.md');

// ---------- ERD from schema.sql ----------
const schema = readFileSync(join(ROOT, 'src/db/schema.sql'), 'utf8');
const tables: { name: string; cols: string[]; fks: string[] }[] = [];
const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\);/g;
let m: RegExpExecArray | null;
while ((m = re.exec(schema))) {
  const name = m[1]!;
  const body = m[2]!;
  const cols: string[] = [];
  const fks: string[] = [];
  for (const line of body.split('\n')) {
    const t = line.trim().replace(/,$/, '');
    if (!t || t.startsWith('--') || /^(UNIQUE|PRIMARY KEY|CHECK)\(/i.test(t.replace(' ', '('))) continue;
    const colM = /^(\w+)\s+(TEXT|INTEGER|REAL|BLOB)/.exec(t);
    if (colM) {
      cols.push(colM[1]!);
      const fkM = /REFERENCES (\w+)/.exec(t);
      if (fkM) fks.push(`${colM[1]} → ${fkM[1]}`);
    }
  }
  tables.push({ name, cols, fks });
}
let erd = `# Entity-relationship overview\n\nGenerated from \`src/db/schema.sql\` by \`npm run gen:docs\`. ${tables.length} tables.\nConventions: TEXT ids with type prefixes (\`usr_\`, \`prp_\`…), money INTEGER cents, dates TEXT \`YYYY-MM-DD\`, timestamps ISO-8601 UTC, JSON in TEXT columns. Every org-owned table carries \`org_id\`.\n\n`;
for (const t of tables) {
  erd += `## ${t.name}\n\n- columns: ${t.cols.map((c) => `\`${c}\``).join(', ')}\n`;
  if (t.fks.length) erd += `- references: ${t.fks.join('; ')}\n`;
  erd += '\n';
}
writeFileSync(join(docs, 'erd.md'), erd);
console.log(`  docs/erd.md (${tables.length} tables)`);
