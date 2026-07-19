// Regression guard for the bundled templates: every {{token}} in every .docx listed in
// registry.json must resolve to a canonical field (directly, normalized, or via an alias in
// fieldSchema.js). This is the check that would have caught the welcome letter's old
// {{First Name}} (missing field) and {{elligibity_date}} (unaliased typo) going out unfillable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.JSZip = require('../extension/lib/jszip.min.js');
const DocxFill = require('../extension/src/docxFill');
const ParseFields = require('../extension/src/parseFields');

const TEMPLATES_DIR = path.join(__dirname, '..', 'extension', 'assets', 'templates');
const registry = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, 'registry.json'), 'utf8'));

// Empty extraction yields every canonical knownFields key (all blank) -- the exact dictionary
// the popup matches template tokens against.
const EMPTY_KNOWN_FIELDS = ParseFields.extractKnownFields({
  labelValues: {},
  billingAddress: [],
  deliveryAddress: [],
  specialRequirements: '',
}).knownFields;

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test('registry.json entries all point at existing .docx files', () => {
  assert.ok(registry.length >= 1);
  for (const entry of registry) {
    assert.ok(entry.id && entry.label && entry.file, `registry entry malformed: ${JSON.stringify(entry)}`);
    assert.ok(fs.existsSync(path.join(TEMPLATES_DIR, entry.file)), `${entry.file} missing`);
  }
});

for (const entry of registry) {
  test(`every token in ${entry.file} resolves against the field schema`, async () => {
    const buffer = toArrayBuffer(fs.readFileSync(path.join(TEMPLATES_DIR, entry.file)));
    const tokens = await DocxFill.listTemplateTokens(buffer);
    assert.ok(tokens.length > 0, `${entry.file} contains no {{tokens}} at all - is it the right file?`);

    const unresolved = tokens.filter(
      (t) => ParseFields.canonicalKeyForToken(t, EMPTY_KNOWN_FIELDS) === null
    );
    assert.deepStrictEqual(
      unresolved,
      [],
      `${entry.file} has tokens that will never auto-fill: ${unresolved.map((t) => `{{${t}}}`).join(', ')}. ` +
        'Fix the token spelling in the template, or add the field/alias to fieldSchema.js.'
    );
  });

  test(`filling ${entry.file} leaves no {{tokens}} behind`, async () => {
    const buffer = toArrayBuffer(fs.readFileSync(path.join(TEMPLATES_DIR, entry.file)));
    const tokens = await DocxFill.listTemplateTokens(buffer);
    const fieldMap = {};
    tokens.forEach((t, i) => { fieldMap[t] = `value${i}`; });

    const { blob, unresolvedKeys } = await DocxFill.generateContract(buffer, fieldMap);
    assert.strictEqual(unresolvedKeys.size, 0);

    const outZip = await global.JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
    const xml = await outZip.file('word/document.xml').async('string');
    assert.strictEqual(xml.match(/\{\{\s*[^{}]+?\s*\}\}/g), null, 'output still contains {{tokens}}');
  });
}
