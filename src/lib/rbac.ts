/** Roles, permissions, and the role→permission matrix (§4).
 * Permissions are `module:action` strings. Enforced at three layers:
 * route middleware (requirePerm), service guards (assertPerm), and UI
 * affordance hiding (can()). docs/permission-matrix.md is generated from
 * this file by `npm run gen:docs`. */

export const ROLES = [
  'PLATFORM_ADMIN',
  'ORG_ADMIN',
  'REGIONAL_MANAGER',
  'PROPERTY_MANAGER',
  'ASSISTANT_MANAGER',
  'LEASING_AGENT',
  'MAINTENANCE_SUPERVISOR',
  'MAINTENANCE_TECH',
  'ACCOUNTANT',
  'MARKETING_MANAGER',
  'VENDOR',
  'RESIDENT',
  'APPLICANT',
  'GUARANTOR',
] as const;
export type Role = (typeof ROLES)[number];

/** Full permission catalog, grouped by module. */
export const PERMISSIONS: Record<string, string[]> = {
  dashboard: ['view'],
  admin: ['org', 'staff', 'settings', 'audit', 'jobs', 'api', 'impersonate', 'platform'],
  properties: ['view', 'manage'],
  units: ['view', 'manage'],
  leasing: ['view', 'manage', 'center'], // leads, guest cards, tours, quotes
  applications: ['view', 'manage'],
  screening: ['view', 'override'],
  leases: ['view', 'manage', 'countersign'],
  renewals: ['view', 'manage'],
  residents: ['view', 'manage'],
  ledger: ['view', 'charge', 'adjust'],
  payments: ['record', 'refund'],
  latefees: ['waive'],
  deposits: ['manage'],
  collections: ['manage'],
  gl: ['view', 'post', 'close_period', 'reopen_period'],
  ap: ['view', 'manage', 'approve', 'pay'],
  banking: ['view', 'reconcile'],
  budgets: ['view', 'manage'],
  workorders: ['view', 'manage', 'assign', 'work'],
  turns: ['manage'],
  inspections: ['manage'],
  inventory: ['manage'],
  pm: ['manage'], // preventive maintenance
  utilities: ['view', 'manage', 'bill'],
  insurance: ['view', 'manage'],
  pricing: ['view', 'approve', 'override'],
  reports: ['view', 'build', 'schedule'],
  comms: ['view', 'send', 'mass'],
  templates: ['manage'],
  vendors: ['view', 'manage'],
  pos: ['create', 'approve', 'receive'],
  invoices: ['enter', 'approve'],
  marketing: ['sites', 'syndication', 'campaigns'],
  ai: ['view', 'configure', 'approve'],
  dev: ['console'],
};

export const ALL_PERMS: string[] = Object.entries(PERMISSIONS).flatMap(([m, actions]) =>
  actions.map((a) => `${m}:${a}`),
);

/** Role → permission patterns. `*` = everything; `module:*` = whole module. */
export const ROLE_PERMS: Record<Role, string[]> = {
  PLATFORM_ADMIN: ['*'],
  ORG_ADMIN: ALL_PERMS.filter((p) => p !== 'admin:platform'),
  REGIONAL_MANAGER: [
    'dashboard:view', 'admin:audit',
    'properties:*', 'units:*', 'leasing:*', 'applications:*', 'screening:*',
    'leases:*', 'renewals:*', 'residents:*',
    'ledger:*', 'payments:*', 'latefees:waive', 'deposits:manage', 'collections:manage',
    'gl:view', 'ap:view', 'ap:approve', 'banking:view', 'budgets:view', 'budgets:manage',
    'workorders:view', 'workorders:manage', 'workorders:assign', 'turns:manage', 'inspections:manage', 'pm:manage', 'inventory:manage',
    'utilities:view', 'utilities:manage', 'insurance:view', 'insurance:manage',
    'pricing:*', 'reports:*', 'comms:*', 'templates:manage',
    'vendors:*', 'pos:*', 'invoices:*', 'marketing:*', 'ai:*',
  ],
  PROPERTY_MANAGER: [
    'dashboard:view', 'admin:audit',
    'properties:view', 'units:*', 'leasing:view', 'leasing:manage',
    'applications:*', 'screening:view', 'screening:override',
    'leases:*', 'renewals:*', 'residents:*',
    'ledger:*', 'payments:record', 'payments:refund', 'latefees:waive', 'deposits:manage', 'collections:manage',
    'gl:view', 'ap:view', 'ap:manage', 'budgets:view',
    'workorders:*', 'turns:manage', 'inspections:manage', 'pm:manage', 'inventory:manage',
    'utilities:view', 'utilities:manage', 'insurance:*',
    'pricing:view', 'reports:view', 'reports:build', 'reports:schedule', 'comms:*', 'templates:manage',
    'vendors:view', 'vendors:manage', 'pos:create', 'pos:receive', 'invoices:enter', 'ai:view', 'ai:approve',
  ],
  ASSISTANT_MANAGER: [
    'dashboard:view',
    'properties:view', 'units:view', 'units:manage', 'leasing:view', 'leasing:manage',
    'applications:*', 'screening:view',
    'leases:view', 'leases:manage', 'renewals:view', 'renewals:manage', 'residents:*',
    'ledger:view', 'ledger:charge', 'payments:record', 'deposits:manage',
    'workorders:view', 'workorders:manage', 'inspections:manage',
    'utilities:view', 'insurance:view', 'insurance:manage',
    'reports:view', 'comms:view', 'comms:send', 'ai:view',
  ],
  LEASING_AGENT: [
    'dashboard:view',
    'properties:view', 'units:view', 'leasing:view', 'leasing:manage', 'leasing:center',
    'applications:view', 'applications:manage', 'screening:view',
    'leases:view', 'renewals:view', 'residents:view',
    'ledger:view', 'reports:view', 'comms:view', 'comms:send', 'ai:view',
  ],
  MAINTENANCE_SUPERVISOR: [
    'dashboard:view',
    'properties:view', 'units:view', 'residents:view',
    'workorders:*', 'turns:manage', 'inspections:manage', 'inventory:manage', 'pm:manage',
    'utilities:view', 'vendors:view', 'pos:create', 'pos:receive', 'invoices:enter',
    'reports:view', 'comms:view', 'comms:send', 'ai:view',
  ],
  MAINTENANCE_TECH: [
    'dashboard:view',
    'units:view', 'residents:view',
    'workorders:view', 'workorders:work', 'inspections:manage',
    'comms:view',
  ],
  ACCOUNTANT: [
    'dashboard:view', 'admin:audit',
    'properties:view', 'units:view', 'residents:view', 'leases:view', 'renewals:view',
    'ledger:*', 'payments:*', 'latefees:waive', 'deposits:manage', 'collections:manage',
    'gl:*', 'ap:*', 'banking:*', 'budgets:*',
    'utilities:*', 'insurance:view',
    'reports:*', 'comms:view', 'comms:send',
    'vendors:*', 'pos:approve', 'invoices:*', 'workorders:view',
  ],
  MARKETING_MANAGER: [
    'dashboard:view',
    'properties:view', 'units:view', 'leasing:view',
    'marketing:*', 'templates:manage', 'comms:view', 'comms:send', 'comms:mass',
    'reports:view', 'reports:build', 'ai:view',
  ],
  VENDOR: [],
  RESIDENT: [],
  APPLICANT: [],
  GUARANTOR: [],
};

export function expandPerms(roles: Role[]): Set<string> {
  const out = new Set<string>();
  for (const role of roles) {
    for (const pat of ROLE_PERMS[role] || []) {
      if (pat === '*') {
        for (const p of ALL_PERMS) out.add(p);
      } else if (pat.endsWith(':*')) {
        const mod = pat.slice(0, -2);
        for (const a of PERMISSIONS[mod] || []) out.add(`${mod}:${a}`);
      } else out.add(pat);
    }
  }
  return out;
}

export const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_ADMIN: 'Platform Admin',
  ORG_ADMIN: 'Org Admin',
  REGIONAL_MANAGER: 'Regional Manager',
  PROPERTY_MANAGER: 'Property Manager',
  ASSISTANT_MANAGER: 'Assistant Manager',
  LEASING_AGENT: 'Leasing Agent',
  MAINTENANCE_SUPERVISOR: 'Maintenance Supervisor',
  MAINTENANCE_TECH: 'Maintenance Tech',
  ACCOUNTANT: 'Accountant',
  MARKETING_MANAGER: 'Marketing Manager',
  VENDOR: 'Vendor',
  RESIDENT: 'Resident',
  APPLICANT: 'Applicant',
  GUARANTOR: 'Guarantor',
};
