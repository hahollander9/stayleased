import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/lib/auth.ts';
import { expandPerms, ROLE_PERMS, ALL_PERMS } from '../src/lib/rbac.ts';

test('password hashing round-trips and rejects wrong password', () => {
  const h = hashPassword('demo1234');
  assert.equal(h.startsWith('scrypt$'), true);
  assert.equal(verifyPassword('demo1234', h), true);
  assert.equal(verifyPassword('wrong', h), false);
  assert.notEqual(hashPassword('demo1234'), h); // salted
});

test('role permission expansion', () => {
  const admin = expandPerms(['ORG_ADMIN']);
  assert.equal(admin.has('gl:close_period'), true);
  assert.equal(admin.has('admin:platform'), false);

  const agent = expandPerms(['LEASING_AGENT']);
  assert.equal(agent.has('leasing:manage'), true);
  assert.equal(agent.has('gl:close_period'), false);
  assert.equal(agent.has('latefees:waive'), false);

  const tech = expandPerms(['MAINTENANCE_TECH']);
  assert.equal(tech.has('workorders:work'), true);
  assert.equal(tech.has('workorders:assign'), false);

  const acct = expandPerms(['ACCOUNTANT']);
  assert.equal(acct.has('gl:close_period'), true);
  assert.equal(acct.has('banking:reconcile'), true);
  assert.equal(acct.has('leases:countersign'), false);

  const platform = expandPerms(['PLATFORM_ADMIN']);
  assert.equal(platform.size, ALL_PERMS.length);
});

test('every role permission pattern references real permissions', () => {
  for (const [role, pats] of Object.entries(ROLE_PERMS)) {
    for (const pat of pats) {
      if (pat === '*') continue;
      if (pat.endsWith(':*')) {
        assert.equal(ALL_PERMS.some((p) => p.startsWith(pat.slice(0, -1))), true, `${role}: ${pat}`);
      } else {
        assert.equal(ALL_PERMS.includes(pat), true, `${role}: ${pat} not in catalog`);
      }
    }
  }
});
