const test = require('node:test');
const assert = require('node:assert');

// docxFill's zip entry points need JSZip on the global, matching how the popup loads it via a
// <script> tag; the pure-XML functions under test here don't touch it, but require() runs the
// whole module.
global.JSZip = require('../extension/lib/jszip.min.js');
const DocxFill = require('../extension/src/docxFill');

function run(text) {
  return `<w:r><w:t>${text}</w:t></w:r>`;
}

test('replaceMergeFields fills a token contained in a single run', () => {
  const xml = `<w:p>${run('Dear {{first_name}},')}</w:p>`;
  const { xml: out, filledKeys } = DocxFill.replaceMergeFields(xml, { first_name: 'Jane' });
  assert.match(out, /Dear Jane,/);
  assert.deepStrictEqual([...filledKeys], ['first_name']);
});

test('replaceMergeFields fills a token split across multiple runs', () => {
  // Word often splits "{{business_name}}" across runs, e.g. after spellcheck markup.
  const xml = `<w:p>${run('Hello {{busi')}<w:proofErr w:type="spellStart"/>${run('ness_name}}')}${run(' welcome')}</w:p>`;
  const { xml: out, filledKeys } = DocxFill.replaceMergeFields(xml, { business_name: 'Acme Ltd' });
  const text = out.replace(/<[^>]+>/g, '');
  assert.strictEqual(text, 'Hello Acme Ltd welcome');
  assert.deepStrictEqual([...filledKeys], ['business_name']);
  // Non-<w:t> markup between runs must survive untouched.
  assert.match(out, /<w:proofErr w:type="spellStart"\/>/);
});

test('replaceMergeFields escapes XML special characters in values', () => {
  const xml = `<w:p>${run('{{business_name}}')}</w:p>`;
  const { xml: out } = DocxFill.replaceMergeFields(xml, { business_name: 'Smith & Sons <Ltd>' });
  assert.match(out, /Smith &amp; Sons &lt;Ltd&gt;/);
  assert.doesNotMatch(out, /Smith & Sons <Ltd>/);
});

test('replaceMergeFields leaves unknown tokens untouched and reports them', () => {
  const xml = `<w:p>${run('{{known}} and {{unknown}}')}</w:p>`;
  const { xml: out, unresolvedKeys } = DocxFill.replaceMergeFields(xml, { known: 'X' });
  assert.match(out, /X and \{\{unknown\}\}/);
  assert.deepStrictEqual([...unresolvedKeys], ['unknown']);
});

test('replaceMergeFields handles multiple occurrences of the same token', () => {
  const xml = `<w:p>${run('{{name}} meets {{name}}')}</w:p>`;
  const { xml: out } = DocxFill.replaceMergeFields(xml, { name: 'Jo' });
  assert.strictEqual(out.replace(/<[^>]+>/g, ''), 'Jo meets Jo');
});

test('replaceMergeFields handles a split token followed by another token in the same run', () => {
  // {{a}} spans runs 1-2; {{b}} sits wholly in run 2 after it. The second replacement must
  // account for the text the first one consumed from run 2.
  const xml = `<w:p>${run('x {{a')}${run('}} then {{b}} end')}</w:p>`;
  const { xml: out } = DocxFill.replaceMergeFields(xml, { a: 'ONE', b: 'TWO' });
  assert.strictEqual(out.replace(/<[^>]+>/g, ''), 'x ONE then TWO end');
});

test('replaceMergeFields trims whitespace inside braces', () => {
  const xml = `<w:p>${run('{{  spaced_token  }}')}</w:p>`;
  const { xml: out } = DocxFill.replaceMergeFields(xml, { spaced_token: 'ok' });
  assert.strictEqual(out.replace(/<[^>]+>/g, ''), 'ok');
});

test('escapeXmlText escapes ampersands, angle brackets, and stringifies null', () => {
  assert.strictEqual(DocxFill.escapeXmlText('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  assert.strictEqual(DocxFill.escapeXmlText(null), '');
});
