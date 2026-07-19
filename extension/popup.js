const templateSelect = document.getElementById('templateSelect');
const extractBtn = document.getElementById('extractBtn');
const generateBtn = document.getElementById('generateBtn');
const generateAllBtn = document.getElementById('generateAllBtn');
const statusEl = document.getElementById('status');
const formSection = document.getElementById('formSection');
const fieldsContainer = document.getElementById('fieldsContainer');
const noTokensNote = document.getElementById('noTokensNote');
const warningsBox = document.getElementById('warnings');
const warningsList = document.getElementById('warningsList');
const extraInfoBox = document.getElementById('extraInfo');
const fieldReferenceBox = document.getElementById('fieldReference');
const restoreBanner = document.getElementById('restoreBanner');
const restoreBannerText = document.getElementById('restoreBannerText');
const clearRestoredBtn = document.getElementById('clearRestoredBtn');

const SESSION_KEY = 'extractionState';

const EXTRA_INFO_LABELS = {
  quoteId: 'Quote ID',
  pacCode: 'PAC Code',
  spendCap: 'Spend Cap',
  bankName: 'Bank',
  sortCode: 'Sort Code',
  accountNumber: 'Account Number',
  dob: 'Date of Birth',
  portingMpn: 'Porting MPN',
  email: 'Email (from Special Requirements)',
  monthlyLineRental: 'Monthly Line Rental',
  buyout: 'Buyout',
  contractTerm: 'Contract Term',
  handsetRequired: 'Handset Required',
};

// Mutable popup state. Everything that must survive the popup closing (which happens as soon
// as the user clicks back onto the CRM page) is mirrored to chrome.storage.session via
// saveSessionState() and restored in init().
const state = {
  templates: [], // merged bundled + custom registry entries
  knownFields: null, // broad field dictionary from the last extraction, or null before first extract
  extraInfo: null,
  warnings: [], // [{field, message}]
  manualOverrides: {}, // token -> user-typed value; wins over auto-resolved values on render
  sourceTitle: '',
  extractedAt: null, // ISO string
  currentTokens: [], // {{tokens}} of the currently selected template
  emptyConfirmArmed: null, // 'one' | 'all' | null -- two-click "generate anyway" state
};

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', Boolean(isError));
}

// ---------- session persistence ----------

function persistedShape() {
  return {
    knownFields: state.knownFields,
    extraInfo: state.extraInfo,
    warnings: state.warnings,
    manualOverrides: state.manualOverrides,
    selectedTemplateId: templateSelect.value,
    sourceTitle: state.sourceTitle,
    extractedAt: state.extractedAt,
  };
}

let saveTimer = null;
function saveSessionState(immediate) {
  if (saveTimer) clearTimeout(saveTimer);
  const doSave = () => {
    saveTimer = null;
    if (!state.knownFields) return;
    chrome.storage.session.set({ [SESSION_KEY]: persistedShape() });
  };
  if (immediate) doSave();
  else saveTimer = setTimeout(doSave, 300);
}

async function restoreSessionState() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const saved = stored[SESSION_KEY];
  if (!saved || !saved.knownFields) return false;

  state.knownFields = saved.knownFields;
  state.extraInfo = saved.extraInfo || null;
  state.warnings = saved.warnings || [];
  state.manualOverrides = saved.manualOverrides || {};
  state.sourceTitle = saved.sourceTitle || '';
  state.extractedAt = saved.extractedAt || null;

  if (saved.selectedTemplateId && state.templates.some((t) => t.id === saved.selectedTemplateId)) {
    templateSelect.value = saved.selectedTemplateId;
  }

  await renderFieldsForSelectedTemplate();
  renderExtraInfo(state.extraInfo);
  formSection.classList.add('show');

  const when = state.extractedAt
    ? new Date(state.extractedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  restoreBannerText.textContent = `Restored: ${state.sourceTitle || 'earlier extraction'}${when ? ` (${when})` : ''}`;
  restoreBanner.classList.add('show');
  return true;
}

async function clearSessionState() {
  await chrome.storage.session.remove(SESSION_KEY);
  state.knownFields = null;
  state.extraInfo = null;
  state.warnings = [];
  state.manualOverrides = {};
  state.sourceTitle = '';
  state.extractedAt = null;
  resetEmptyConfirm();
  formSection.classList.remove('show');
  restoreBanner.classList.remove('show');
  renderWarningsBox([]);
  setStatus('Cleared. Extract from a CRM page to start again.');
}

// ---------- rendering ----------

// Warnings whose `field` matches an input of the current template render inline under that
// input; everything else (page-level warnings, or field warnings with no matching input on
// this template) goes in the summary box so nothing is silently dropped.
function renderWarningsBox(warnings) {
  warningsList.innerHTML = '';
  if (!warnings || !warnings.length) {
    warningsBox.classList.remove('show');
    return;
  }
  warnings.forEach((w) => {
    const li = document.createElement('li');
    li.textContent = w.message || String(w);
    warningsList.appendChild(li);
  });
  warningsBox.classList.add('show');
}

function renderExtraInfo(extraInfo) {
  extraInfoBox.innerHTML = '';
  const entries = Object.keys(EXTRA_INFO_LABELS)
    .filter((k) => extraInfo && extraInfo[k])
    .map((k) => [EXTRA_INFO_LABELS[k], extraInfo[k]]);

  if (!entries.length) {
    extraInfoBox.textContent = 'Nothing extra found.';
    return;
  }
  entries.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.title = 'Click to copy';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('span');
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    row.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        const original = v.textContent;
        row.classList.add('copied');
        v.textContent = 'Copied!';
        setTimeout(() => {
          row.classList.remove('copied');
          v.textContent = original;
        }, 900);
      } catch (e) {
        console.warn('Clipboard write failed', e);
      }
    });
    extraInfoBox.appendChild(row);
  });
}

// Static reference of every canonical field name a template can use as {{Token}} -- kept in
// sync automatically since it's read straight from fieldSchema.js rather than duplicated here.
function renderFieldReference() {
  fieldReferenceBox.innerHTML = '';
  (FieldSchema || []).forEach(({ key, description }) => {
    const row = document.createElement('div');
    row.className = 'row';
    const code = document.createElement('code');
    code.textContent = `{{${key}}}`;
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = description || '';
    row.appendChild(code);
    row.appendChild(desc);
    fieldReferenceBox.appendChild(row);
  });
}

function autoValueForToken(token) {
  return state.knownFields ? ParseFields.resolveFieldForToken(token, state.knownFields) : '';
}

function valueForToken(token) {
  if (Object.prototype.hasOwnProperty.call(state.manualOverrides, token)) {
    return state.manualOverrides[token];
  }
  return autoValueForToken(token);
}

// (Re)builds the input list to match whichever template is currently selected, prefilling from
// the last extraction (manual edits win over auto values), and anchoring field-level warnings
// to their inputs.
async function renderFieldsForSelectedTemplate() {
  const meta = currentTemplateMeta();
  if (!meta) return;

  const buffer = await TemplateStore.getTemplateBuffer(meta);
  const tokens = await DocxFill.listTemplateTokens(buffer);
  state.currentTokens = tokens;
  resetEmptyConfirm();

  fieldsContainer.innerHTML = '';
  noTokensNote.style.display = tokens.length ? 'none' : 'block';

  const inlineFields = new Set();
  tokens.forEach((token) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';

    const label = document.createElement('label');
    label.textContent = token;

    const input = document.createElement('input');
    input.dataset.token = token;
    input.value = valueForToken(token);

    wrapper.appendChild(label);
    wrapper.appendChild(input);

    const canonical = state.knownFields ? ParseFields.canonicalKeyForToken(token, state.knownFields) : null;
    state.warnings
      .filter((w) => w.field && w.field === canonical)
      .forEach((w) => {
        inlineFields.add(w);
        input.classList.add('warned');
        const note = document.createElement('div');
        note.className = 'field-warning';
        note.textContent = w.message;
        wrapper.appendChild(note);
      });

    input.addEventListener('input', () => {
      state.manualOverrides[token] = input.value;
      resetEmptyConfirm();
      saveSessionState(false);
    });

    fieldsContainer.appendChild(wrapper);
  });

  renderWarningsBox(state.warnings.filter((w) => !inlineFields.has(w)));
}

// ---------- empty-field two-click confirm ----------

function resetEmptyConfirm() {
  if (!state.emptyConfirmArmed) return;
  state.emptyConfirmArmed = null;
  generateBtn.textContent = 'Generate Document (.docx)';
  generateBtn.classList.remove('confirm-empty');
  generateAllBtn.textContent = 'Generate All Documents';
  generateAllBtn.classList.remove('confirm-empty');
  fieldsContainer.querySelectorAll('input.empty-flagged').forEach((i) => i.classList.remove('empty-flagged'));
}

// Highlights empty inputs and arms the pressed button; returns true when generation should
// proceed (either nothing is empty, or this is the second click while armed).
function confirmEmptyFields(which, emptyTokens, button) {
  if (!emptyTokens.length) return true;
  if (state.emptyConfirmArmed === which) return true;

  resetEmptyConfirm();
  state.emptyConfirmArmed = which;
  fieldsContainer.querySelectorAll('input').forEach((input) => {
    if (emptyTokens.includes(input.dataset.token)) input.classList.add('empty-flagged');
  });
  button.textContent = `Generate anyway (${emptyTokens.length} empty)`;
  button.classList.add('confirm-empty');
  setStatus(`${emptyTokens.length} field${emptyTokens.length === 1 ? ' is' : 's are'} empty - click again to generate anyway.`);
  return false;
}

// ---------- template loading ----------

function currentTemplateMeta() {
  return state.templates.find((t) => t.id === templateSelect.value) || null;
}

async function loadRegistry() {
  const templates = await TemplateStore.loadMergedRegistry();
  state.templates = templates;
  templateSelect.innerHTML = '';
  templates.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    templateSelect.appendChild(opt);
  });
}

async function handleTemplateChange() {
  try {
    await renderFieldsForSelectedTemplate();
    saveSessionState(true);
  } catch (err) {
    console.error(err);
    setStatus(`Could not load that template: ${err.message}`, true);
  }
}

// ---------- extract ----------

async function handleExtract() {
  extractBtn.disabled = true;
  setStatus('Reading the current page...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab found.');

    const [injectionResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
    });

    if (!injectionResult || !injectionResult.result) {
      throw new Error('Could not read anything from this page.');
    }

    const raw = injectionResult.result;
    const { knownFields, extraInfo, warnings } = ParseFields.extractKnownFields(raw);

    state.knownFields = knownFields;
    state.extraInfo = extraInfo;
    state.warnings = warnings;
    state.manualOverrides = {}; // fresh extraction supersedes old hand edits
    state.sourceTitle = raw.pageTitle || raw.url || '';
    state.extractedAt = new Date().toISOString();
    restoreBanner.classList.remove('show');

    await renderFieldsForSelectedTemplate();
    renderExtraInfo(extraInfo);
    formSection.classList.add('show');
    saveSessionState(true);
    setStatus('Review the fields below, pick a template, then generate.');
  } catch (err) {
    console.error(err);
    setStatus(`Extraction failed: ${err.message}`, true);
  } finally {
    extractBtn.disabled = false;
  }
}

// ---------- generate ----------

function sanitizeFilenamePart(text) {
  return (text || 'Customer').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Object URLs are revoked once Chrome reports the download finished (or after a fallback
// timeout), instead of leaking one blob per generated document.
const pendingObjectUrls = new Map(); // downloadId -> objectUrl

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !pendingObjectUrls.has(delta.id)) return;
  if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
    URL.revokeObjectURL(pendingObjectUrls.get(delta.id));
    pendingObjectUrls.delete(delta.id);
  }
});

async function downloadBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({ url: objectUrl, filename, saveAs: false });
    pendingObjectUrls.set(downloadId, objectUrl);
    setTimeout(() => {
      if (pendingObjectUrls.has(downloadId)) {
        URL.revokeObjectURL(objectUrl);
        pendingObjectUrls.delete(downloadId);
      }
    }, 60000);
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

function buildFilename(meta, fieldMap) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const customerName =
    fieldMap['business_name'] || (state.knownFields && state.knownFields['business_name']) || '';
  return `${meta.label.replace(/ \(custom\)$/, '')} - ${sanitizeFilenamePart(customerName)} - ${dateStr}.docx`;
}

// Builds a template's fieldMap from the extraction + manual overrides. For the currently
// selected template the on-screen inputs hold the same values (edits are mirrored into
// manualOverrides as the user types), so one code path serves both Generate buttons.
function buildFieldMap(tokens) {
  const fieldMap = {};
  tokens.forEach((token) => {
    fieldMap[token] = String(valueForToken(token) || '').trim();
  });
  return fieldMap;
}

async function generateOne(meta, tokens) {
  const fieldMap = buildFieldMap(tokens);
  const buffer = await TemplateStore.getTemplateBuffer(meta);
  const { blob, unresolvedKeys } = await DocxFill.generateContract(buffer, fieldMap);
  if (unresolvedKeys && unresolvedKeys.size) {
    console.warn(`Tokens in "${meta.label}" with no matching field:`, [...unresolvedKeys]);
  }
  await downloadBlob(blob, buildFilename(meta, fieldMap));
}

async function handleGenerate() {
  try {
    const meta = currentTemplateMeta();
    if (!meta) throw new Error('No template selected.');

    const fieldMap = buildFieldMap(state.currentTokens);
    const missing = state.currentTokens.filter((t) => !fieldMap[t]);
    if (!confirmEmptyFields('one', missing, generateBtn)) return;
    resetEmptyConfirm();

    generateBtn.disabled = true;
    setStatus('Generating document...');
    await generateOne(meta, state.currentTokens);
    setStatus(`${meta.label} downloaded. Pick another template to generate a different document from the same data.`);
  } catch (err) {
    console.error(err);
    setStatus(`Generation failed: ${err.message}`, true);
  } finally {
    generateBtn.disabled = false;
  }
}

async function handleGenerateAll() {
  try {
    if (!state.templates.length) throw new Error('No templates available.');

    // Token lists for every template, so empties can be aggregated before generating anything.
    const perTemplate = [];
    const missing = new Set();
    for (const meta of state.templates) {
      const buffer = await TemplateStore.getTemplateBuffer(meta);
      const tokens = await DocxFill.listTemplateTokens(buffer);
      perTemplate.push({ meta, tokens });
      tokens.forEach((t) => {
        if (!String(valueForToken(t) || '').trim()) missing.add(t);
      });
    }
    if (!confirmEmptyFields('all', [...missing], generateAllBtn)) return;
    resetEmptyConfirm();

    generateAllBtn.disabled = true;
    generateBtn.disabled = true;
    for (let i = 0; i < perTemplate.length; i++) {
      const { meta, tokens } = perTemplate[i];
      setStatus(`Generating ${i + 1}/${perTemplate.length}: ${meta.label}...`);
      await generateOne(meta, tokens);
    }
    setStatus(`All ${perTemplate.length} documents downloaded.`);
  } catch (err) {
    console.error(err);
    setStatus(`Generation failed: ${err.message}`, true);
  } finally {
    generateAllBtn.disabled = false;
    generateBtn.disabled = false;
  }
}

// ---------- init ----------

async function init() {
  renderFieldReference();
  extractBtn.disabled = true;
  try {
    await loadRegistry();
  } catch (err) {
    console.error(err);
    setStatus(`Could not load templates: ${err.message}`, true);
    return;
  } finally {
    extractBtn.disabled = false;
  }

  try {
    await restoreSessionState();
  } catch (err) {
    console.error('Could not restore previous extraction', err);
  }
}

templateSelect.addEventListener('change', handleTemplateChange);
extractBtn.addEventListener('click', handleExtract);
generateBtn.addEventListener('click', handleGenerate);
generateAllBtn.addEventListener('click', handleGenerateAll);
clearRestoredBtn.addEventListener('click', clearSessionState);

init();
