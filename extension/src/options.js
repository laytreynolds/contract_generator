// Options page: manage .docx templates imported into chrome.storage.local (see
// templateStore.js). Uploads are validated by listing their {{tokens}} and checking each one
// against the canonical field schema, so authors see before saving which fields will auto-fill.

const fileInput = document.getElementById('fileInput');
const uploadPreview = document.getElementById('uploadPreview');
const previewName = document.getElementById('previewName');
const previewTokens = document.getElementById('previewTokens');
const labelInput = document.getElementById('labelInput');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const templateList = document.getElementById('templateList');

// Running extractKnownFields on an empty page yields a dictionary containing every canonical
// key (all blank) -- exactly the key set canonicalKeyForToken() matches tokens against, without
// duplicating the schema here.
const EMPTY_KNOWN_FIELDS = ParseFields.extractKnownFields({
  labelValues: {},
  billingAddress: [],
  deliveryAddress: [],
  specialRequirements: '',
}).knownFields;

function tokenResolves(token) {
  return ParseFields.canonicalKeyForToken(token, EMPTY_KNOWN_FIELDS) !== null;
}

let pendingUpload = null; // { buffer, tokens, suggestedLabel }

function setStatus(message, kind) {
  statusEl.textContent = message || '';
  statusEl.className = kind || '';
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'template';
}

function renderTokenChips(container, tokens) {
  container.innerHTML = '';
  if (!tokens.length) {
    const span = document.createElement('span');
    span.className = 'legend';
    span.textContent = 'No {{tokens}} found in this document.';
    container.appendChild(span);
    return;
  }
  tokens.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = tokenResolves(t) ? 'token' : 'token bad';
    chip.textContent = `{{${t}}}`;
    container.appendChild(chip);
  });
}

async function handleFileChosen() {
  pendingUpload = null;
  uploadPreview.classList.remove('show');
  setStatus('');

  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  try {
    const buffer = await file.arrayBuffer();
    const tokens = await DocxFill.listTemplateTokens(buffer); // also validates it's a real .docx
    const suggestedLabel = file.name.replace(/\.docx$/i, '').replace(/[-_]+/g, ' ').trim();

    pendingUpload = { buffer, tokens, suggestedLabel };
    previewName.textContent = file.name;
    renderTokenChips(previewTokens, tokens);
    labelInput.value = suggestedLabel;
    uploadPreview.classList.add('show');
  } catch (err) {
    console.error(err);
    setStatus(`Could not read that file: ${err.message}`, 'error');
  }
}

async function handleSave() {
  if (!pendingUpload) return;
  const label = labelInput.value.trim();
  if (!label) {
    setStatus('Please give the template a name.', 'error');
    return;
  }

  saveBtn.disabled = true;
  try {
    const id = `custom-${slugify(label)}`;
    await TemplateStore.saveTemplate({ id, label, buffer: pendingUpload.buffer });
    setStatus(`Saved "${label}". It now appears in the popup's template dropdown.`, 'ok');
    pendingUpload = null;
    fileInput.value = '';
    uploadPreview.classList.remove('show');
    await renderLists();
  } catch (err) {
    console.error(err);
    setStatus(`Could not save template: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
  }
}

async function templateCard(meta) {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'head';
  const left = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = meta.label;
  const metaLine = document.createElement('div');
  metaLine.className = 'meta';
  metaLine.textContent = `Added ${new Date(meta.addedAt).toLocaleDateString()} - ${(meta.size / 1024).toFixed(0)} KB`;
  left.appendChild(name);
  left.appendChild(metaLine);
  head.appendChild(left);

  const del = document.createElement('button');
  del.className = 'danger';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    await TemplateStore.deleteTemplate(meta.id);
    setStatus(`Deleted "${meta.label}".`, 'ok');
    await renderLists();
  });
  head.appendChild(del);
  card.appendChild(head);

  const tokensBox = document.createElement('div');
  tokensBox.className = 'tokens';
  card.appendChild(tokensBox);
  try {
    const buffer = await TemplateStore.getTemplateBuffer(meta);
    renderTokenChips(tokensBox, await DocxFill.listTemplateTokens(buffer));
  } catch (err) {
    tokensBox.textContent = `Could not read tokens: ${err.message}`;
  }

  return card;
}

async function renderLists() {
  const templates = await TemplateStore.loadTemplates();

  templateList.innerHTML = '';
  if (!templates.length) {
    templateList.innerHTML = '<p class="hint">No templates yet - upload one above.</p>';
  } else {
    for (const meta of templates) templateList.appendChild(await templateCard(meta));
  }
}

fileInput.addEventListener('change', handleFileChosen);
saveBtn.addEventListener('click', handleSave);

renderLists().catch((err) => {
  console.error(err);
  setStatus(`Could not load templates: ${err.message}`, 'error');
});
