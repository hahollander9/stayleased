-- ============================================================
-- StayLeased schema. Written Postgres-compatible (TEXT/INTEGER, no
-- SQLite-only features); money is INTEGER cents; dates are
-- TEXT 'YYYY-MM-DD'; timestamps TEXT ISO-8601 UTC; JSON in TEXT.
-- Executed idempotently at boot (CREATE TABLE IF NOT EXISTS).
-- ============================================================

-- ---------- tenancy & identity ----------

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  business_date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'demo', -- demo (simulated world) | live (real customer org)
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  region TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  kind TEXT NOT NULL DEFAULT 'staff', -- staff|resident|vendor|applicant|guarantor|platform
  vendor_id TEXT,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id, kind);

CREATE TABLE IF NOT EXISTS role_assignments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'org', -- org|properties
  property_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_user ON role_assignments(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  impersonator_user_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  user_id TEXT NOT NULL,
  user_name TEXT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  changes TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(org_id, entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(org_id, at);

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  business_date TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_org ON domain_events(org_id, type, at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  describe TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_date TEXT,
  last_status TEXT,
  last_ms INTEGER,
  last_error TEXT,
  UNIQUE(org_id, key)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  ms INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobruns ON job_runs(org_id, job_key, at);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["*"]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|retrying|ok|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_code INTEGER,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whd ON webhook_deliveries(org_id, status, next_attempt_at);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'staff', -- staff|resident|vendor|public
  owner_user_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_entity ON files(org_id, entity, entity_id);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_id, property_id, key)
);

CREATE TABLE IF NOT EXISTS sim_state (
  org_id TEXT PRIMARY KEY,
  dials TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT,
  channel TEXT NOT NULL, -- email|sms
  direction TEXT NOT NULL DEFAULT 'out', -- out|in
  to_addr TEXT NOT NULL,
  to_user_id TEXT,
  to_name TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  template_key TEXT,
  entity TEXT,
  entity_id TEXT,
  thread_id TEXT,
  person_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  sent_by TEXT,
  business_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox ON outbox_messages(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_person ON outbox_messages(org_id, person_id, created_at);

-- ---------- physical assets ----------

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  portfolio_id TEXT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'multifamily', -- multifamily|student|affordable|military|commercial|manufactured
  address1 TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Denver',
  phone TEXT,
  email TEXT,
  year_built INTEGER,
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 1,
  operating_bank_account_id TEXT,
  deposit_bank_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  marketing TEXT NOT NULL DEFAULT '{}', -- CMS content JSON (M4)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_props_org ON properties(org_id);

CREATE TABLE IF NOT EXISTS buildings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  address1 TEXT,
  floors INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bldg_prop ON buildings(property_id);

CREATE TABLE IF NOT EXISTS floorplans (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  beds INTEGER NOT NULL,
  baths REAL NOT NULL,
  sqft INTEGER NOT NULL,
  market_rent_cents INTEGER NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fp_prop ON floorplans(property_id);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties(id),
  building_id TEXT REFERENCES buildings(id),
  floorplan_id TEXT REFERENCES floorplans(id),
  unit_number TEXT NOT NULL,
  floor INTEGER NOT NULL DEFAULT 1,
  sqft INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'vacant_ready', -- vacant_ready|vacant_not_ready|occupied|notice|down|model
  market_rent_cents INTEGER NOT NULL,
  amenities TEXT NOT NULL DEFAULT '[]', -- [{name, premium_cents}]
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(property_id, unit_number)
);
CREATE INDEX IF NOT EXISTS idx_units_prop ON units(org_id, property_id, status);

CREATE TABLE IF NOT EXISTS amenity_spaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL,
  description TEXT,
  bookable INTEGER NOT NULL DEFAULT 1,
  capacity INTEGER,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  max_hours INTEGER NOT NULL DEFAULT 4,
  open_time TEXT NOT NULL DEFAULT '08:00',
  close_time TEXT NOT NULL DEFAULT '22:00',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rentable_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties(id),
  kind TEXT NOT NULL, -- parking|garage|storage|pet
  label TEXT NOT NULL,
  monthly_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'available', -- available|assigned|down
  assigned_lease_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(property_id, label)
);
CREATE INDEX IF NOT EXISTS idx_ri_prop ON rentable_items(org_id, property_id, kind, status);

-- ---------- leases (core spine; lifecycle wired across phases 2-9) ----------

CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL REFERENCES properties(id),
  unit_id TEXT NOT NULL REFERENCES units(id),
  household_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|out_for_signature|partially_signed|fully_executed|active|month_to_month|notice|ended|renewed|canceled
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  move_in_date TEXT,
  move_out_date TEXT,
  notice_date TEXT,
  mtm_since TEXT,
  rent_cents INTEGER NOT NULL,
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  deposit_alternative INTEGER NOT NULL DEFAULT 0,
  term_months INTEGER NOT NULL DEFAULT 12,
  application_id TEXT,
  renewal_of_lease_id TEXT,
  template_id TEXT,
  packet_file_id TEXT,
  esign_request_id TEXT,
  bed_label TEXT, -- student by-the-bed leases (M18)
  billing_start_date TEXT, -- migration conversion: recurring billing begins here
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leases_unit ON leases(org_id, unit_id, status);
CREATE INDEX IF NOT EXISTS idx_leases_prop ON leases(org_id, property_id, status);
CREATE INDEX IF NOT EXISTS idx_leases_end ON leases(org_id, end_date);

CREATE TABLE IF NOT EXISTS lease_charges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lease_id TEXT NOT NULL REFERENCES leases(id),
  kind TEXT NOT NULL, -- rent|pet_rent|parking|garage|storage|utility_flat|concession|mtm_premium|insurance|other
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  gl_account_code TEXT,
  rentable_item_id TEXT,
  start_date TEXT,
  end_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lc_lease ON lease_charges(org_id, lease_id);

-- ---------- people in residence ----------

CREATE TABLE IF NOT EXISTS residents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  user_id TEXT, -- portal account (users.kind='resident')
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  kind TEXT NOT NULL DEFAULT 'adult', -- adult|occupant|guarantor
  employer TEXT,
  monthly_income_cents INTEGER,
  ssn_last4 TEXT, -- fake data only
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_res_org ON residents(org_id, property_id);
CREATE INDEX IF NOT EXISTS idx_res_user ON residents(user_id);

CREATE TABLE IF NOT EXISTS household_members (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lease_id TEXT NOT NULL REFERENCES leases(id),
  resident_id TEXT NOT NULL REFERENCES residents(id),
  role TEXT NOT NULL DEFAULT 'primary', -- primary|co|occupant|guarantor
  created_at TEXT NOT NULL,
  UNIQUE(lease_id, resident_id)
);
CREATE INDEX IF NOT EXISTS idx_hm_lease ON household_members(org_id, lease_id);
CREATE INDEX IF NOT EXISTS idx_hm_res ON household_members(resident_id);

CREATE TABLE IF NOT EXISTS pets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  name TEXT NOT NULL,
  species TEXT NOT NULL, -- dog|cat|other
  breed TEXT,
  weight_lbs INTEGER,
  rentable_item_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  plate TEXT NOT NULL,
  state TEXT,
  rentable_item_id TEXT,
  created_at TEXT NOT NULL
);

-- ---------- money: GL ----------

CREATE TABLE IF NOT EXISTS gl_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL, -- asset|liability|equity|income|expense
  is_control TEXT, -- ar|deposits|ap|cash|deposit_cash|clearing|prepaid
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE(org_id, code)
);

CREATE TABLE IF NOT EXISTS posting_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  event_key TEXT NOT NULL, -- e.g. charge.rent, payment.received
  description TEXT NOT NULL,
  dr_code TEXT NOT NULL,
  cr_code TEXT NOT NULL,
  UNIQUE(org_id, event_key)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  date TEXT NOT NULL,
  period_key TEXT NOT NULL, -- YYYY-MM
  basis TEXT NOT NULL DEFAULT 'accrual', -- accrual|cash
  memo TEXT,
  source_kind TEXT NOT NULL, -- charge|payment|application|settlement|nsf|deposit|manual|invoice|payrun|writeoff|utility|adjustment|recurring|intercompany
  source_id TEXT,
  reversal_of TEXT,
  approved_by TEXT,
  created_by TEXT NOT NULL,
  posted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_je_prop ON journal_entries(org_id, property_id, period_key, basis);
CREATE INDEX IF NOT EXISTS idx_je_src ON journal_entries(org_id, source_kind, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id),
  account_code TEXT NOT NULL,
  debit_cents INTEGER NOT NULL DEFAULT 0,
  credit_cents INTEGER NOT NULL DEFAULT 0,
  property_id TEXT NOT NULL,
  memo TEXT
);
CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_acct ON journal_lines(org_id, property_id, account_code);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open|closed
  checklist TEXT NOT NULL DEFAULT '{}',
  closed_at TEXT,
  closed_by TEXT,
  UNIQUE(org_id, property_id, period_key)
);

-- ---------- money: resident subledger (charges now; payments in Phase 3) ----------

CREATE TABLE IF NOT EXISTS charges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL REFERENCES leases(id),
  kind TEXT NOT NULL, -- rent|late_fee|utility|parking|garage|storage|pet_rent|application_fee|admin_fee|amenity|nsf_fee|insurance|mtm_premium|concession|deposit|damage|other
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, -- negative = credit memo/concession
  date TEXT NOT NULL, -- charge date (business date posted)
  due_date TEXT NOT NULL,
  month_key TEXT, -- for recurring idempotency
  lease_charge_id TEXT, -- schedule line that generated it
  source TEXT NOT NULL DEFAULT 'oneoff', -- recurring|move_in|late_fee|oneoff|utility|nsf|deposit|damage|reward
  status TEXT NOT NULL DEFAULT 'active', -- active|voided|written_off
  je_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, lease_id, lease_charge_id, month_key)
);
CREATE INDEX IF NOT EXISTS idx_charges_lease ON charges(org_id, lease_id, date);
CREATE INDEX IF NOT EXISTS idx_charges_prop ON charges(org_id, property_id, month_key);

-- ---------- money: payments & receivables (M8; filled from Phase 3) ----------

CREATE TABLE IF NOT EXISTS payment_method_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL, -- resident portal user
  lease_id TEXT,
  kind TEXT NOT NULL, -- ach|card
  label TEXT NOT NULL, -- "Visa ····4242" / "Checking ····8812"
  token TEXT NOT NULL, -- simulator token
  behavior TEXT NOT NULL DEFAULT 'ok', -- simulator: ok|nsf|declined (deterministic test cards)
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pmt_user ON payment_method_tokens(org_id, user_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  payer_resident_id TEXT,
  method TEXT NOT NULL, -- ach|card|check|money_order|cash_equivalent|lockbox|credit
  method_token_id TEXT,
  reference TEXT, -- check #, processor ref
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0, -- convenience fee (income)
  status TEXT NOT NULL DEFAULT 'pending', -- pending|settled|nsf|chargeback|voided|failed
  received_date TEXT NOT NULL,
  settle_date TEXT, -- expected/actual settlement
  settlement_batch_id TEXT,
  nsf_date TEXT,
  autopay INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pay_lease ON payments(org_id, lease_id, received_date);
CREATE INDEX IF NOT EXISTS idx_pay_status ON payments(org_id, status, settle_date);

CREATE TABLE IF NOT EXISTS payment_applications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  charge_id TEXT NOT NULL REFERENCES charges(id),
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pa_payment ON payment_applications(payment_id);
CREATE INDEX IF NOT EXISTS idx_pa_charge ON payment_applications(charge_id);

CREATE TABLE IF NOT EXISTS autopay_enrollments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  method_token_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'full_balance', -- full_balance|fixed
  fixed_amount_cents INTEGER,
  day_of_month INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  end_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ap_lease ON autopay_enrollments(org_id, lease_id, active);

CREATE TABLE IF NOT EXISTS settlement_batches (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  batch_date TEXT NOT NULL,
  method_group TEXT NOT NULL, -- ach|card|check
  total_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'deposited', -- pending|deposited|reconciled
  bank_txn_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'overpayment', -- overpayment|deposit
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'check',
  reference TEXT,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_plans (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- proposed|active|completed|defaulted|canceled
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_plan_installments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES payment_plans(id),
  due_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|paid|missed
  payment_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_cases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  balance_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open|exported|closed
  agency TEXT,
  opened_date TEXT NOT NULL,
  exported_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deposit_activity (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- hold|interest|apply|refund
  amount_cents INTEGER NOT NULL, -- positive=held increases; apply/refund negative
  date TEXT NOT NULL,
  memo TEXT,
  payment_id TEXT,
  refund_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_da_lease ON deposit_activity(org_id, lease_id);

CREATE TABLE IF NOT EXISTS delinquency_notes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note', -- note|promise_to_pay|contact
  body TEXT NOT NULL,
  promise_date TEXT,
  promise_amount_cents INTEGER,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- ---------- facilities (portal intake now; full M10 in Phase 5) ----------

CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT,
  lease_id TEXT,
  resident_id TEXT,
  category TEXT NOT NULL, -- plumbing|electrical|hvac|appliance|doors_locks|pest|grounds|safety|turn|pm|other
  priority TEXT NOT NULL DEFAULT 'normal', -- emergency|high|normal|low
  status TEXT NOT NULL DEFAULT 'new', -- new|triaged|assigned|scheduled|in_progress|on_hold|completed|canceled|reopened
  summary TEXT NOT NULL,
  description TEXT,
  permission_to_enter INTEGER NOT NULL DEFAULT 0,
  pet_on_premises INTEGER NOT NULL DEFAULT 0,
  preferred_times TEXT,
  source TEXT NOT NULL DEFAULT 'portal', -- portal|staff|phone|ai|pm|turn|inspection
  assigned_to_user_id TEXT,
  vendor_id TEXT,
  scheduled_date TEXT,
  sla_hours INTEGER,
  sla_due TEXT,
  created_date TEXT NOT NULL,
  completed_at TEXT,
  completed_date TEXT,
  rating INTEGER,
  rating_comment TEXT,
  turn_id TEXT,
  pm_schedule_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wo_prop ON work_orders(org_id, property_id, status);
CREATE INDEX IF NOT EXISTS idx_wo_lease ON work_orders(org_id, lease_id);
CREATE INDEX IF NOT EXISTS idx_wo_assignee ON work_orders(org_id, assigned_to_user_id, status);

CREATE TABLE IF NOT EXISTS wo_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  kind TEXT NOT NULL, -- status|note|photo|assign|schedule|material|labor|message
  body TEXT,
  meta TEXT,
  actor TEXT,
  visible_to_resident INTEGER NOT NULL DEFAULT 1,
  at TEXT NOT NULL,
  business_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_woe ON wo_events(work_order_id, at);

-- ---------- portal self-service ----------

CREATE TABLE IF NOT EXISTS household_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- occupant|pet|vehicle
  payload TEXT NOT NULL, -- JSON details
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|denied
  decided_by TEXT,
  decided_at TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT, -- null = org-wide
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  starts_date TEXT NOT NULL,
  ends_date TEXT,
  echo_email INTEGER NOT NULL DEFAULT 0,
  echo_sms INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS amenity_reservations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES amenity_spaces(id),
  lease_id TEXT NOT NULL,
  resident_id TEXT,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  guests INTEGER NOT NULL DEFAULT 1,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  charge_id TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed|canceled
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_amres ON amenity_reservations(space_id, date);

-- ---------- facilities: vendors, PM, turns, inspections, inventory ----------

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL, -- plumbing|electrical|hvac|cleaning|landscaping|painting|locks|flooring|pest|roofing|general|restoration
  phone TEXT,
  email TEXT,
  address TEXT,
  tin_last4 TEXT, -- fake W-9 data
  w9_on_file INTEGER NOT NULL DEFAULT 0,
  is_1099 INTEGER NOT NULL DEFAULT 1,
  coi_expiry TEXT, -- insurance certificate expiry
  banking TEXT, -- simulated ACH details JSON
  diversity_tags TEXT NOT NULL DEFAULT '[]',
  approved_property_ids TEXT NOT NULL DEFAULT '[]', -- empty = all
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendors ON vendors(org_id, category);

CREATE TABLE IF NOT EXISTS wo_materials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  item_id TEXT,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_cost_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wom ON wo_materials(work_order_id);

CREATE TABLE IF NOT EXISTS wo_labor (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  work_order_id TEXT NOT NULL REFERENCES work_orders(id),
  user_id TEXT NOT NULL,
  hours REAL NOT NULL,
  rate_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wol ON wo_labor(work_order_id);

CREATE TABLE IF NOT EXISTS pm_schedules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  instructions TEXT,
  freq_days INTEGER NOT NULL,
  next_due TEXT NOT NULL,
  assigned_to_user_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  lease_id TEXT, -- vacating lease
  move_out_date TEXT NOT NULL,
  target_ready_date TEXT NOT NULL,
  next_move_in_date TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|in_progress|ready|canceled
  completed_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns ON turns(org_id, property_id, status);

CREATE TABLE IF NOT EXISTS turn_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  seq INTEGER NOT NULL,
  name TEXT NOT NULL, -- inspect|punch|paint|clean|floors|final_qc
  status TEXT NOT NULL DEFAULT 'pending', -- pending|in_progress|done|skipped
  assigned_to_user_id TEXT,
  vendor_id TEXT,
  est_cost_cents INTEGER NOT NULL DEFAULT 0,
  actual_cost_cents INTEGER NOT NULL DEFAULT 0,
  completed_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turntasks ON turn_tasks(turn_id, seq);

CREATE TABLE IF NOT EXISTS inspections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  lease_id TEXT,
  type TEXT NOT NULL, -- move_in|move_out|quarterly|grounds
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress|completed
  inspector_user_id TEXT,
  date TEXT NOT NULL,
  notes TEXT,
  damages_posted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_insp ON inspections(org_id, unit_id, type);

CREATE TABLE IF NOT EXISTS inspection_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  area TEXT NOT NULL,
  item TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'good', -- good|fair|damaged|missing
  note TEXT,
  photo_file_id TEXT,
  charge_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inspitems ON inspection_items(inspection_id);

CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  bin TEXT,
  unit_cost_cents INTEGER NOT NULL,
  on_hand REAL NOT NULL DEFAULT 0,
  min_qty REAL NOT NULL DEFAULT 0,
  max_qty REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(property_id, sku)
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  kind TEXT NOT NULL, -- usage|receipt|adjustment
  qty REAL NOT NULL, -- negative = out
  work_order_id TEXT,
  po_id TEXT,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  created_by TEXT,
  at TEXT NOT NULL,
  business_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_stockmoves ON stock_moves(item_id, at);

-- ---------- CRM / leasing funnel (M3) ----------

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  source TEXT NOT NULL, -- zillow|apartments_com|facebook|craigslist|google|website|walk_in|phone|referral
  channel TEXT NOT NULL DEFAULT 'email', -- email|sms|phone|web|in_person
  status TEXT NOT NULL DEFAULT 'new', -- new|contacted|touring|toured|applied|leased|lost
  desired_move_in TEXT,
  beds INTEGER,
  budget_cents INTEGER,
  message TEXT,
  assigned_to_user_id TEXT,
  application_id TEXT,
  lease_id TEXT,
  lost_reason TEXT,
  last_activity_at TEXT,
  created_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_prop ON leads(org_id, property_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(org_id, email);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(org_id, phone);

CREATE TABLE IF NOT EXISTS lead_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  kind TEXT NOT NULL, -- inquiry|email_out|email_in|sms_out|sms_in|call|note|tour_scheduled|tour_completed|tour_noshow|quote|application|status
  body TEXT,
  actor TEXT,
  at TEXT NOT NULL,
  business_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_leadev ON lead_events(lead_id, at);

CREATE TABLE IF NOT EXISTS tours (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  unit_id TEXT,
  type TEXT NOT NULL DEFAULT 'in_person', -- in_person|self_guided|virtual
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  agent_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|completed|no_show|canceled
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tours ON tours(org_id, property_id, date);

CREATE TABLE IF NOT EXISTS followup_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  kind TEXT NOT NULL, -- first_response|day_1|day_3|day_7|day_14|custom
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open|done|skipped
  assigned_to_user_id TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fut ON followup_tasks(org_id, status, due_date);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  unit_id TEXT NOT NULL,
  term_months INTEGER NOT NULL,
  move_in TEXT NOT NULL,
  rent_cents INTEGER NOT NULL,
  items TEXT NOT NULL DEFAULT '[]', -- [{label, monthly_cents}]
  concession_note TEXT,
  total_monthly_cents INTEGER NOT NULL,
  expires_date TEXT,
  status TEXT NOT NULL DEFAULT 'sent', -- draft|sent|accepted|expired
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes ON quotes(org_id, lead_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT, -- null = org-wide
  source TEXT NOT NULL,
  monthly_cost_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS call_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT,
  lead_id TEXT,
  resident_id TEXT,
  direction TEXT NOT NULL DEFAULT 'inbound',
  from_number TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  outcome TEXT, -- answered|voicemail|missed
  notes TEXT,
  transcript TEXT, -- fixture transcripts feed ELI call analysis (M17)
  ai_summary TEXT,
  ai_sentiment TEXT,
  ai_tags TEXT,
  handled_by TEXT,
  at TEXT NOT NULL,
  business_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls ON call_logs(org_id, business_date);

-- ---------- revenue intelligence (M13; populated in Phase 14) ----------

CREATE TABLE IF NOT EXISTS price_recommendations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  date TEXT NOT NULL,
  term_months INTEGER NOT NULL DEFAULT 12,
  current_rent_cents INTEGER NOT NULL,
  recommended_rent_cents INTEGER NOT NULL,
  accepted_rent_cents INTEGER,
  factors TEXT NOT NULL DEFAULT '[]', -- [{label, delta_cents}]
  status TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|overridden|expired
  override_reason TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pricerec ON price_recommendations(org_id, unit_id, date, term_months);

-- (comp_sets / comp_observations live in the Phase 14 section below)

-- ---------- marketing / syndication (M4) ----------

CREATE TABLE IF NOT EXISTS listing_publications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  channel TEXT NOT NULL, -- zillow|apartments_com|craigslist|facebook
  status TEXT NOT NULL DEFAULT 'active', -- active|paused
  published_at TEXT NOT NULL,
  UNIQUE(unit_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_listpub ON listing_publications(org_id, property_id, channel);

-- ---------- applications & screening (M5) ----------

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  lead_id TEXT,
  quote_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|submitted|screening|review|approved|approved_conditions|declined|canceled|converted
  term_months INTEGER NOT NULL DEFAULT 12,
  move_in TEXT NOT NULL,
  rent_cents INTEGER NOT NULL,
  app_fee_cents INTEGER NOT NULL DEFAULT 0,
  hold_deposit_cents INTEGER NOT NULL DEFAULT 0,
  fees_paid INTEGER NOT NULL DEFAULT 0,
  fee_payment_ref TEXT,
  hold_expires TEXT,
  criteria_version INTEGER,
  recommendation TEXT, -- approve|conditions|decline (computed)
  recommendation_detail TEXT, -- json {reasons:[], conditions:[]}
  decision TEXT, -- json {action, by, byName, reason, overrode, at}
  submitted_at TEXT,
  lease_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apps ON applications(org_id, property_id, status);

CREATE TABLE IF NOT EXISTS applicants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  application_id TEXT NOT NULL REFERENCES applications(id),
  kind TEXT NOT NULL DEFAULT 'primary', -- primary|co|guarantor|occupant
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  phone TEXT,
  ssn_last4 TEXT, -- fake data only
  current_address TEXT,
  employer TEXT,
  income_monthly_cents INTEGER,
  invite_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'invited', -- invited|started|complete
  step INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_applicants ON applicants(application_id);

CREATE TABLE IF NOT EXISTS screening_reports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  applicant_id TEXT NOT NULL REFERENCES applicants(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending|complete
  credit_score INTEGER,
  credit_band TEXT, -- excellent|good|fair|poor|thin_file
  criminal_flag INTEGER NOT NULL DEFAULT 0,
  eviction_flag INTEGER NOT NULL DEFAULT 0,
  eviction_years_ago INTEGER,
  thin_file INTEGER NOT NULL DEFAULT 0,
  fraud_flags TEXT NOT NULL DEFAULT '[]',
  income_extracted_cents INTEGER, -- DocOcr result
  requested_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_screening ON screening_reports(application_id, status);

CREATE TABLE IF NOT EXISTS criteria_versions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  criteria TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, property_id, version)
);

-- ---------- leases: templates, e-sign, renewals, checklists (M6) ----------

CREATE TABLE IF NOT EXISTS lease_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL DEFAULT '', -- '' = org default
  state TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL, -- paragraphs with {{merge_fields}}
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS addenda_library (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  condition_key TEXT, -- has_pet|has_parking|has_storage|has_guarantor|concession|student|always
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, key)
);

CREATE TABLE IF NOT EXISTS signature_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lease', -- lease|renewal|guaranty
  status TEXT NOT NULL DEFAULT 'out', -- out|completed|canceled
  mode TEXT NOT NULL DEFAULT 'parallel_then_counter',
  doc_file_id TEXT NOT NULL, -- unsigned packet (immutable)
  doc_sha256 TEXT NOT NULL,
  signed_file_id TEXT, -- executed packet with signature + certificate pages
  events TEXT NOT NULL DEFAULT '[]', -- tamper-evident chain [{at, who, action, hash}]
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sigreq ON signature_requests(org_id, lease_id);

CREATE TABLE IF NOT EXISTS signature_signers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES signature_requests(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'resident', -- resident|guarantor|countersigner
  token TEXT NOT NULL UNIQUE,
  order_idx INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|signed|declined
  signature_kind TEXT, -- typed|drawn
  signature_text TEXT,
  signature_file_id TEXT,
  initials TEXT,
  signed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signers ON signature_signers(request_id);

CREATE TABLE IF NOT EXISTS renewal_offers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  options TEXT NOT NULL, -- [{term_months, rent_cents}]
  status TEXT NOT NULL DEFAULT 'sent', -- draft|sent|accepted|countered|declined|expired
  accepted_term INTEGER,
  accepted_rent_cents INTEGER,
  counter_note TEXT,
  new_lease_id TEXT,
  expires_date TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_renewals ON renewal_offers(org_id, lease_id, status);

CREATE TABLE IF NOT EXISTS move_checklists (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'move_in', -- move_in|move_out
  items TEXT NOT NULL, -- [{key,label,done,due,who}]
  created_at TEXT NOT NULL
);

-- ---------- Phase 10: accounting deep (M9 complete) ----------

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT, -- NULL = org-level account
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'operating', -- operating|deposits
  gl_account TEXT NOT NULL, -- 1010|1020
  bank_name TEXT NOT NULL DEFAULT 'First Simulated Bank',
  last4 TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bankacct ON bank_accounts(org_id, property_id);

CREATE TABLE IF NOT EXISTS bank_txns (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, -- positive deposit, negative withdrawal
  description TEXT NOT NULL,
  ref TEXT, -- stable feed reference for idempotent import + exact matching
  kind TEXT NOT NULL DEFAULT 'other', -- deposit|check|ach|fee|interest|adjustment|other
  status TEXT NOT NULL DEFAULT 'unmatched', -- unmatched|matched|excluded
  matched_kind TEXT, -- settlement|ap_payment|je|manual
  matched_id TEXT,
  recon_id TEXT,
  imported_at TEXT NOT NULL,
  UNIQUE(bank_account_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_banktxn ON bank_txns(org_id, bank_account_id, date, status);

CREATE TABLE IF NOT EXISTS bank_recons (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  period_key TEXT NOT NULL, -- YYYY-MM statement month
  statement_open_cents INTEGER NOT NULL DEFAULT 0,
  statement_close_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress|completed
  difference_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  completed_by TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(bank_account_id, period_key)
);

CREATE TABLE IF NOT EXISTS vendor_invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  invoice_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|pending_approval|approved|paid|void
  total_cents INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual', -- manual|workorder|turn|po|recurring
  source_id TEXT,
  je_id TEXT, -- accrual JE at approval
  approved_by TEXT,
  approved_at TEXT,
  paid_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, vendor_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_vinv ON vendor_invoices(org_id, property_id, status, invoice_date);

CREATE TABLE IF NOT EXISTS vendor_invoice_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL REFERENCES vendor_invoices(id),
  gl_account TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  property_id TEXT NOT NULL, -- line-level property for split coding
  unit_id TEXT,
  project_id TEXT, -- capital project (job costing)
  cost_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vinvline ON vendor_invoice_lines(org_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_vinvline_proj ON vendor_invoice_lines(org_id, project_id);

CREATE TABLE IF NOT EXISTS ap_payment_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  run_date TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'check', -- check|ach
  status TEXT NOT NULL DEFAULT 'processed', -- processed|void
  total_cents INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ap_payments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES ap_payment_runs(id),
  invoice_id TEXT NOT NULL REFERENCES vendor_invoices(id),
  vendor_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL, -- check|ach
  check_number TEXT, -- positive-pay register identity (also set for ach as ref)
  status TEXT NOT NULL DEFAULT 'issued', -- issued|cleared|void|reissued
  cleared_date TEXT,
  je_id TEXT,
  void_reason TEXT,
  voided_at TEXT,
  reissued_payment_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appay ON ap_payments(org_id, status, check_number);

CREATE TABLE IF NOT EXISTS recurring_jes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  name TEXT NOT NULL,
  memo TEXT,
  lines TEXT NOT NULL, -- [{account, debit_cents?, credit_cents?, memo?}]
  day_of_month INTEGER NOT NULL DEFAULT 1,
  start_month TEXT NOT NULL, -- YYYY-MM
  end_month TEXT, -- inclusive; NULL = forever
  last_posted_month TEXT,
  basis TEXT NOT NULL DEFAULT 'both', -- accrual|cash|both
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_jes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  date TEXT NOT NULL,
  memo TEXT NOT NULL,
  lines TEXT NOT NULL, -- [{account, debit_cents?, credit_cents?, memo?}]
  basis TEXT NOT NULL DEFAULT 'both',
  status TEXT NOT NULL DEFAULT 'pending', -- pending|posted|rejected
  requested_by TEXT,
  decided_by TEXT,
  decided_at TEXT,
  reject_reason TEXT,
  je_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|approved
  notes TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, property_id, year, version)
);

CREATE TABLE IF NOT EXISTS budget_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  budget_id TEXT NOT NULL REFERENCES budgets(id),
  gl_account TEXT NOT NULL,
  months TEXT NOT NULL, -- [12] cents, Jan..Dec
  note TEXT,
  UNIQUE(budget_id, gl_account)
);

CREATE TABLE IF NOT EXISTS capital_projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  cost_codes TEXT NOT NULL DEFAULT '[]', -- [{code,label,budget_cents}]
  status TEXT NOT NULL DEFAULT 'active', -- active|completed|on_hold
  start_date TEXT,
  target_date TEXT,
  created_at TEXT NOT NULL
);

-- ---------- Phase 11: utilities (M11) + insurance & risk (M12) ----------

CREATE TABLE IF NOT EXISTS meters (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT, -- NULL = common-area meter
  service TEXT NOT NULL, -- electric|water|gas|trash
  serial TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meters ON meters(org_id, property_id, service);

CREATE TABLE IF NOT EXISTS meter_reads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  meter_id TEXT NOT NULL REFERENCES meters(id),
  month_key TEXT NOT NULL, -- usage month
  read_date TEXT NOT NULL,
  usage_qty REAL NOT NULL, -- kWh / gal / therms
  source TEXT NOT NULL DEFAULT 'feed', -- feed|estimate|manual
  anomaly TEXT, -- spike|missed|NULL
  status TEXT NOT NULL DEFAULT 'ok', -- ok|review|estimated
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(meter_id, month_key)
);
CREATE INDEX IF NOT EXISTS idx_reads ON meter_reads(org_id, month_key, status);

CREATE TABLE IF NOT EXISTS utility_provider_invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  service TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  usage_month TEXT NOT NULL, -- YYYY-MM
  total_cents INTEGER NOT NULL,
  usage_qty REAL NOT NULL DEFAULT 0,
  rate_note TEXT, -- $/unit summary for rate history
  weather_note TEXT,
  vendor_invoice_id TEXT, -- AP invoice (M9)
  created_at TEXT NOT NULL,
  UNIQUE(org_id, property_id, service, usage_month)
);

CREATE TABLE IF NOT EXISTS rubs_configs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  service TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'sqft', -- submeter|sqft|occupants|flat|hybrid
  flat_fee_cents INTEGER NOT NULL DEFAULT 0,
  admin_fee_cents INTEGER NOT NULL DEFAULT 300, -- per bill, capped by law-ish
  common_deduct_pct REAL NOT NULL DEFAULT 10, -- % held back as common-area (not billed)
  bill_vacant INTEGER NOT NULL DEFAULT 0, -- vacant share always stays with property
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(org_id, property_id, service)
);

CREATE TABLE IF NOT EXISTS rubs_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  service TEXT NOT NULL,
  usage_month TEXT NOT NULL,
  provider_invoice_id TEXT REFERENCES utility_provider_invoices(id),
  method TEXT NOT NULL,
  total_cents INTEGER NOT NULL, -- provider invoice total
  billable_cents INTEGER NOT NULL, -- after common deduction
  recovered_cents INTEGER NOT NULL DEFAULT 0,
  vacant_cents INTEGER NOT NULL DEFAULT 0,
  common_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'preview', -- preview|posted
  posted_at TEXT,
  posted_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, property_id, service, usage_month)
);

CREATE TABLE IF NOT EXISTS rubs_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES rubs_runs(id),
  unit_id TEXT NOT NULL,
  lease_id TEXT, -- NULL = vacant share
  basis_label TEXT NOT NULL, -- "812 sqft · 26/30 days" etc
  occupied_days INTEGER NOT NULL DEFAULT 0,
  month_days INTEGER NOT NULL DEFAULT 30,
  amount_cents INTEGER NOT NULL,
  admin_fee_cents INTEGER NOT NULL DEFAULT 0,
  charge_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rubslines ON rubs_lines(org_id, run_id);

CREATE TABLE IF NOT EXISTS insurance_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'third_party', -- third_party|master
  carrier TEXT NOT NULL,
  policy_number TEXT NOT NULL,
  liability_cents INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT, -- NULL for master (evergreen while enrolled)
  status TEXT NOT NULL DEFAULT 'pending_verification', -- pending_verification|active|rejected|lapsed|canceled
  verified_at TEXT,
  file_id TEXT,
  source TEXT NOT NULL DEFAULT 'upload', -- upload|enroll|auto_enroll
  reminder_stage INTEGER NOT NULL DEFAULT 0, -- lapse reminders sent (0-3)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inspol ON insurance_policies(org_id, lease_id, status);

CREATE TABLE IF NOT EXISTS deposit_alternatives (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'SuretyShield (simulated)',
  mode TEXT NOT NULL DEFAULT 'monthly', -- monthly|one_time
  fee_cents INTEGER NOT NULL, -- monthly fee or one-time premium
  coverage_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active|claimed|canceled
  claim_cents INTEGER NOT NULL DEFAULT 0,
  claim_date TEXT,
  enrolled_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(lease_id)
);

CREATE TABLE IF NOT EXISTS guaranty_contracts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  lease_id TEXT,
  provider TEXT NOT NULL DEFAULT 'Anchor Guaranty (simulated)',
  fee_cents INTEGER NOT NULL, -- one-time % of monthly rent
  coverage_months INTEGER NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'active', -- active|expired|canceled
  esign_request_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(application_id)
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT,
  kind TEXT NOT NULL, -- water|fire|injury|theft|liability|mold|other
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  est_loss_cents INTEGER NOT NULL DEFAULT 0,
  claim_number TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open|monitoring|closed
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- ---------- Phase 12: procure to pay (M16) ----------

CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL, -- maintenance|turn|office|grounds|appliance|safety
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_price_cents INTEGER NOT NULL,
  preferred_vendor_id TEXT,
  gl_account TEXT NOT NULL DEFAULT '5910',
  inventory_sku TEXT, -- receiving increments matching inventory_items
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  po_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|pending_approval|approved|acknowledged|partially_received|received|closed|canceled
  memo TEXT,
  needed_by TEXT,
  source TEXT NOT NULL DEFAULT 'manual', -- manual|workorder|turn|project
  source_id TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  sent_at TEXT,
  acknowledged_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, po_number)
);
CREATE INDEX IF NOT EXISTS idx_po ON purchase_orders(org_id, status, vendor_id);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id),
  catalog_item_id TEXT,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  gl_account TEXT NOT NULL,
  project_id TEXT,
  cost_code TEXT,
  received_qty REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pol ON purchase_order_lines(org_id, po_id);

CREATE TABLE IF NOT EXISTS po_receipts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  po_id TEXT NOT NULL REFERENCES purchase_orders(id),
  date TEXT NOT NULL,
  note TEXT,
  received_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS po_receipt_lines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL REFERENCES po_receipts(id),
  po_line_id TEXT NOT NULL REFERENCES purchase_order_lines(id),
  qty REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_matches (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES vendor_invoices(id),
  po_id TEXT NOT NULL REFERENCES purchase_orders(id),
  status TEXT NOT NULL DEFAULT 'matched', -- matched|exception|overridden|rejected
  price_variance_cents INTEGER NOT NULL DEFAULT 0,
  qty_exception INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);

-- ---------- Phase 13: communications complete (M15) ----------

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT,
  person_kind TEXT NOT NULL, -- resident|lead|vendor
  person_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open|snoozed|closed
  assigned_to TEXT, -- user id
  snooze_until TEXT,
  needs_reply INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  last_snippet TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(org_id, person_kind, person_id)
);
CREATE INDEX IF NOT EXISTS idx_threads ON threads(org_id, status, needs_reply, last_message_at);

CREATE TABLE IF NOT EXISTS thread_notes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  body TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comm_prefs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  person_kind TEXT NOT NULL,
  person_id TEXT NOT NULL,
  email_optout INTEGER NOT NULL DEFAULT 0,
  sms_optout INTEGER NOT NULL DEFAULT 0,
  unsubscribe_token TEXT,
  updated_at TEXT,
  UNIQUE(org_id, person_kind, person_id)
);

CREATE TABLE IF NOT EXISTS message_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT, -- NULL = org-wide
  key TEXT NOT NULL, -- overrides a code template key, or custom:*
  category TEXT NOT NULL DEFAULT 'community', -- leasing|delinquency|renewals|maintenance|community
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sms TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgtpl ON message_templates(org_id, key, active);

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  filters TEXT NOT NULL, -- JSON: {propertyId, balanceOverCents, expiringDays, hasPet, autopay, delinquentBucket}
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mass_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  segment_id TEXT,
  filters TEXT NOT NULL, -- snapshot at schedule time
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sms_body TEXT,
  channels TEXT NOT NULL DEFAULT '["email"]', -- ["email","sms","portal"]
  scheduled_for TEXT NOT NULL, -- business date
  status TEXT NOT NULL DEFAULT 'scheduled', -- draft|scheduled|sending|sent|canceled
  sent_at TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mass_recipients (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  mass_id TEXT NOT NULL REFERENCES mass_messages(id),
  resident_id TEXT NOT NULL,
  lease_id TEXT,
  channel TEXT NOT NULL, -- email|sms|portal
  status TEXT NOT NULL DEFAULT 'pending', -- pending|sent|deferred_quiet|skipped_optout|skipped_no_address
  reason TEXT,
  outbox_id TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_massrcpt ON mass_recipients(org_id, mass_id, status);

-- ---------- Phase 14: revenue intelligence (M13) ----------

CREATE TABLE IF NOT EXISTS comp_sets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  name TEXT NOT NULL, -- comp community name
  distance_miles REAL NOT NULL DEFAULT 1,
  year_built INTEGER,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comp_observations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  comp_id TEXT NOT NULL REFERENCES comp_sets(id),
  month_key TEXT NOT NULL, -- YYYY-MM
  beds INTEGER NOT NULL,
  rent_cents INTEGER NOT NULL, -- observed effective rent
  concession_note TEXT,
  source TEXT NOT NULL DEFAULT 'market_sim', -- market_sim|manual
  created_at TEXT NOT NULL,
  UNIQUE(comp_id, month_key, beds)
);

CREATE TABLE IF NOT EXISTS price_changes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  date TEXT NOT NULL,
  old_cents INTEGER NOT NULL,
  new_cents INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'pricing_queue', -- pricing_queue|manual|renewal_batch
  recommendation_id TEXT,
  reason TEXT,
  changed_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pricechg ON price_changes(org_id, unit_id, date);

-- ---------- Phase 15: reporting & BI (M14) ----------

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  date TEXT NOT NULL,
  metrics TEXT NOT NULL, -- JSON: occupancy/exposure/delinquency/rent metrics for the day
  created_at TEXT NOT NULL,
  UNIQUE(property_id, date)
);
CREATE INDEX IF NOT EXISTS idx_snapshots ON metric_snapshots(org_id, property_id, date);

CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom', -- custom (builder) | canned (catalog report + params)
  dataset TEXT, -- custom: dataset key · canned: report key
  config TEXT NOT NULL DEFAULT '{}', -- columns/filters/group/sort/aggregates or canned params
  shared INTEGER NOT NULL DEFAULT 0,
  schedule TEXT, -- daily|weekly|monthly|NULL
  last_run_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_savedreports ON saved_reports(org_id, owner_user_id);

CREATE TABLE IF NOT EXISTS user_dashboards (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  layout TEXT NOT NULL, -- [{w, report, params, title}]
  updated_at TEXT NOT NULL
);

-- ---------- Phase 16: AI layer (M17) ----------

CREATE TABLE IF NOT EXISTS ai_actions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT,
  agent TEXT NOT NULL, -- leasing|maintenance|payments|renewals|call_analysis|content|ask
  entity TEXT,
  entity_id TEXT,
  title TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '{}', -- what the agent saw
  output TEXT NOT NULL DEFAULT '{}', -- {kind, draft, payload...}
  confidence REAL NOT NULL DEFAULT 0.9,
  autonomy TEXT NOT NULL, -- dial at decision time: draft|approve|auto
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed|approved|rejected|executed|auto_executed
  guardrail_note TEXT,
  decided_by TEXT,
  decided_at TEXT,
  executed_at TEXT,
  result TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aiactions ON ai_actions(org_id, status, agent, created_at);

-- ---------- Phase 17: vertical modes (M18) ----------

CREATE TABLE IF NOT EXISTS roommate_profiles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  application_id TEXT,
  person_name TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}', -- {sleep, clean, study, guests, smoke}
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS income_certs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  lease_id TEXT,
  kind TEXT NOT NULL DEFAULT 'initial', -- initial|annual
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress|complete
  due_date TEXT,
  household_size INTEGER NOT NULL DEFAULT 1,
  household_income_cents INTEGER NOT NULL DEFAULT 0,
  ami_pct INTEGER, -- computed band the household qualifies at
  checklist TEXT NOT NULL DEFAULT '[]', -- [{item, done}]
  completed_at TEXT,
  completed_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_certs ON income_certs(org_id, unit_id, kind, status);

CREATE TABLE IF NOT EXISTS rent_limits (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  ami_pct INTEGER NOT NULL,
  beds INTEGER NOT NULL,
  max_rent_cents INTEGER NOT NULL,
  UNIQUE(org_id, ami_pct, beds)
);

CREATE TABLE IF NOT EXISTS waitlist_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  position INTEGER NOT NULL, -- immutable ordering; skips are audited, never reordered
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  household_size INTEGER NOT NULL DEFAULT 1,
  income_cents INTEGER NOT NULL DEFAULT 0,
  preferences TEXT NOT NULL DEFAULT '{}', -- {beds, accessible, ...}
  status TEXT NOT NULL DEFAULT 'active', -- active|offered|housed|skipped|removed
  skip_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waitlist ON waitlist_entries(org_id, property_id, status, position);

CREATE TABLE IF NOT EXISTS pcs_breaks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  orders_file_id TEXT,
  report_date TEXT NOT NULL, -- date on the PCS orders
  termination_date TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- ---------- Phase 18: hardening — hot-path indexes ----------
CREATE INDEX IF NOT EXISTS idx_inspol_lease ON insurance_policies(lease_id, status, end_date);
CREATE INDEX IF NOT EXISTS idx_inspol_org ON insurance_policies(org_id, status, end_date);
CREATE INDEX IF NOT EXISTS idx_charges_due ON charges(lease_id, status, due_date);

-- ---------- working model: Migration Center staging ----------

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- rent_roll|vendors|residents|balances|lease_pdf
  filename TEXT,
  property_id TEXT, -- target property (rent rolls may instead group by a property column)
  new_property_name TEXT, -- create-and-import-into when set
  preset TEXT, -- detected source system (buildium|appfolio|yardi|...)
  headers TEXT NOT NULL DEFAULT '[]',
  mapping TEXT NOT NULL DEFAULT '{}', -- {cols:{i:field}, preset, aiAssisted:[]}
  rows TEXT NOT NULL DEFAULT '[]', -- raw grid under the header row
  staged TEXT NOT NULL DEFAULT '[]', -- lease_pdf lane: extracted drafts
  as_of TEXT, -- conversion date for balances/leases
  status TEXT NOT NULL DEFAULT 'staged', -- staged|applied|discarded
  summary TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_imp_org ON import_batches(org_id, status, created_at);
