import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineScript } from '../src/lib/html.ts';

/** A script element's body is raw text: the HTML parser ends the element at the
 * first closing script tag inside it, wherever that sits — a string literal, a
 * regex, or a code comment. Everything after is reparsed as markup, so the
 * script truncates mid-statement and the browser reports only "Unexpected end
 * of input" with no line to blame.
 *
 * This is not hypothetical here. The portfolio map's client code was cut in
 * half by a comment that mentioned the closing tag while explaining escaping,
 * and the only symptom was a map with no pins on it. inlineScript() is the
 * structural fix; these are its guards. */

test('inlineScript defuses a closing script tag in a string literal', () => {
  const out = inlineScript(`var s = '</script>';`).s;
  assert.ok(!/<\/script/i.test(out), 'no bare closing tag survives');
  assert.equal(out, `var s = '<\\/script>';`);
  // and the escape is invisible to JavaScript — the literal still evaluates to
  // exactly the text that was written, which is what makes this safe to apply
  // blindly to every inline script rather than auditing each one
  assert.equal(new Function(`${out} return s;`)(), '</script>');
});

test('inlineScript defuses a closing script tag inside a comment', () => {
  const js = `// escapes '<' far enough to survive </script>\nvar ok = 1;`;
  const out = inlineScript(js).s;
  assert.ok(!/<\/script/i.test(out));
  assert.ok(out.includes('var ok = 1;'), 'the code below the comment is still there');
});

test('inlineScript catches the tag however it is cased or spaced', () => {
  for (const variant of ['</SCRIPT>', '</Script >', '</script\n>', '</script']) {
    assert.ok(!/<\/script/i.test(inlineScript(`x = "${variant}";`).s), `defused: ${JSON.stringify(variant)}`);
  }
});

test('inlineScript leaves ordinary code byte-for-byte alone', () => {
  const js = `(function () { var a = '</div>'; var b = /<\\/b>/; return a + b; })();`;
  assert.equal(inlineScript(js).s, js);
});

test('the map client scripts carry no closing script tag', async () => {
  // Guards the actual regression: these two constants are emitted inline, so a
  // future edit that mentions the tag in a comment must not silently truncate
  // the map again.
  const src = await import('node:fs').then((fs) => fs.readFileSync('src/modules/m2_portfolio/map.ts', 'utf8'));
  const blocks = [...src.matchAll(/const (MAP_JS|DASHMAP_JS) = `([\s\S]*?)`;/g)];
  assert.equal(blocks.length, 2, 'both inline script constants found');
  for (const [, name, body] of blocks) {
    assert.ok(!/<\/script/i.test(body!), `${name} contains a literal closing script tag`);
  }
});
