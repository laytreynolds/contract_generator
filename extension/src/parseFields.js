// Pure parsing/mapping logic -- no DOM access, runs in the popup on the JSON returned by
// extractPage.js. Kept dependency-free so it's easy to reason about / test in isolation.
//
// Warnings are structured as { field, message }: `field` is the canonical knownFields key the
// warning is about (so the popup can highlight the matching input), or null for page-level
// warnings that don't map to a single input.

const UK_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const UK_POSTCODE_SEARCH_RE = /([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/i;
const NAME_LIKE_RE = /^[A-Z][a-zA-Z'.-]*(?:\s+[A-Z][a-zA-Z'.-]*){0,3}$/;
const COUNTRY_WORDS = new Set(['uk', 'united kingdom', 'gb', 'great britain', 'england', 'scotland', 'wales']);

function isBlank(value) {
  if (value == null) return true;
  const v = String(value).trim();
  return v === '' || v === '-';
}

// A <select> with no option explicitly marked selected= reports its first option as "selected"
// by default -- usually a "Please Select" / "Select..." placeholder. Treat that the same as blank.
function isBlankField(value) {
  return isBlank(value) || /^(please\s*)?select\b/i.test(String(value || '').trim());
}

// "1955-03-30" -> "30/03/1955". Leaves anything not in that exact shape untouched.
function isoDateToUk(value) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (value || '').trim();
}

// "EE Consumer 20GB £12.95" -> { name: "EE Consumer 20GB", price: "12.95" }
// "Consumer Plan EE Essential 20GB @£12.95 Including Vat" -> same shape, ignoring "@" and trailing words.
function splitTrailingAmount(text) {
  if (!text) return null;
  const m = text.match(/^(.*?)\s*@?\s*[£$]\s*(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  return { name, price: m[2] };
}

// "David Watkins - 3152430 - Pending 22/07" -> "David Watkins"
function stripBusinessNameComposite(text) {
  const m = text.match(/^(.*?)\s*-\s*\d+\s*-\s*.+$/);
  return m ? m[1].trim() : text.trim();
}

// Takes the raw list of <p> lines from a Billing/Delivery address block (getAddress.io shape:
// line1, line2, line3, town, county, country, postcode -- several often blank/duplicated) and
// squashes it down to the 4 slots the contract template has.
function buildAddressFields(rawParts) {
  let parts = (rawParts || []).map((p) => (p || '').trim()).filter(Boolean);

  let postCode = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    if (UK_POSTCODE_RE.test(parts[i])) {
      postCode = parts[i].toUpperCase().replace(/\s+/g, ' ');
      parts.splice(i, 1);
      break;
    }
  }

  parts = parts.filter((p) => !COUNTRY_WORDS.has(p.toLowerCase()));

  const deduped = [];
  for (const p of parts) {
    if (deduped.length && deduped[deduped.length - 1].toLowerCase() === p.toLowerCase()) continue;
    deduped.push(p);
  }

  return {
    first: deduped[0] || '',
    second: deduped[1] || '',
    third: deduped.slice(2).join(', '),
    postCode,
  };
}

const SPECIAL_REQ_EXTRACTORS = [
  { key: 'quoteId', regex: /Quote\s*Id[:\s]*([0-9]+)/i },
  { key: 'pacCode', regex: /PAC\s*Code[:\s]*([A-Z0-9]+)/i },
  { key: 'spendCap', regex: /Spend\s*Cap[:\s]*(.+)/i },
  { key: 'sortCode', regex: /Sort\s*Code[:\s]*([\d-]+)/i },
  { key: 'accountNumber', regex: /Account\s*Number[:\s]*([\d]+)/i },
  { key: 'dob', regex: /\bDOB[:\s]*([\d]{1,2}\/[\d]{1,2}\/[\d]{2,4})/i },
  { key: 'portingMpn', regex: /(?:MPN|PORTING)[:\s]*([\d]{6,})/i },
  { key: 'email', regex: /([\w.+-]+@[\w-]+\.[\w.-]+)/ },
  { key: 'monthlyLineRental', regex: /Monthly\s*Line\s*Rental[:\s]*[£$]?\s*([\d.]+)/i },
  { key: 'buyout', regex: /Buyout[:\s]*[£$]?\s*([\d.]+)/i },
  { key: 'contractTerm', regex: /Contract\s*Term[:\s]*(.+)/i },
  { key: 'handsetRequired', regex: /Handset\s*Required[:\s]*(.+)/i },
];

function parseSpecialRequirements(specialReqText) {
  const segments = (specialReqText || '')
    .split('***')
    .map((s) => s.trim())
    .filter(Boolean);

  const extraInfo = {};
  const claimed = new Array(segments.length).fill(false);

  segments.forEach((segment, idx) => {
    for (const { key, regex } of SPECIAL_REQ_EXTRACTORS) {
      const m = segment.match(regex);
      if (m) {
        extraInfo[key] = (m[1] || '').trim();
        claimed[idx] = true;
      }
    }
    // Several segments can mention a price (plan cost, monthly line rental, buyout, box
    // value); only the first unclaimed one is taken as "the" plan/price segment so a later
    // charge line can't clobber the actual plan description.
    if (!claimed[idx] && !extraInfo.planSegment && /[£$]\s*\d/.test(segment)) {
      extraInfo.planSegment = segment;
      claimed[idx] = true;
    }
    if (!claimed[idx] && UK_POSTCODE_SEARCH_RE.test(segment) && /[a-z]/i.test(segment)) {
      extraInfo.addressSummary = segment;
      claimed[idx] = true;
    }
  });

  if (extraInfo.sortCode) {
    const bankSeg = segments.find((s) => /Sort\s*Code/i.test(s));
    if (bankSeg) {
      const bankName = bankSeg
        .replace(/^Bank\s*Details[:\s]*/i, '')
        .split(/-?\s*Sort\s*Code/i)[0]
        .trim();
      if (bankName) extraInfo.bankName = bankName;
    }
  }

  let nameFromSpecialReq = '';
  for (let i = 0; i < segments.length; i++) {
    if (!claimed[i] && NAME_LIKE_RE.test(segments[i])) {
      nameFromSpecialReq = segments[i];
      break;
    }
  }

  return { extraInfo, nameFromSpecialReq };
}

function resolveBusinessName(labelValues, specialReqName, warnings) {
  const businessType = labelValues['Business Type'] || '';
  const businessNameRaw = labelValues['Business Name'] || '';
  const fullName = labelValues['Full Name'] || '';
  const firstName = labelValues['First Name'] || '';
  const lastName = labelValues['Last Name'] || '';

  let name;
  if (!isBlank(firstName) || !isBlank(lastName)) {
    // First/Last Name are separate, reliably-populated fields -- prefer them outright over the
    // Business Name field, which on consumer sales is a dirty composite like
    // "David Watkins - 3152430 - Pending 22/07" rather than a clean name.
    name = [firstName, lastName].filter((p) => !isBlank(p)).join(' ').trim();
  } else if (!isBlankField(businessType)) {
    name = businessNameRaw.trim();
  } else if (!isBlank(businessNameRaw)) {
    name = stripBusinessNameComposite(businessNameRaw);
  } else if (!isBlank(fullName)) {
    name = fullName.trim();
  } else {
    name = '';
  }

  if (!name && specialReqName) {
    name = specialReqName;
  } else if (name && specialReqName && name.toLowerCase() !== specialReqName.toLowerCase()) {
    warnings.push({
      field: 'business_name',
      message: `Customer name from the page ("${name}") and from Special Requirements ("${specialReqName}") don't match - please verify.`,
    });
  }

  if (!name) warnings.push({ field: 'business_name', message: 'Could not determine a customer name - please fill it in manually.' });
  return name;
}

// Separate from resolveBusinessName's combined "First Last" -- some templates (e.g. a welcome
// letter salutation) want just the first name. Prefers the literal First Name label when present;
// otherwise falls back to the first word of whatever name was already resolved above (which
// covers the Business Name / Full Name / Special Requirements fallback paths too).
function resolveFirstName(labelValues, businessName) {
  const firstName = labelValues['First Name'] || '';
  if (!isBlank(firstName)) return firstName.trim();
  return businessName ? businessName.trim().split(/\s+/)[0] : '';
}

function resolvePlanAndPrice(labelValues, planSegmentRaw, warnings) {
  // "New Tariff" on the old read-only page, just "Tariff" on the newer sales-confirmation form.
  const tariffField = labelValues['New Tariff'] || labelValues['Tariff'] || '';
  let source = tariffField;
  let usedFallback = false;

  if (isBlank(source)) {
    source = planSegmentRaw || '';
    usedFallback = true;
  }

  const split = splitTrailingAmount(source);
  if (!split) {
    if (source) warnings.push({ field: 'price', message: `Could not find a price in "${source}" - please fill Plan / price manually.` });
    else warnings.push({ field: 'consumer_plan', message: 'No plan/price found on the page - please fill Plan / price manually.' });
    return { plan: source.trim(), price: '' };
  }

  if (usedFallback) {
    warnings.push({ field: 'consumer_plan', message: 'Plan and price were pulled from Special Requirements text (the Tariff field was blank) - please double check.' });
  }

  return { plan: split.name, price: split.price };
}

function resolveAddress(billingAddress, deliveryAddress, addressSummary, warnings) {
  let address = buildAddressFields(billingAddress);
  if (!address.first && !address.postCode && deliveryAddress && deliveryAddress.length) {
    address = buildAddressFields(deliveryAddress);
    if (address.first || address.postCode) {
      warnings.push({ field: 'address_first_line', message: 'Billing Address was empty - address was taken from Delivery Address instead.' });
    }
  }
  if (!address.first && !address.postCode && addressSummary) {
    const postMatch = addressSummary.match(UK_POSTCODE_SEARCH_RE);
    const postCode = postMatch ? postMatch[1].toUpperCase().replace(/\s+/g, ' ') : '';
    const rest = postMatch ? addressSummary.replace(postMatch[1], '').replace(/,\s*$/, '').trim() : addressSummary;
    address = { first: rest, second: '', third: '', postCode };
    warnings.push({ field: 'address_first_line', message: 'Address was parsed from Special Requirements free text - please check it carefully.' });
  }
  if (!address.first && !address.postCode) {
    warnings.push({ field: 'address_first_line', message: 'No address found on the page - please fill the address fields manually.' });
  }
  return address;
}

function todayUk() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function nowUk() {
  const d = new Date();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${todayUk()} ${time}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// 1 -> "st", 2 -> "nd", 3 -> "rd", 4 -> "th", 11-13 -> "th", 21 -> "st", ...
function ordinalSuffix(day) {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

// -> "17th July 2026"
function formattedDateLong() {
  const d = new Date();
  const day = d.getDate();
  return `${day}${ordinalSuffix(day)} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

// One-line "123 Main St, Second Line, Town, County, POSTCODE" style address for templates
// (e.g. a Key Contract Information sheet) that want a single address field rather than
// separate line-by-line ones.
function joinAddress(address) {
  return [address.first, address.second, address.third, address.postCode].filter(Boolean).join(', ');
}

// "EE Consumer 20GB" -> "20", "EE Essential Unlimited" -> "Unlimited". The plan name already
// carries the data allowance, but templates that print their own "GB of data" suffix need just
// the number (or the word "Unlimited") on its own, not "20GB" again.
function parseDataAllowance(planText) {
  if (!planText) return '';
  const gbMatch = planText.match(/(\d+)\s*GB/i);
  if (gbMatch) return gbMatch[1];
  if (/unlimited/i.test(planText)) return 'Unlimited';
  return '';
}

// rawExtraction: the object returned by extractPage()
// Returns { knownFields, extraInfo, warnings }. knownFields is a broad dictionary of every
// value we could pull out of the page (not just the Customer Contract's 7 tokens) so that
// other templates (welcome letters, etc.) with a different set of {{tokens}} can still be
// prefilled -- see resolveFieldForToken() below for how a template's tokens get matched
// against these keys.
function extractKnownFields(rawExtraction) {
  const warnings = [];
  const labelValues = rawExtraction.labelValues || {};

  const { extraInfo, nameFromSpecialReq } = parseSpecialRequirements(rawExtraction.specialRequirements);

  const businessName = resolveBusinessName(labelValues, nameFromSpecialReq, warnings);
  const firstName = resolveFirstName(labelValues, businessName);
  const { plan, price } = resolvePlanAndPrice(labelValues, extraInfo.planSegment, warnings);
  const address = resolveAddress(
    rawExtraction.billingAddress,
    rawExtraction.deliveryAddress,
    extraInfo.addressSummary,
    warnings
  );

  const knownFields = {
    business_name: businessName,
    first_name: firstName,
    address_first_line: address.first,
    address_second_line: address.second,
    address_third_line: address.third,
    post_code: address.postCode,
    customer_full_address: joinAddress(address),
    consumer_plan: plan,
    price,
    // The resolved plan name doesn't always mention capacity (e.g. a structured "Tariff" field
    // that just says "Plan EE Consumer £16.95") even when the Special Requirements text does
    // (e.g. "...EE Unlimited..."), so fall back to that raw segment too.
    data_allowance: parseDataAllowance(plan) || parseDataAllowance(extraInfo.planSegment) || '',
    email_address: (!isBlank(labelValues['Email Address']) && labelValues['Email Address']) || extraInfo.email || '',
    mobile_number: (!isBlank(labelValues['Mobile Number']) && labelValues['Mobile Number']) || '',
    quote_id: extraInfo.quoteId || (!isBlank(labelValues['Quote Id']) && labelValues['Quote Id']) || '',
    pac_code: extraInfo.pacCode || '',
    porting_number: extraInfo.portingMpn || '',
    spend_cap: extraInfo.spendCap || (!isBlank(labelValues['Spend Cap']) && labelValues['Spend Cap']) || '',
    bank_name: extraInfo.bankName || '',
    sort_code: extraInfo.sortCode || '',
    account_number: extraInfo.accountNumber || '',
    // A real "Date Of Birth" input (ISO yyyy-mm-dd) is more trustworthy than a DOB mentioned in
    // free-text Special Requirements, so it's preferred when present.
    date_of_birth: (!isBlank(labelValues['Date Of Birth']) && isoDateToUk(labelValues['Date Of Birth'])) || extraInfo.dob || '',
    agent_name: (!isBlank(labelValues['Agent Name']) && labelValues['Agent Name']) || '',
    eligibility_date: (!isBlank(labelValues['Eligibility Date']) && isoDateToUk(labelValues['Eligibility Date'])) || '',
    sale_type: (!isBlankField(labelValues['Sale Type']) && labelValues['Sale Type']) || '',
    monthly_line_rental: extraInfo.monthlyLineRental || '',
    contract_term: extraInfo.contractTerm || '',
    todays_date: todayUk(),
    now_datetime: nowUk(),
    formatted_date: formattedDateLong(),
  };

  return { knownFields, extraInfo, warnings };
}

// Normalizes a field/token name for fuzzy matching: lowercase, letters+digits only.
// So "Post Code", "postcode", "Post-Code" all compare equal.
function normalizeKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Canonical field list + alternate spellings live in fieldSchema.js (the reference to check
// when wording a new template's {{tokens}}), not here -- this just flattens it into the
// normalized-alias -> canonical-key lookup resolveFieldForToken() needs.
const FieldSchemaSource =
  (typeof window !== 'undefined' && window.FieldSchema) ||
  (typeof module !== 'undefined' && module.exports && (() => { try { return require('./fieldSchema'); } catch (e) { return null; } })()) ||
  [];

const FIELD_ALIASES = {};
FieldSchemaSource.forEach(({ key, aliases }) => {
  (aliases || []).forEach((alias) => {
    FIELD_ALIASES[normalizeKey(alias)] = key;
  });
});

// Maps a template's {{token}} name to the canonical knownFields key it reads from: exact match
// first, then normalized match, then the alias table. Returns null when nothing matches. Used
// both for value lookup and for anchoring field-level warnings to whichever input shows that field.
function canonicalKeyForToken(token, knownFields) {
  if (Object.prototype.hasOwnProperty.call(knownFields, token)) return token;
  const norm = normalizeKey(token);
  for (const key of Object.keys(knownFields)) {
    if (normalizeKey(key) === norm) return key;
  }
  const aliasTarget = FIELD_ALIASES[norm];
  if (aliasTarget && Object.prototype.hasOwnProperty.call(knownFields, aliasTarget)) return aliasTarget;
  return null;
}

// Returns '' (not undefined) when nothing matches so callers can leave the input blank for
// manual entry rather than throwing.
function resolveFieldForToken(token, knownFields) {
  const key = canonicalKeyForToken(token, knownFields);
  return key ? knownFields[key] || '' : '';
}

const ParseFields = {
  extractKnownFields,
  resolveFieldForToken,
  canonicalKeyForToken,
  buildAddressFields,
  splitTrailingAmount,
  stripBusinessNameComposite,
  parseSpecialRequirements,
  todayUk,
  nowUk,
  formattedDateLong,
  normalizeKey,
};

if (typeof window !== 'undefined') {
  window.ParseFields = ParseFields;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ParseFields;
}
