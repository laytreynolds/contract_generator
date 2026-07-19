# Chadwell CRM Contract Generator

A Chrome extension that extracts customer details from a Chadwell CRM order page and generates
filled `.docx` documents (customer contract, contract information sheet, welcome letter) from
Word templates. No build step, no runtime dependencies — plain scripts plus a bundled
[JSZip](https://stuk.github.io/jszip/).

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Pin the extension. Open a CRM order page, click the icon.

## Usage

1. On a CRM order / sales confirmation page, click **Extract from this page**.
2. Review the pre-filled fields. Amber inputs carry a warning (shown beneath the input) —
   values that came from fallbacks or looked suspect. Fix anything that's wrong.
3. Pick a template and **Generate Document**, or **Generate All Documents** to download every
   template filled with the same data.
4. Extracted data and your manual edits survive the popup closing (stored in
   `chrome.storage.session`, cleared when the browser closes or via the **Clear** button).

Extra values that don't appear in the template (bank details, PAC code, etc.) are listed under
*Extra reference info* — click a row to copy it.

## Templates

Templates are `.docx` files containing `{{tokens}}`. At generation time each token is replaced
with the matching extracted field; formatting around the token is preserved.

- Canonical token names and their aliases live in [`extension/src/fieldSchema.js`](extension/src/fieldSchema.js) —
  the single source of truth. The popup's *Field reference* section lists them too.
- Token matching is forgiving: `{{Post Code}}`, `{{post_code}}`, and `{{postal_code}}` all
  resolve to the same field. Unknown tokens are left blank in the popup for manual entry.
- No templates ship with the extension or live in this repo — they're imported per-browser-profile.
  Open the extension's options page (right-click the icon → Options, or the popup's *Manage
  templates* link) and upload a `.docx`. Tokens are validated against the schema at upload time
  (green chips auto-fill, red ones need manual entry); the template is stored in
  `chrome.storage.local` and appears in the popup's dropdown from then on. A fresh install starts
  with zero templates until you import some.

Adding a genuinely new field means adding it to `fieldSchema.js` **and** producing a value for
it in `extractKnownFields()` in [`extension/src/parseFields.js`](extension/src/parseFields.js).
If a template merely spells an existing field differently, add an alias in `fieldSchema.js`.

## Architecture

| File | Runs in | Role |
|---|---|---|
| `extension/src/extractPage.js` | CRM page (injected) | Pure DOM scraping, no business logic |
| `extension/src/parseFields.js` | popup | Pure parsing: raw scrape → canonical fields + warnings |
| `extension/src/fieldSchema.js` | popup/options | Canonical field names, descriptions, aliases |
| `extension/src/docxFill.js` | popup/options | `{{token}}` merge into `word/document.xml` (handles tokens split across Word runs) |
| `extension/src/templateStore.js` | popup/options | Imported template registry, stored in `chrome.storage.local` |
| `extension/popup.js` | popup | UI, session persistence, generation |
| `extension/src/options.js` | options page | Custom template upload/validation/management |

`parseFields.js`, `docxFill.js`, `fieldSchema.js` are dependency-free CommonJS-compatible
modules so they run under Node for testing exactly as they run in the browser.

## Development

```bash
npm test        # Node's built-in test runner; no npm install needed
```

Tests cover the parsing logic and the docx merge engine (including tokens split across runs and
repeated tokens). Template token validation happens live in the options page at upload time
rather than in CI, since templates are no longer stored in the repo.

`template_source.html` at the repo root is a saved snapshot of a CRM order page, kept as
reference for the selectors in `extractPage.js`.
