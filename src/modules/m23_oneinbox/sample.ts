import type { MailIn, RosterRow } from './engine.ts';

/** A fictional contact list and a morning's worth of email, built to show
 * every branch of One Inbox: a known address, an unknown address that names
 * its unit, a staff member's manual forward, a case worker with several
 * households, two people with the same name, a name merely mentioned, and an
 * email nobody can place. Every name, address and number is invented. The
 * properties match the weekly action report's sample portfolio so the two
 * demos read as one company. */

export const SAMPLE_ROSTER: RosterRow[] = [
  { name: 'Denise Harper', emails: ['denise.harper@example.com'], phones: ['2025550101'], property: 'Oakwood Terrace', unit: '1', kind: 'tenant' },
  { name: 'Marcus Bell', emails: ['mbell.dc@example.com'], phones: ['2025550102'], property: 'Oakwood Terrace', unit: '2', kind: 'tenant' },
  { name: 'Tanya Brooks', emails: [], phones: ['2025550103'], property: 'Oakwood Terrace', unit: '3', kind: 'tenant' },
  { name: 'Andre Simmons', emails: ['andre.simmons@example.com'], phones: ['2025550104'], property: 'Oakwood Terrace', unit: '4', kind: 'tenant' },
  { name: 'Keisha Grant', emails: ['keishag@example.com'], phones: ['2025550105'], property: 'Hillcrest Four', unit: '1', kind: 'tenant' },
  { name: 'James Brown', emails: ['jbrown77@example.com'], phones: ['2025550106'], property: 'Hillcrest Four', unit: '2', kind: 'tenant' },
  { name: 'James Brown', emails: [], phones: ['2025550107'], property: 'Riverside Commons', unit: '204', kind: 'tenant' },
  { name: 'Yolanda Pierce', emails: ['ypierce@example.com'], phones: ['2025550108'], property: 'Riverside Commons', unit: '101', kind: 'tenant' },
  { name: 'Curtis Mann', emails: ['curtis.mann@example.com'], phones: ['2025550109'], property: 'Riverside Commons', unit: '102', kind: 'tenant' },
  { name: 'Gloria Nash', emails: ['gloria.nash@example.com'], phones: ['2025550110'], property: 'Sycamore House', unit: 'Main', kind: 'tenant' },
  { name: 'P. Okafor (case manager)', emails: ['p.okafor@housing-partners.example.org'], phones: ['2025550150'], property: 'Oakwood Terrace', unit: '3', kind: 'agency' },
  { name: 'P. Okafor (case manager)', emails: ['p.okafor@housing-partners.example.org'], phones: ['2025550150'], property: 'Riverside Commons', unit: '102', kind: 'agency' },
  { name: 'Eastgate Holdings LLC', emails: ['owner@eastgate-holdings.example.com'], phones: ['2025550160'], property: 'Hillcrest Four', unit: '', kind: 'owner' },
];

const SHARED = 'maintenance@sample-pm.example.com';

/** minutes before "now" each one arrived, newest last */
export const SAMPLE_MAIL: { minutesAgo: number; mail: MailIn }[] = [
  { minutesAgo: 540, mail: { fromEmail: 'denise.harper@example.com', fromName: 'Denise Harper', to: [SHARED], subject: 'Kitchen sink leaking', text: 'Hi, the pipe under my kitchen sink has been dripping since last night. I put a bucket under it. Can someone come look this week?\n\nDenise' } },
  { minutesAgo: 480, mail: { fromEmail: 'tbrooks.personal@example.net', fromName: 'T Brooks', to: [SHARED], subject: 'no heat', text: 'There is no heat in my apartment since this morning and I have a baby here. This is Tanya at Oakwood Terrace unit 3. Please call me 202-555-0103.' } },
  { minutesAgo: 420, mail: { fromEmail: 'frontdesk@sample-pm.example.com', fromName: 'Front Desk', to: ['inbox@in.stayleased.com'], subject: 'Fwd: Late fee question', text: 'FYI\n\n---------- Forwarded message ---------\nFrom: Marcus Bell <mbell.dc@example.com>\nDate: Mon\nSubject: Late fee question\nTo: leasing@sample-pm.example.com\n\nI paid my rent on the 4th but I see a late fee on my balance. Can you check the ledger and remove it?\n\nMarcus' } },
  { minutesAgo: 360, mail: { fromEmail: 'p.okafor@housing-partners.example.org', fromName: 'P. Okafor', to: ['agencies@sample-pm.example.com'], subject: 'Re-inspection scheduled: Riverside Commons Unit 102', text: 'Good morning,\n\nThe re-inspection for Riverside Commons, Unit 102 (Curtis Mann) is scheduled for Thursday at 10am. The two failed items must be corrected before then or payments will be abated.\n\nP. Okafor\nCase Manager' } },
  { minutesAgo: 300, mail: { fromEmail: 'p.okafor@housing-partners.example.org', fromName: 'P. Okafor', to: ['agencies@sample-pm.example.com'], subject: 'Quick question', text: 'Hi, can you send me the current ledger for my client? Thanks.\n\nP. Okafor' } },
  { minutesAgo: 240, mail: { fromEmail: 'jb.newphone@example.net', fromName: 'James Brown', to: [SHARED], subject: 'Dishwasher broken', text: 'My dishwasher stopped working over the weekend. Can maintenance take a look? Thanks, James' } },
  { minutesAgo: 200, mail: { fromEmail: 'keishag@example.com', fromName: 'Keisha Grant', to: [SHARED], subject: 'Noise from upstairs', text: 'My neighbor James Brown in unit 2 has been very loud after midnight all week. I have talked to him twice. Can you please do something?' } },
  { minutesAgo: 150, mail: { fromEmail: 'owner@eastgate-holdings.example.com', fromName: 'Eastgate Holdings', to: ['owners@sample-pm.example.com'], subject: 'October statement', text: 'Can you send the October owner statement for Hillcrest Four? I did not see it in the portal.' } },
  { minutesAgo: 90, mail: { fromEmail: 'sunnyday4482@example.net', fromName: '', to: [SHARED], subject: 'water', text: 'water is coming through my bathroom ceiling right now please send someone' } },
  { minutesAgo: 45, mail: { fromEmail: 'gloria.nash@example.com', fromName: 'Gloria Nash', to: ['leasing@sample-pm.example.com'], subject: 'Payment plan', text: 'Hello, I got behind after my hours were cut. Can I set up a payment plan for the balance? I can pay $200 extra a month starting on the 15th.' } },
  { minutesAgo: 20, mail: { fromEmail: 'hello@apartment-seeker.example.com', fromName: 'Renee Barnes', to: ['leasing@sample-pm.example.com'], subject: 'Is the 3 bedroom still available?', text: 'Hi, I saw your listing for a 3 bedroom and would like to schedule a tour this week. I have a voucher. Thank you!' } },
];
