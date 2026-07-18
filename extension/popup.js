const REGISTRY_PATH = 'assets/templates/registry.json';
const TEMPLATES_DIR = 'assets/templates/';

const templateSelect = document.getElementById('templateSelect');
const extractBtn = document.getElementById('extractBtn');
const generateBtn = document.getElementById('generateBtn');
const statusEl = document.getElementById('status');
const formSection = document.getElementById('formSection');
const fieldsContainer = document.getElementById('fieldsContainer');
const noTokensNote = document.getElementById('noTokensNote');
const warningsBox = document.getElementById('warnings');
const warningsList = document.getElementById('warningsList');
const extraInfoBox = document.getElementById('extraInfo');
const fieldReferenceBox = document.getElementById('fieldReference');

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

// Mutable session state -- lives only while the popup is open.
const state = {
  templates: [], // [{id, label, file}]
  templateBuffers: new Map(), // id -> ArrayBuffer, fetched once per template per popup session
  knownFields: null, // broad field dictionary from the last extraction, or null before first extract
  extraInfo: null,
  currentTokens: [], // {{tokens}} of the currently selected template
};

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', Boolean(isError));
}

function renderWarnings(warnings) {
  warningsList.innerHTML = '';
  if (!warnings || !warnings.length) {
    warningsBox.classList.remove('show');
    return;
  }
  warnings.forEach((w) => {
    const li = document.createElement('li');
    li.textContent = w;
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
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('span');
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
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

function sanitizeFilenamePart(text) {
  return (text || 'Customer').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function currentTemplateMeta() {
  return state.templates.find((t) => t.id === templateSelect.value) || null;
}

async function getTemplateBuffer(id) {
  if (state.templateBuffers.has(id)) return state.templateBuffers.get(id);
  const meta = state.templates.find((t) => t.id === id);
  if (!meta) throw new Error(`Unknown template "${id}".`);

  const url = chrome.runtime.getURL(TEMPLATES_DIR + meta.file);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Could not load template "${meta.label}" (${resp.status}).`);
  const buffer = await resp.arrayBuffer();
  state.templateBuffers.set(id, buffer);
  return buffer;
}

async function loadRegistry() {
  const url = chrome.runtime.getURL(REGISTRY_PATH);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Could not load template registry (${resp.status}).`);
  const templates = await resp.json();
  if (!Array.isArray(templates) || !templates.length) {
    throw new Error('Template registry is empty.');
  }

  state.templates = templates;
  templateSelect.innerHTML = '';
  templates.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    templateSelect.appendChild(opt);
  });
}

// (Re)builds the input list to match whichever template is currently selected, prefilling
// from the last extraction's knownFields (if any extraction has happened yet this session).
async function renderFieldsForSelectedTemplate() {
  const meta = currentTemplateMeta();
  if (!meta) return;

  const buffer = await getTemplateBuffer(meta.id);
  const tokens = await DocxFill.listTemplateTokens(buffer);
  state.currentTokens = tokens;

  fieldsContainer.innerHTML = '';
  noTokensNote.style.display = tokens.length ? 'none' : 'block';

  tokens.forEach((token) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';

    const label = document.createElement('label');
    label.textContent = token;

    const input = document.createElement('input');
    input.dataset.token = token;
    input.value = state.knownFields ? ParseFields.resolveFieldForToken(token, state.knownFields) : '';

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    fieldsContainer.appendChild(wrapper);
  });
}

async function handleTemplateChange() {
  try {
    await renderFieldsForSelectedTemplate();
  } catch (err) {
    console.error(err);
    setStatus(`Could not load that template: ${err.message}`, true);
  }
}

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

    await renderFieldsForSelectedTemplate();
    renderExtraInfo(extraInfo);
    renderWarnings(warnings);
    formSection.classList.add('show');
    setStatus('Review the fields below, pick a template, then generate.');
  } catch (err) {
    console.error(err);
    setStatus(`Extraction failed: ${err.message}`, true);
  } finally {
    extractBtn.disabled = false;
  }
}

async function handleGenerate() {
  generateBtn.disabled = true;
  setStatus('Generating document...');

  try {
    const meta = currentTemplateMeta();
    if (!meta) throw new Error('No template selected.');

    const fieldMap = {};
    state.currentTokens.forEach((token) => {
      const input = fieldsContainer.querySelector(`input[data-token="${CSS.escape(token)}"]`);
      fieldMap[token] = input ? input.value.trim() : '';
    });

    const missing = state.currentTokens.filter((t) => !fieldMap[t]);
    if (missing.length) {
      const proceed = confirm(`These fields are empty: ${missing.join(', ')}.\nGenerate anyway?`);
      if (!proceed) {
        setStatus('Generation cancelled.');
        return;
      }
    }

    const buffer = await getTemplateBuffer(meta.id);
    const { blob, unresolvedKeys } = await DocxFill.generateContract(buffer, fieldMap);

    if (unresolvedKeys && unresolvedKeys.size) {
      console.warn('Tokens in the template with no matching field:', [...unresolvedKeys]);
    }

    const objectUrl = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    const customerName = (state.knownFields && state.knownFields['business_name']) || fieldMap['business_name'];
    const filename = `${meta.label} - ${sanitizeFilenamePart(customerName)} - ${dateStr}.docx`;

    await chrome.downloads.download({ url: objectUrl, filename, saveAs: false });

    setStatus(`${meta.label} downloaded. Pick another template to generate a different document from the same data.`);
  } catch (err) {
    console.error(err);
    setStatus(`Generation failed: ${err.message}`, true);
  } finally {
    generateBtn.disabled = false;
  }
}

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
}

templateSelect.addEventListener('change', handleTemplateChange);
extractBtn.addEventListener('click', handleExtract);
generateBtn.addEventListener('click', handleGenerate);

init();
