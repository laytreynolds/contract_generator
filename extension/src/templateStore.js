// Shared template registry for the popup and options page. Merges the read-only bundled
// templates (assets/templates/registry.json) with user-uploaded custom templates persisted in
// chrome.storage.local, and hands out ArrayBuffers for either kind through one interface.
//
// Custom templates are stored base64-encoded under the `customTemplates` key:
//   [{ id, label, addedAt, size, dataBase64 }]
// A .docx tops out around a few hundred KB, so base64 in storage.local (10MB quota) is fine.

const REGISTRY_PATH = 'assets/templates/registry.json';
const TEMPLATES_DIR = 'assets/templates/';
const CUSTOM_KEY = 'customTemplates';

// Per-page-load cache so repeated template switches don't refetch/redecode.
const bufferCache = new Map(); // id -> ArrayBuffer

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function loadBundledRegistry() {
  const resp = await fetch(chrome.runtime.getURL(REGISTRY_PATH));
  if (!resp.ok) throw new Error(`Could not load template registry (${resp.status}).`);
  const templates = await resp.json();
  if (!Array.isArray(templates)) throw new Error('Template registry is malformed.');
  return templates.map((t) => ({ ...t, source: 'bundled' }));
}

async function loadCustomTemplates() {
  const stored = await chrome.storage.local.get(CUSTOM_KEY);
  return (stored[CUSTOM_KEY] || []).map((t) => ({ ...t, source: 'custom' }));
}

// Bundled templates first, then custom ones (labelled "(custom)" for the dropdown).
async function loadMergedRegistry() {
  const [bundled, custom] = await Promise.all([loadBundledRegistry(), loadCustomTemplates()]);
  const merged = [
    ...bundled,
    ...custom.map((t) => ({ ...t, label: `${t.label} (custom)` })),
  ];
  if (!merged.length) throw new Error('No templates available.');
  return merged;
}

// meta: an entry from loadMergedRegistry(). Returns an ArrayBuffer of the .docx.
async function getTemplateBuffer(meta) {
  if (bufferCache.has(meta.id)) return bufferCache.get(meta.id);

  let buffer;
  if (meta.source === 'custom') {
    const custom = await loadCustomTemplates();
    const entry = custom.find((t) => t.id === meta.id);
    if (!entry) throw new Error(`Custom template "${meta.id}" no longer exists.`);
    buffer = base64ToArrayBuffer(entry.dataBase64);
  } else {
    const url = chrome.runtime.getURL(TEMPLATES_DIR + meta.file);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Could not load template "${meta.label}" (${resp.status}).`);
    buffer = await resp.arrayBuffer();
  }
  bufferCache.set(meta.id, buffer);
  return buffer;
}

// Adds (or replaces, matching on id) a custom template. Returns the stored entry.
async function saveCustomTemplate({ id, label, buffer }) {
  const custom = await loadCustomTemplates();
  const entry = {
    id,
    label,
    addedAt: new Date().toISOString(),
    size: buffer.byteLength,
    dataBase64: arrayBufferToBase64(buffer),
  };
  const next = custom.filter((t) => t.id !== id).map(({ source, ...t }) => t);
  next.push((({ source, ...t }) => t)(entry));
  await chrome.storage.local.set({ [CUSTOM_KEY]: next });
  bufferCache.delete(id);
  return entry;
}

async function deleteCustomTemplate(id) {
  const custom = await loadCustomTemplates();
  const next = custom.filter((t) => t.id !== id).map(({ source, ...t }) => t);
  await chrome.storage.local.set({ [CUSTOM_KEY]: next });
  bufferCache.delete(id);
}

const TemplateStore = {
  loadMergedRegistry,
  loadCustomTemplates,
  getTemplateBuffer,
  saveCustomTemplate,
  deleteCustomTemplate,
};

if (typeof window !== 'undefined') {
  window.TemplateStore = TemplateStore;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TemplateStore;
}
