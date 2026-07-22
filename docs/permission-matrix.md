# Permission matrix

Generated from `src/lib/rbac.ts` by `npm run gen:docs` — do not edit by hand.
Enforced in three layers: route middleware, service guards, UI affordance hiding.
Portal roles (RESIDENT, VENDOR, APPLICANT, GUARANTOR) have no staff permissions; their access is record-scoped in portal routes.

| Permission | Platform Admin | Org Admin | Regional Manager | Property Manager | Assistant Manager | Leasing Agent | Maintenance Supervisor | Maintenance Tech | Accountant | Marketing Manager |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `dashboard:view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| `admin:org` | ● | ● | · | · | · | · | · | · | · | · |
| `admin:staff` | ● | ● | · | · | · | · | · | · | · | · |
| `admin:settings` | ● | ● | · | · | · | · | · | · | · | · |
| `admin:audit` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `admin:jobs` | ● | ● | · | · | · | · | · | · | · | · |
| `admin:api` | ● | ● | · | · | · | · | · | · | · | · |
| `admin:impersonate` | ● | ● | · | · | · | · | · | · | · | · |
| `admin:platform` | ● | · | · | · | · | · | · | · | · | · |
| `properties:view` | ● | ● | ● | ● | ● | ● | ● | · | ● | ● |
| `properties:manage` | ● | ● | ● | · | · | · | · | · | · | · |
| `units:view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| `units:manage` | ● | ● | ● | ● | ● | · | · | · | · | · |
| `leasing:view` | ● | ● | ● | ● | ● | ● | · | · | · | ● |
| `leasing:manage` | ● | ● | ● | ● | ● | ● | · | · | · | · |
| `leasing:center` | ● | ● | ● | · | · | ● | · | · | · | · |
| `applications:view` | ● | ● | ● | ● | ● | ● | · | · | · | · |
| `applications:manage` | ● | ● | ● | ● | ● | ● | · | · | · | · |
| `screening:view` | ● | ● | ● | ● | ● | ● | · | · | · | · |
| `screening:override` | ● | ● | ● | ● | · | · | · | · | · | · |
| `leases:view` | ● | ● | ● | ● | ● | ● | · | · | ● | · |
| `leases:manage` | ● | ● | ● | ● | ● | · | · | · | · | · |
| `leases:countersign` | ● | ● | ● | ● | · | · | · | · | · | · |
| `renewals:view` | ● | ● | ● | ● | ● | ● | · | · | ● | · |
| `renewals:manage` | ● | ● | ● | ● | ● | · | · | · | · | · |
| `residents:view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | · |
| `residents:manage` | ● | ● | ● | ● | ● | · | · | · | · | · |
| `ledger:view` | ● | ● | ● | ● | ● | ● | · | · | ● | · |
| `ledger:charge` | ● | ● | ● | ● | ● | · | · | · | ● | · |
| `ledger:adjust` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `payments:record` | ● | ● | ● | ● | ● | · | · | · | ● | · |
| `payments:refund` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `latefees:waive` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `deposits:manage` | ● | ● | ● | ● | ● | · | · | · | ● | · |
| `collections:manage` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `gl:view` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `gl:post` | ● | ● | · | · | · | · | · | · | ● | · |
| `gl:close_period` | ● | ● | · | · | · | · | · | · | ● | · |
| `gl:reopen_period` | ● | ● | · | · | · | · | · | · | ● | · |
| `ap:view` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `ap:manage` | ● | ● | · | ● | · | · | · | · | ● | · |
| `ap:approve` | ● | ● | ● | · | · | · | · | · | ● | · |
| `ap:pay` | ● | ● | · | · | · | · | · | · | ● | · |
| `banking:view` | ● | ● | ● | · | · | · | · | · | ● | · |
| `banking:reconcile` | ● | ● | · | · | · | · | · | · | ● | · |
| `budgets:view` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `budgets:manage` | ● | ● | ● | · | · | · | · | · | ● | · |
| `workorders:view` | ● | ● | ● | ● | ● | · | ● | ● | ● | · |
| `workorders:manage` | ● | ● | ● | ● | ● | · | ● | · | · | · |
| `workorders:assign` | ● | ● | ● | ● | · | · | ● | · | · | · |
| `workorders:work` | ● | ● | · | ● | · | · | ● | ● | · | · |
| `turns:manage` | ● | ● | ● | ● | · | · | ● | · | · | · |
| `inspections:manage` | ● | ● | ● | ● | ● | · | ● | ● | · | · |
| `inventory:manage` | ● | ● | ● | ● | · | · | ● | · | · | · |
| `pm:manage` | ● | ● | ● | ● | · | · | ● | · | · | · |
| `utilities:view` | ● | ● | ● | ● | ● | · | ● | · | ● | · |
| `utilities:manage` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `utilities:bill` | ● | ● | · | · | · | · | · | · | ● | · |
| `insurance:view` | ● | ● | ● | ● | ● | · | · | · | ● | · |
| `insurance:manage` | ● | ● | ● | ● | ● | · | · | · | · | · |
| `pricing:view` | ● | ● | ● | ● | · | · | · | · | · | · |
| `pricing:approve` | ● | ● | ● | · | · | · | · | · | · | · |
| `pricing:override` | ● | ● | ● | · | · | · | · | · | · | · |
| `reports:view` | ● | ● | ● | ● | ● | ● | ● | · | ● | ● |
| `reports:build` | ● | ● | ● | ● | · | · | · | · | ● | ● |
| `reports:schedule` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `comms:view` | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| `comms:send` | ● | ● | ● | ● | ● | ● | ● | · | ● | ● |
| `comms:mass` | ● | ● | ● | ● | · | · | · | · | · | ● |
| `templates:manage` | ● | ● | ● | ● | · | · | · | · | · | ● |
| `vendors:view` | ● | ● | ● | ● | · | · | ● | · | ● | · |
| `vendors:manage` | ● | ● | ● | ● | · | · | · | · | ● | · |
| `pos:create` | ● | ● | ● | ● | · | · | ● | · | · | · |
| `pos:approve` | ● | ● | ● | · | · | · | · | · | ● | · |
| `pos:receive` | ● | ● | ● | ● | · | · | ● | · | · | · |
| `invoices:enter` | ● | ● | ● | ● | · | · | ● | · | ● | · |
| `invoices:approve` | ● | ● | ● | · | · | · | · | · | ● | · |
| `marketing:sites` | ● | ● | ● | · | · | · | · | · | · | ● |
| `marketing:syndication` | ● | ● | ● | · | · | · | · | · | · | ● |
| `marketing:campaigns` | ● | ● | ● | · | · | · | · | · | · | ● |
| `ai:view` | ● | ● | ● | ● | ● | ● | ● | · | · | ● |
| `ai:configure` | ● | ● | ● | · | · | · | · | · | · | · |
| `ai:approve` | ● | ● | ● | ● | · | · | · | · | · | · |
| `dev:console` | ● | ● | · | · | · | · | · | · | · | · |

## Role intents

- **Platform Admin** — every permission (platform operations)
- **Org Admin** — 83 permissions
- **Regional Manager** — 68 permissions
- **Property Manager** — 57 permissions
- **Assistant Manager** — 29 permissions
- **Leasing Agent** — 17 permissions
- **Maintenance Supervisor** — 21 permissions
- **Maintenance Tech** — 7 permissions
- **Accountant** — 42 permissions
- **Marketing Manager** — 14 permissions
