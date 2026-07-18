// Injected into the active tab via chrome.scripting.executeScript.
// Pure DOM scraping only -- no parsing/business logic here, that lives in parseFields.js
// (which runs in the popup, so it stays unit-testable without a DOM).
//
// The CRM has (at least) two page shapes we need to cope with:
//  - a read-only "view order" page: <label class="form-label">X:</label><p>value</p>
//  - an editable "sales confirmation" form: <label class="form-label">X:</label><input/select/textarea>
// Both are handled generically below. Address blocks are extracted separately from the
// generic label walk because Billing and Delivery sections reuse the same label text
// ("City:", "Postcode:", ...) -- a flat label->value map would let one silently clobber
// the other, so those are read by their unique `name` attribute instead.
function extractPage() {
  function cleanText(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  const VALUE_TAGS = new Set(['P', 'INPUT', 'SELECT', 'TEXTAREA']);

  function readValue(el) {
    if (!el) return '';
    if (el.tagName === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      return opt ? opt.textContent.replace(/\s+/g, ' ').trim() : '';
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return (el.value || '').replace(/\s+/g, ' ').trim();
    }
    return cleanText(el);
  }

  // Generic label/value pairs: <label class="form-label">X:</label> followed by whichever
  // of <p>/<input>/<select>/<textarea> holds the actual value.
  const labelValues = {};
  document.querySelectorAll('label.form-label').forEach((label) => {
    const key = cleanText(label).replace(/:\s*$/, '').trim();
    if (!key) return;
    let sibling = label.nextElementSibling;
    while (sibling && !VALUE_TAGS.has(sibling.tagName)) sibling = sibling.nextElementSibling;
    labelValues[key] = readValue(sibling);
  });

  // The "Sales Confirmation" read-only summary (bold label <p> then a value <p> in the next
  // column) is server-rendered plain text, so it's a more reliable source than a same-named
  // <select> that may or may not have been hydrated with the saved value by client JS. Where
  // both exist, let this overwrite the label-walk result.
  (function mergeSalesConfirmationSummary() {
    const heading = Array.from(document.querySelectorAll('h5')).find(
      (h) => cleanText(h).toLowerCase() === 'sales confirmation'
    );
    if (!heading) return;
    const container = heading.parentElement;
    if (!container) return;
    container.querySelectorAll('p.fw-bold').forEach((boldP) => {
      const label = cleanText(boldP);
      if (!label) return;
      const labelWrapper = boldP.parentElement;
      const valueWrapper = labelWrapper ? labelWrapper.nextElementSibling : null;
      const valueP = valueWrapper ? valueWrapper.querySelector('p') : null;
      if (valueP) labelValues[label] = cleanText(valueP);
    });
  })();

  // Find a heading (h5/h4/etc, or a Bootstrap card-header div) whose text starts with the
  // given prefix, then return the text of every <p> inside the block immediately following it.
  // Fallback path for pages that render addresses/special requirements as static <p> stacks
  // rather than named form fields.
  function blockAfterHeading(prefix) {
    const headings = Array.from(document.querySelectorAll('h5, h4, h3, .card-header'));
    return headings.find((h) => cleanText(h).toUpperCase().startsWith(prefix)) || null;
  }

  function addressBlockAfterHeading(prefix) {
    const heading = blockAfterHeading(prefix);
    if (!heading) return [];
    let container = heading.nextElementSibling;
    while (container && !container.querySelector('p') && container.tagName !== 'P') {
      container = container.nextElementSibling;
    }
    if (!container) return [];
    const paras = container.tagName === 'P' ? [container] : Array.from(container.querySelectorAll('p'));
    return paras.map(cleanText);
  }

  function textBlockAfterHeading(prefix) {
    const heading = blockAfterHeading(prefix);
    if (!heading) return '';
    let el = heading.nextElementSibling;
    while (el) {
      const p = el.tagName === 'P' ? el : el.querySelector('p');
      if (p) return cleanText(p);
      el = el.nextElementSibling;
    }
    return '';
  }

  // getAddress.io shape: line1, line2, line3, town/city, county, country, postcode. Prefers
  // named inputs (billing_address_1, billing_city, ...) since those are unambiguous even when
  // Billing and Delivery share identical label text; falls back to the old <p>-stack layout.
  function namedAddressBlock(prefix) {
    const names = [
      `${prefix}_address_1`,
      `${prefix}_address_2`,
      `${prefix}_address_3`,
      `${prefix}_city`,
      `${prefix}_county`,
      `${prefix}_country`,
      `${prefix}_postcode`,
    ];
    const values = names.map((name) => readValue(document.querySelector(`[name="${name}"]`)));
    if (values.some(Boolean)) return values;
    return addressBlockAfterHeading(prefix.toUpperCase() + ' ADDRESS');
  }

  function specialRequirementsText() {
    const textarea = document.querySelector('textarea[name="special_requirement"]');
    if (textarea) return readValue(textarea);
    return textBlockAfterHeading('SPECIAL REQUIREMENT');
  }

  return {
    url: location.href,
    pageTitle: document.title,
    labelValues,
    billingAddress: namedAddressBlock('billing'),
    deliveryAddress: namedAddressBlock('delivery'),
    specialRequirements: specialRequirementsText(),
  };
}
