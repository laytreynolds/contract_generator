// Template registry for the popup and options page. Templates are imported through the options
// page and persisted in chrome.storage.local; this module hands out ArrayBuffers for them
// through one interface.
//
// Templates are stored base64-encoded under the `customTemplates` key:
//   [{ id, label, addedAt, size, dataBase64 }]
// A .docx tops out around a few hundred KB, so base64 in storage.local (10MB quota) is fine.

const STORAGE_KEY = 'customTemplates';

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

// Returns the imported template list. An empty array is the normal first-run state (nothing
// imported yet), not an error.
async function loadTemplates() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || [];
}

// meta: an entry from loadTemplates(). Returns an ArrayBuffer of the .docx.
async function getTemplateBuffer(meta) {
  if (bufferCache.has(meta.id)) return bufferCache.get(meta.id);

  const templates = await loadTemplates();
  const entry = templates.find((t) => t.id === meta.id);
  if (!entry) throw new Error(`Template "${meta.id}" no longer exists.`);
  const buffer = base64ToArrayBuffer(entry.dataBase64);
  bufferCache.set(meta.id, buffer);
  return buffer;
}

// Adds (or replaces, matching on id) a template. Returns the stored entry.
async function saveTemplate({ id, label, buffer }) {
  const templates = await loadTemplates();
  const entry = {
    id,
    label,
    addedAt: new Date().toISOString(),
    size: buffer.byteLength,
    dataBase64: arrayBufferToBase64(buffer),
  };
  const next = templates.filter((t) => t.id !== id);
  next.push(entry);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  bufferCache.delete(id);
  return entry;
}

async function deleteTemplate(id) {
  const templates = await loadTemplates();
  const next = templates.filter((t) => t.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  bufferCache.delete(id);
}

const TemplateStore = {
  loadTemplates,
  getTemplateBuffer,
  saveTemplate,
  deleteTemplate,
};

if (typeof window !== 'undefined') {
  window.TemplateStore = TemplateStore;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TemplateStore;
}
