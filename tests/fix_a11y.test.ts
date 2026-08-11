import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { field, input, select, textarea } from '../src/ui/ui.ts';

/** Regression guards for the 2026-08-11 WCAG AA fix pass. */

test('A11Y-1: field() associates its label with a text input (for/id)', () => {
  const out = field('Email', input('email')).s;
  const forId = out.match(/<label[^>]*\bfor="([^"]+)"/);
  const ctrlId = out.match(/<input[^>]*\bid="([^"]+)"/);
  assert.ok(forId, 'label carries a for attribute');
  assert.ok(ctrlId, 'input carries an id attribute');
  assert.equal(forId![1], ctrlId![1], 'label for matches the control id');
  assert.ok(out.includes('Email'), 'visible label text is present');
});

test('A11Y-1: field() associates textarea and select controls', () => {
  const ta = field('Notes', textarea('notes')).s;
  const taFor = ta.match(/<label[^>]*\bfor="([^"]+)"/);
  const taId = ta.match(/<textarea[^>]*\bid="([^"]+)"/);
  assert.ok(taFor && taId && taFor[1] === taId[1], 'textarea is label-associated');

  const sel = field('Property', select('property', [['a', 'A']])).s;
  const selFor = sel.match(/<label[^>]*\bfor="([^"]+)"/);
  const selId = sel.match(/<select[^>]*\bid="([^"]+)"/);
  assert.ok(selFor && selId && selFor[1] === selId[1], 'select is label-associated');
  // the visible <label> is the accessible name, so the redundant auto
  // aria-label must be stripped off a field-wrapped select
  assert.ok(!/aria-label=/.test(sel), 'field-wrapped select drops its auto aria-label');
});

test('A11Y-1: a bare select() keeps an aria-label as its accessible name', () => {
  const bare = select('gl_account', [['a', 'A']]).s;
  assert.match(bare, /aria-label="gl account"/, 'bare select derives an aria-label from its name');
  assert.match(bare, /\bid="/, 'bare select still carries an id');
});

test('A11Y-2: theme.css uses minmax(0,...) dash-duo tracks (no mobile overflow)', () => {
  const css = readFileSync(new URL('../src/ui/theme.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /\.dash-duo\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.05fr\)\s*minmax\(0,\s*\.95fr\)/,
    'desktop dash-duo tracks are minmax(0,...)',
  );
  assert.match(
    css,
    /\.dash-duo\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;\s*\}/,
    'mobile dash-duo track is minmax(0, 1fr)',
  );
});
