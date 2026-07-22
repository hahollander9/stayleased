# Entity-relationship overview

Generated from `src/db/schema.sql` by `npm run gen:docs`. 120 tables.
Conventions: TEXT ids with type prefixes (`usr_`, `prp_`…), money INTEGER cents, dates TEXT `YYYY-MM-DD`, timestamps ISO-8601 UTC, JSON in TEXT columns. Every org-owned table carries `org_id`.

## orgs

- columns: `id`, `name`, `slug`, `business_date`, `created_at`

## portfolios

- columns: `id`, `org_id`, `name`, `region`, `created_at`
- references: org_id → orgs

## users

- columns: `id`, `org_id`, `email`, `name`, `phone`, `kind`, `vendor_id`, `password_hash`, `active`, `last_login_at`, `created_at`
- references: org_id → orgs

## role_assignments

- columns: `id`, `org_id`, `user_id`, `role`, `scope_type`, `property_ids`, `created_at`
- references: org_id → orgs; user_id → users

## sessions

- columns: `id`, `user_id`, `token_hash`, `impersonator_user_id`, `expires_at`, `created_at`
- references: user_id → users

## api_keys

- columns: `id`, `org_id`, `name`, `prefix`, `key_hash`, `active`, `last_used_at`, `created_at`
- references: org_id → orgs

## audit_events

- columns: `id`, `org_id`, `user_id`, `user_name`, `entity`, `entity_id`, `action`, `changes`, `at`

## domain_events

- columns: `id`, `org_id`, `type`, `entity`, `entity_id`, `payload`, `business_date`, `at`

## jobs

- columns: `id`, `org_id`, `key`, `name`, `describe`, `enabled`, `last_run_date`, `last_status`, `last_ms`, `last_error`

## job_runs

- columns: `id`, `org_id`, `job_key`, `date`, `status`, `summary`, `ms`, `at`

## webhook_endpoints

- columns: `id`, `org_id`, `url`, `secret`, `events`, `active`, `created_at`

## webhook_deliveries

- columns: `id`, `org_id`, `endpoint_id`, `event_id`, `event_type`, `payload`, `status`, `attempts`, `last_code`, `next_attempt_at`, `created_at`

## files

- columns: `id`, `org_id`, `name`, `mime`, `size`, `sha256`, `entity`, `entity_id`, `visibility`, `owner_user_id`, `created_by`, `created_at`

## settings

- columns: `id`, `org_id`, `property_id`, `key`, `value`, `updated_at`

## sim_state

- columns: `org_id`, `dials`, `updated_at`

## outbox_messages

- columns: `id`, `org_id`, `property_id`, `channel`, `direction`, `to_addr`, `to_user_id`, `to_name`, `subject`, `body`, `template_key`, `entity`, `entity_id`, `thread_id`, `person_id`, `status`, `sent_by`, `business_date`, `created_at`

## properties

- columns: `id`, `org_id`, `portfolio_id`, `name`, `slug`, `type`, `address1`, `city`, `state`, `zip`, `timezone`, `phone`, `email`, `year_built`, `fiscal_year_start_month`, `operating_bank_account_id`, `deposit_bank_account_id`, `status`, `marketing`, `created_at`
- references: org_id → orgs

## buildings

- columns: `id`, `org_id`, `property_id`, `name`, `address1`, `floors`, `created_at`
- references: property_id → properties

## floorplans

- columns: `id`, `org_id`, `property_id`, `name`, `beds`, `baths`, `sqft`, `market_rent_cents`, `description`, `created_at`
- references: property_id → properties

## units

- columns: `id`, `org_id`, `property_id`, `building_id`, `floorplan_id`, `unit_number`, `floor`, `sqft`, `status`, `market_rent_cents`, `amenities`, `notes`, `created_at`
- references: property_id → properties; building_id → buildings; floorplan_id → floorplans

## amenity_spaces

- columns: `id`, `org_id`, `property_id`, `name`, `description`, `bookable`, `capacity`, `fee_cents`, `max_hours`, `open_time`, `close_time`, `created_at`
- references: property_id → properties

## rentable_items

- columns: `id`, `org_id`, `property_id`, `kind`, `label`, `monthly_cents`, `status`, `assigned_lease_id`, `created_at`
- references: property_id → properties

## leases

- columns: `id`, `org_id`, `property_id`, `unit_id`, `household_name`, `status`, `start_date`, `end_date`, `move_in_date`, `move_out_date`, `notice_date`, `mtm_since`, `rent_cents`, `deposit_cents`, `deposit_alternative`, `term_months`, `application_id`, `renewal_of_lease_id`, `template_id`, `packet_file_id`, `esign_request_id`, `bed_label`, `created_at`
- references: property_id → properties; unit_id → units

## lease_charges

- columns: `id`, `org_id`, `lease_id`, `kind`, `label`, `amount_cents`, `gl_account_code`, `rentable_item_id`, `start_date`, `end_date`, `created_at`
- references: lease_id → leases

## residents

- columns: `id`, `org_id`, `property_id`, `user_id`, `first_name`, `last_name`, `email`, `phone`, `kind`, `employer`, `monthly_income_cents`, `ssn_last4`, `created_at`

## household_members

- columns: `id`, `org_id`, `lease_id`, `resident_id`, `role`, `created_at`
- references: lease_id → leases; resident_id → residents

## pets

- columns: `id`, `org_id`, `lease_id`, `name`, `species`, `breed`, `weight_lbs`, `rentable_item_id`, `created_at`

## vehicles

- columns: `id`, `org_id`, `lease_id`, `make`, `model`, `plate`, `state`, `rentable_item_id`, `created_at`

## gl_accounts

- columns: `id`, `org_id`, `code`, `name`, `type`, `is_control`, `active`, `sort`

## posting_rules

- columns: `id`, `org_id`, `event_key`, `description`, `dr_code`, `cr_code`

## journal_entries

- columns: `id`, `org_id`, `property_id`, `date`, `period_key`, `basis`, `memo`, `source_kind`, `source_id`, `reversal_of`, `approved_by`, `created_by`, `posted_at`

## journal_lines

- columns: `id`, `org_id`, `entry_id`, `account_code`, `debit_cents`, `credit_cents`, `property_id`, `memo`
- references: entry_id → journal_entries

## accounting_periods

- columns: `id`, `org_id`, `property_id`, `period_key`, `status`, `checklist`, `closed_at`, `closed_by`

## charges

- columns: `id`, `org_id`, `property_id`, `lease_id`, `kind`, `label`, `amount_cents`, `date`, `due_date`, `month_key`, `lease_charge_id`, `source`, `status`, `je_id`, `created_at`
- references: lease_id → leases

## payment_method_tokens

- columns: `id`, `org_id`, `user_id`, `lease_id`, `kind`, `label`, `token`, `behavior`, `is_default`, `created_at`

## payments

- columns: `id`, `org_id`, `property_id`, `lease_id`, `payer_resident_id`, `method`, `method_token_id`, `reference`, `amount_cents`, `fee_cents`, `status`, `received_date`, `settle_date`, `settlement_batch_id`, `nsf_date`, `autopay`, `memo`, `created_by`, `created_at`

## payment_applications

- columns: `id`, `org_id`, `payment_id`, `charge_id`, `amount_cents`, `created_at`
- references: payment_id → payments; charge_id → charges

## autopay_enrollments

- columns: `id`, `org_id`, `lease_id`, `user_id`, `method_token_id`, `mode`, `fixed_amount_cents`, `day_of_month`, `start_date`, `end_date`, `active`, `created_at`

## settlement_batches

- columns: `id`, `org_id`, `property_id`, `batch_date`, `method_group`, `total_cents`, `fee_cents`, `status`, `bank_txn_id`, `created_at`

## refunds

- columns: `id`, `org_id`, `property_id`, `lease_id`, `kind`, `amount_cents`, `method`, `reference`, `date`, `status`, `created_by`, `created_at`

## payment_plans

- columns: `id`, `org_id`, `property_id`, `lease_id`, `total_cents`, `status`, `notes`, `created_by`, `created_at`

## payment_plan_installments

- columns: `id`, `org_id`, `plan_id`, `due_date`, `amount_cents`, `status`, `payment_id`, `created_at`
- references: plan_id → payment_plans

## collection_cases

- columns: `id`, `org_id`, `property_id`, `lease_id`, `balance_cents`, `status`, `agency`, `opened_date`, `exported_at`, `notes`, `created_at`

## deposit_activity

- columns: `id`, `org_id`, `property_id`, `lease_id`, `kind`, `amount_cents`, `date`, `memo`, `payment_id`, `refund_id`, `created_at`

## delinquency_notes

- columns: `id`, `org_id`, `lease_id`, `kind`, `body`, `promise_date`, `promise_amount_cents`, `created_by`, `created_at`

## work_orders

- columns: `id`, `org_id`, `property_id`, `unit_id`, `lease_id`, `resident_id`, `category`, `priority`, `status`, `summary`, `description`, `permission_to_enter`, `pet_on_premises`, `preferred_times`, `source`, `assigned_to_user_id`, `vendor_id`, `scheduled_date`, `sla_hours`, `sla_due`, `created_date`, `completed_at`, `completed_date`, `rating`, `rating_comment`, `turn_id`, `pm_schedule_id`, `created_by`, `created_at`

## wo_events

- columns: `id`, `org_id`, `work_order_id`, `kind`, `body`, `meta`, `actor`, `visible_to_resident`, `at`, `business_date`
- references: work_order_id → work_orders

## household_requests

- columns: `id`, `org_id`, `property_id`, `lease_id`, `kind`, `payload`, `status`, `decided_by`, `decided_at`, `note`, `created_by`, `created_at`

## announcements

- columns: `id`, `org_id`, `property_id`, `title`, `body`, `starts_date`, `ends_date`, `echo_email`, `echo_sms`, `created_by`, `created_at`

## amenity_reservations

- columns: `id`, `org_id`, `property_id`, `space_id`, `lease_id`, `resident_id`, `date`, `start_time`, `end_time`, `guests`, `fee_cents`, `charge_id`, `status`, `created_at`
- references: space_id → amenity_spaces

## vendors

- columns: `id`, `org_id`, `name`, `category`, `phone`, `email`, `address`, `tin_last4`, `w9_on_file`, `is_1099`, `coi_expiry`, `banking`, `diversity_tags`, `approved_property_ids`, `active`, `created_at`

## wo_materials

- columns: `id`, `org_id`, `work_order_id`, `item_id`, `description`, `qty`, `unit_cost_cents`, `total_cents`, `created_by`, `created_at`
- references: work_order_id → work_orders

## wo_labor

- columns: `id`, `org_id`, `work_order_id`, `user_id`, `hours`, `rate_cents`, `total_cents`, `note`, `created_at`
- references: work_order_id → work_orders

## pm_schedules

- columns: `id`, `org_id`, `property_id`, `name`, `category`, `instructions`, `freq_days`, `next_due`, `assigned_to_user_id`, `active`, `created_at`

## turns

- columns: `id`, `org_id`, `property_id`, `unit_id`, `lease_id`, `move_out_date`, `target_ready_date`, `next_move_in_date`, `status`, `completed_date`, `created_at`

## turn_tasks

- columns: `id`, `org_id`, `turn_id`, `seq`, `name`, `status`, `assigned_to_user_id`, `vendor_id`, `est_cost_cents`, `actual_cost_cents`, `completed_date`, `created_at`
- references: turn_id → turns

## inspections

- columns: `id`, `org_id`, `property_id`, `unit_id`, `lease_id`, `type`, `status`, `inspector_user_id`, `date`, `notes`, `damages_posted`, `created_at`

## inspection_items

- columns: `id`, `org_id`, `inspection_id`, `area`, `item`, `condition`, `note`, `photo_file_id`, `charge_cents`, `created_at`
- references: inspection_id → inspections

## inventory_items

- columns: `id`, `org_id`, `property_id`, `sku`, `name`, `category`, `bin`, `unit_cost_cents`, `on_hand`, `min_qty`, `max_qty`, `created_at`

## stock_moves

- columns: `id`, `org_id`, `item_id`, `kind`, `qty`, `work_order_id`, `po_id`, `cost_cents`, `memo`, `created_by`, `at`, `business_date`
- references: item_id → inventory_items

## leads

- columns: `id`, `org_id`, `property_id`, `first_name`, `last_name`, `email`, `phone`, `source`, `channel`, `status`, `desired_move_in`, `beds`, `budget_cents`, `message`, `assigned_to_user_id`, `application_id`, `lease_id`, `lost_reason`, `last_activity_at`, `created_date`, `created_at`

## lead_events

- columns: `id`, `org_id`, `lead_id`, `kind`, `body`, `actor`, `at`, `business_date`
- references: lead_id → leads

## tours

- columns: `id`, `org_id`, `property_id`, `lead_id`, `unit_id`, `type`, `date`, `start_time`, `agent_user_id`, `status`, `reminder_sent`, `notes`, `created_at`
- references: lead_id → leads

## followup_tasks

- columns: `id`, `org_id`, `property_id`, `lead_id`, `kind`, `due_date`, `status`, `assigned_to_user_id`, `done_at`, `created_at`
- references: lead_id → leads

## quotes

- columns: `id`, `org_id`, `property_id`, `lead_id`, `unit_id`, `term_months`, `move_in`, `rent_cents`, `items`, `concession_note`, `total_monthly_cents`, `expires_date`, `status`, `created_by`, `created_at`
- references: lead_id → leads

## campaigns

- columns: `id`, `org_id`, `property_id`, `source`, `monthly_cost_cents`, `active`, `created_at`

## call_logs

- columns: `id`, `org_id`, `property_id`, `lead_id`, `resident_id`, `direction`, `from_number`, `duration_seconds`, `outcome`, `notes`, `transcript`, `ai_summary`, `ai_sentiment`, `ai_tags`, `handled_by`, `at`, `business_date`

## price_recommendations

- columns: `id`, `org_id`, `property_id`, `unit_id`, `date`, `term_months`, `current_rent_cents`, `recommended_rent_cents`, `accepted_rent_cents`, `factors`, `status`, `override_reason`, `decided_by`, `decided_at`, `created_at`

## listing_publications

- columns: `id`, `org_id`, `property_id`, `unit_id`, `channel`, `status`, `published_at`

## applications

- columns: `id`, `org_id`, `property_id`, `unit_id`, `lead_id`, `quote_id`, `status`, `term_months`, `move_in`, `rent_cents`, `app_fee_cents`, `hold_deposit_cents`, `fees_paid`, `fee_payment_ref`, `hold_expires`, `criteria_version`, `recommendation`, `recommendation_detail`, `decision`, `submitted_at`, `lease_id`, `created_at`

## applicants

- columns: `id`, `org_id`, `application_id`, `kind`, `first_name`, `last_name`, `email`, `phone`, `ssn_last4`, `current_address`, `employer`, `income_monthly_cents`, `invite_token`, `status`, `step`, `created_at`
- references: application_id → applications

## screening_reports

- columns: `id`, `org_id`, `application_id`, `applicant_id`, `status`, `credit_score`, `credit_band`, `criminal_flag`, `eviction_flag`, `eviction_years_ago`, `thin_file`, `fraud_flags`, `income_extracted_cents`, `requested_at`, `completed_at`
- references: applicant_id → applicants

## criteria_versions

- columns: `id`, `org_id`, `property_id`, `version`, `criteria`, `created_at`

## lease_templates

- columns: `id`, `org_id`, `property_id`, `state`, `name`, `version`, `body`, `active`, `created_at`

## addenda_library

- columns: `id`, `org_id`, `key`, `title`, `body`, `condition_key`, `sort`, `active`, `created_at`

## signature_requests

- columns: `id`, `org_id`, `lease_id`, `kind`, `status`, `mode`, `doc_file_id`, `doc_sha256`, `signed_file_id`, `events`, `created_at`, `completed_at`

## signature_signers

- columns: `id`, `org_id`, `request_id`, `name`, `email`, `role`, `token`, `order_idx`, `status`, `signature_kind`, `signature_text`, `signature_file_id`, `initials`, `signed_at`, `created_at`
- references: request_id → signature_requests

## renewal_offers

- columns: `id`, `org_id`, `property_id`, `lease_id`, `options`, `status`, `accepted_term`, `accepted_rent_cents`, `counter_note`, `new_lease_id`, `expires_date`, `created_at`, `decided_at`

## move_checklists

- columns: `id`, `org_id`, `lease_id`, `kind`, `items`, `created_at`

## bank_accounts

- columns: `id`, `org_id`, `property_id`, `name`, `kind`, `gl_account`, `bank_name`, `last4`, `active`, `created_at`

## bank_txns

- columns: `id`, `org_id`, `bank_account_id`, `date`, `amount_cents`, `description`, `ref`, `kind`, `status`, `matched_kind`, `matched_id`, `recon_id`, `imported_at`
- references: bank_account_id → bank_accounts

## bank_recons

- columns: `id`, `org_id`, `bank_account_id`, `period_key`, `statement_open_cents`, `statement_close_cents`, `status`, `difference_cents`, `notes`, `completed_by`, `completed_at`, `created_at`
- references: bank_account_id → bank_accounts

## vendor_invoices

- columns: `id`, `org_id`, `property_id`, `vendor_id`, `invoice_number`, `invoice_date`, `due_date`, `memo`, `status`, `total_cents`, `source`, `source_id`, `je_id`, `approved_by`, `approved_at`, `paid_at`, `created_by`, `created_at`
- references: vendor_id → vendors

## vendor_invoice_lines

- columns: `id`, `org_id`, `invoice_id`, `gl_account`, `description`, `amount_cents`, `property_id`, `unit_id`, `project_id`, `cost_code`, `created_at`
- references: invoice_id → vendor_invoices

## ap_payment_runs

- columns: `id`, `org_id`, `run_date`, `method`, `status`, `total_cents`, `created_by`, `created_at`

## ap_payments

- columns: `id`, `org_id`, `run_id`, `invoice_id`, `vendor_id`, `property_id`, `amount_cents`, `method`, `check_number`, `status`, `cleared_date`, `je_id`, `void_reason`, `voided_at`, `reissued_payment_id`, `created_at`
- references: run_id → ap_payment_runs; invoice_id → vendor_invoices

## recurring_jes

- columns: `id`, `org_id`, `property_id`, `name`, `memo`, `lines`, `day_of_month`, `start_month`, `end_month`, `last_posted_month`, `basis`, `active`, `created_by`, `created_at`

## pending_jes

- columns: `id`, `org_id`, `property_id`, `date`, `memo`, `lines`, `basis`, `status`, `requested_by`, `decided_by`, `decided_at`, `reject_reason`, `je_id`, `created_at`

## budgets

- columns: `id`, `org_id`, `property_id`, `year`, `version`, `status`, `notes`, `approved_by`, `approved_at`, `created_at`

## budget_lines

- columns: `id`, `org_id`, `budget_id`, `gl_account`, `months`, `note`
- references: budget_id → budgets

## capital_projects

- columns: `id`, `org_id`, `property_id`, `name`, `description`, `budget_cents`, `cost_codes`, `status`, `start_date`, `target_date`, `created_at`

## meters

- columns: `id`, `org_id`, `property_id`, `unit_id`, `service`, `serial`, `multiplier`, `active`, `created_at`

## meter_reads

- columns: `id`, `org_id`, `meter_id`, `month_key`, `read_date`, `usage_qty`, `source`, `anomaly`, `status`, `note`, `created_at`
- references: meter_id → meters

## utility_provider_invoices

- columns: `id`, `org_id`, `property_id`, `service`, `vendor_id`, `usage_month`, `total_cents`, `usage_qty`, `rate_note`, `weather_note`, `vendor_invoice_id`, `created_at`

## rubs_configs

- columns: `id`, `org_id`, `property_id`, `service`, `method`, `flat_fee_cents`, `admin_fee_cents`, `common_deduct_pct`, `bill_vacant`, `active`

## rubs_runs

- columns: `id`, `org_id`, `property_id`, `service`, `usage_month`, `provider_invoice_id`, `method`, `total_cents`, `billable_cents`, `recovered_cents`, `vacant_cents`, `common_cents`, `status`, `posted_at`, `posted_by`, `created_at`
- references: provider_invoice_id → utility_provider_invoices

## rubs_lines

- columns: `id`, `org_id`, `run_id`, `unit_id`, `lease_id`, `basis_label`, `occupied_days`, `month_days`, `amount_cents`, `admin_fee_cents`, `charge_id`, `created_at`
- references: run_id → rubs_runs

## insurance_policies

- columns: `id`, `org_id`, `property_id`, `lease_id`, `kind`, `carrier`, `policy_number`, `liability_cents`, `start_date`, `end_date`, `status`, `verified_at`, `file_id`, `source`, `reminder_stage`, `created_at`

## deposit_alternatives

- columns: `id`, `org_id`, `property_id`, `lease_id`, `provider`, `mode`, `fee_cents`, `coverage_cents`, `status`, `claim_cents`, `claim_date`, `enrolled_date`, `created_at`

## guaranty_contracts

- columns: `id`, `org_id`, `property_id`, `application_id`, `lease_id`, `provider`, `fee_cents`, `coverage_months`, `status`, `esign_request_id`, `created_at`

## incidents

- columns: `id`, `org_id`, `property_id`, `unit_id`, `kind`, `date`, `description`, `est_loss_cents`, `claim_number`, `status`, `created_by`, `created_at`

## catalog_items

- columns: `id`, `org_id`, `name`, `category`, `unit`, `unit_price_cents`, `preferred_vendor_id`, `gl_account`, `inventory_sku`, `active`, `created_at`

## purchase_orders

- columns: `id`, `org_id`, `property_id`, `vendor_id`, `po_number`, `status`, `memo`, `needed_by`, `source`, `source_id`, `total_cents`, `approved_by`, `approved_at`, `sent_at`, `acknowledged_at`, `created_by`, `created_at`

## purchase_order_lines

- columns: `id`, `org_id`, `po_id`, `catalog_item_id`, `description`, `qty`, `unit_price_cents`, `gl_account`, `project_id`, `cost_code`, `received_qty`, `created_at`
- references: po_id → purchase_orders

## po_receipts

- columns: `id`, `org_id`, `po_id`, `date`, `note`, `received_by`, `created_at`
- references: po_id → purchase_orders

## po_receipt_lines

- columns: `id`, `org_id`, `receipt_id`, `po_line_id`, `qty`
- references: receipt_id → po_receipts; po_line_id → purchase_order_lines

## invoice_matches

- columns: `id`, `org_id`, `invoice_id`, `po_id`, `status`, `price_variance_cents`, `qty_exception`, `detail`, `decided_by`, `decided_at`, `created_at`
- references: invoice_id → vendor_invoices; po_id → purchase_orders

## threads

- columns: `id`, `org_id`, `property_id`, `person_kind`, `person_id`, `display_name`, `status`, `assigned_to`, `snooze_until`, `needs_reply`, `last_message_at`, `last_snippet`, `created_at`

## thread_notes

- columns: `id`, `org_id`, `thread_id`, `body`, `author`, `created_at`
- references: thread_id → threads

## comm_prefs

- columns: `id`, `org_id`, `person_kind`, `person_id`, `email_optout`, `sms_optout`, `unsubscribe_token`, `updated_at`

## message_templates

- columns: `id`, `org_id`, `property_id`, `key`, `category`, `name`, `subject`, `body`, `sms`, `active`, `created_by`, `created_at`

## segments

- columns: `id`, `org_id`, `name`, `filters`, `created_by`, `created_at`

## mass_messages

- columns: `id`, `org_id`, `segment_id`, `filters`, `subject`, `body`, `sms_body`, `channels`, `scheduled_for`, `status`, `sent_at`, `sent_count`, `skipped_count`, `created_by`, `created_at`

## mass_recipients

- columns: `id`, `org_id`, `mass_id`, `resident_id`, `lease_id`, `channel`, `status`, `reason`, `outbox_id`, `sent_at`
- references: mass_id → mass_messages

## comp_sets

- columns: `id`, `org_id`, `property_id`, `name`, `distance_miles`, `year_built`, `notes`, `active`, `created_at`

## comp_observations

- columns: `id`, `org_id`, `comp_id`, `month_key`, `beds`, `rent_cents`, `concession_note`, `source`, `created_at`
- references: comp_id → comp_sets

## price_changes

- columns: `id`, `org_id`, `property_id`, `unit_id`, `date`, `old_cents`, `new_cents`, `source`, `recommendation_id`, `reason`, `changed_by`, `created_at`

## metric_snapshots

- columns: `id`, `org_id`, `property_id`, `date`, `metrics`, `created_at`

## saved_reports

- columns: `id`, `org_id`, `owner_user_id`, `name`, `kind`, `dataset`, `config`, `shared`, `schedule`, `last_run_date`, `created_at`

## user_dashboards

- columns: `id`, `org_id`, `user_id`, `layout`, `updated_at`

