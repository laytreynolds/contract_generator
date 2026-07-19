const test = require('node:test');
const assert = require('node:assert');

const ParseFields = require('../extension/src/parseFields');

test('buildAddressFields squashes getAddress.io shape into 4 slots', () => {
  const addr = ParseFields.buildAddressFields([
    '12 High Street', '', '', 'Truro', 'Cornwall', 'UK', 'TR1 2AB',
  ]);
  assert.deepStrictEqual(addr, {
    first: '12 High Street',
    second: 'Truro',
    third: 'Cornwall',
    postCode: 'TR1 2AB',
  });
});

test('buildAddressFields drops duplicated consecutive lines and normalizes postcode spacing', () => {
  const addr = ParseFields.buildAddressFields(['5 Elm Rd', '5 Elm Rd', 'Leeds', 'ls1  4dp']);
  assert.strictEqual(addr.first, '5 Elm Rd');
  assert.strictEqual(addr.second, 'Leeds');
  assert.strictEqual(addr.postCode, 'LS1 4DP');
});

test('splitTrailingAmount handles plain and decorated price formats', () => {
  assert.deepStrictEqual(
    ParseFields.splitTrailingAmount('EE Consumer 20GB £12.95'),
    { name: 'EE Consumer 20GB', price: '12.95' }
  );
  assert.deepStrictEqual(
    ParseFields.splitTrailingAmount('Consumer Plan EE Essential 20GB @£12.95 Including Vat'),
    { name: 'Consumer Plan EE Essential 20GB', price: '12.95' }
  );
  assert.strictEqual(ParseFields.splitTrailingAmount('No price here'), null);
});

test('stripBusinessNameComposite strips CRM composite suffix', () => {
  assert.strictEqual(
    ParseFields.stripBusinessNameComposite('David Watkins - 3152430 - Pending 22/07'),
    'David Watkins'
  );
  assert.strictEqual(ParseFields.stripBusinessNameComposite('Plain Name'), 'Plain Name');
});

test('parseSpecialRequirements extracts structured values from *** segments', () => {
  const { extraInfo, nameFromSpecialReq } = ParseFields.parseSpecialRequirements(
    '*** Jane Doe *** Quote Id: 12345 *** PAC Code: ABC123 *** Bank Details: Barclays - Sort Code 12-34-56 *** Account Number: 87654321 *** DOB: 30/03/1955 *** Porting MPN: 447700900999 *** EE Consumer 20GB £12.95 ***'
  );
  assert.strictEqual(nameFromSpecialReq, 'Jane Doe');
  assert.strictEqual(extraInfo.quoteId, '12345');
  assert.strictEqual(extraInfo.pacCode, 'ABC123');
  assert.strictEqual(extraInfo.bankName, 'Barclays');
  assert.strictEqual(extraInfo.sortCode, '12-34-56');
  assert.strictEqual(extraInfo.accountNumber, '87654321');
  assert.strictEqual(extraInfo.dob, '30/03/1955');
  assert.strictEqual(extraInfo.portingMpn, '447700900999');
  assert.strictEqual(extraInfo.planSegment, 'EE Consumer 20GB £12.95');
});

test('formattedDateLong produces correct ordinal suffixes', () => {
  // formattedDateLong reads the real clock, so assert on shape rather than a fixed date...
  assert.match(ParseFields.formattedDateLong(), /^\d{1,2}(st|nd|rd|th) [A-Z][a-z]+ \d{4}$/);
});

test('todayUk and nowUk match UK formats', () => {
  assert.match(ParseFields.todayUk(), /^\d{2}\/\d{2}\/\d{4}$/);
  assert.match(ParseFields.nowUk(), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
});

function fakeExtraction(overrides = {}) {
  return {
    labelValues: {
      'First Name': 'Jane',
      'Last Name': 'Doe',
      'Business Type': '',
      'Business Name': '',
      'Full Name': '',
      'New Tariff': 'EE Consumer 20GB £12.95',
      'Email Address': 'jane.doe@example.com',
      'Mobile Number': '07700 900123',
      'Eligibility Date': '2026-08-01',
      'Spend Cap': '£50',
      ...overrides.labelValues,
    },
    billingAddress: overrides.billingAddress || ['12 High Street', '', '', 'Truro', 'Cornwall', 'UK', 'TR1 2AB'],
    deliveryAddress: overrides.deliveryAddress || [],
    specialRequirements: overrides.specialRequirements || '',
  };
}

test('extractKnownFields end-to-end happy path', () => {
  const { knownFields, warnings } = ParseFields.extractKnownFields(fakeExtraction());
  assert.strictEqual(knownFields.business_name, 'Jane Doe');
  assert.strictEqual(knownFields.first_name, 'Jane');
  assert.strictEqual(knownFields.address_first_line, '12 High Street');
  assert.strictEqual(knownFields.post_code, 'TR1 2AB');
  assert.strictEqual(knownFields.customer_full_address, '12 High Street, Truro, Cornwall, TR1 2AB');
  assert.strictEqual(knownFields.consumer_plan, 'EE Consumer 20GB');
  assert.strictEqual(knownFields.price, '12.95');
  assert.strictEqual(knownFields.data_allowance, '20');
  assert.strictEqual(knownFields.eligibility_date, '01/08/2026'); // ISO converted to UK
  assert.deepStrictEqual(warnings, []);
});

test('extractKnownFields falls back to delivery address with a structured warning', () => {
  const { knownFields, warnings } = ParseFields.extractKnownFields(
    fakeExtraction({ billingAddress: [], deliveryAddress: ['9 Oak Ave', 'Bristol', 'BS1 1AA'] })
  );
  assert.strictEqual(knownFields.address_first_line, '9 Oak Ave');
  const w = warnings.find((x) => x.field === 'address_first_line');
  assert.ok(w, 'expected an address warning anchored to address_first_line');
  assert.match(w.message, /Delivery Address/);
});

test('extractKnownFields warns with field=business_name when no name found', () => {
  const { warnings } = ParseFields.extractKnownFields(
    fakeExtraction({ labelValues: { 'First Name': '', 'Last Name': '' } })
  );
  const w = warnings.find((x) => x.field === 'business_name');
  assert.ok(w);
});

test('first_name falls back to first word of resolved name', () => {
  const { knownFields } = ParseFields.extractKnownFields(
    fakeExtraction({
      labelValues: { 'First Name': '', 'Last Name': '', 'Full Name': 'Alex Smith' },
    })
  );
  assert.strictEqual(knownFields.business_name, 'Alex Smith');
  assert.strictEqual(knownFields.first_name, 'Alex');
});

test('resolveFieldForToken matches exact, normalized, and alias forms', () => {
  const known = { business_name: 'Jane', post_code: 'TR1 2AB', porting_number: '447', consumer_plan: 'EE 20GB' };
  assert.strictEqual(ParseFields.resolveFieldForToken('business_name', known), 'Jane');
  assert.strictEqual(ParseFields.resolveFieldForToken('Post Code', known), 'TR1 2AB'); // normalized
  assert.strictEqual(ParseFields.resolveFieldForToken('porting number', known), '447'); // normalized
  assert.strictEqual(ParseFields.resolveFieldForToken('tariff', known), 'EE 20GB'); // alias
  assert.strictEqual(ParseFields.resolveFieldForToken('nonexistent_token', known), '');
});

test('canonicalKeyForToken returns the canonical key or null', () => {
  const known = { eligibility_date: '01/08/2026' };
  assert.strictEqual(ParseFields.canonicalKeyForToken('elligibity_date', known), 'eligibility_date'); // typo alias
  assert.strictEqual(ParseFields.canonicalKeyForToken('nope', known), null);
});
