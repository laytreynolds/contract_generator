// Fills {{token}} merge fields inside a .docx's word/document.xml, including tokens that
// Word has split across multiple <w:r> runs (e.g. a stray <w:proofErr/> mid-tag). We only ever
// rewrite the *content* of <w:t> nodes -- the surrounding <w:r>/<w:rPr>/<w:proofErr> markup is
// left completely untouched, so run formatting (font size, bold, etc.) survives unchanged.

function escapeXmlText(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Parses every <w:t ...>...</w:t> node in the xml string into an ordered list with the
// offsets needed to splice the document back together: where the opening tag starts, where
// the inner text starts/ends, and where the closing tag ends.
function parseTextNodes(xml) {
  const nodeRegex = /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g;
  const nodes = [];
  let match;
  while ((match = nodeRegex.exec(xml)) !== null) {
    const openTagStart = match.index;
    const openTagLength = match[0].indexOf('>') + 1;
    const innerStart = openTagStart + openTagLength;
    const rawInner = match[2];
    const innerEnd = innerStart + rawInner.length;
    const closeTagEnd = match.index + match[0].length;
    nodes.push({ openTagStart, innerStart, innerEnd, closeTagEnd, rawInner });
  }
  return nodes;
}

function buildPlainTextIndex(nodes) {
  let plainText = '';
  const cumulativeStart = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    cumulativeStart[i] = plainText.length;
    plainText += nodes[i].rawInner;
  }
  return { plainText, cumulativeStart };
}

function findNodeIndexForOffset(cumulativeStart, nodes, plainOffset) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (plainOffset >= cumulativeStart[i]) return i;
  }
  return 0;
}

const TOKEN_REGEX = /\{\{\s*([^{}]+?)\s*\}\}/g;

// Returns the distinct {{token}} names used in a document.xml string, in first-appearance
// order, trimmed the same way replaceMergeFields() trims them for lookup.
function listTokens(xml) {
  const nodes = parseTextNodes(xml);
  const { plainText } = buildPlainTextIndex(nodes);

  const seen = new Set();
  const tokens = [];
  let match;
  const regex = new RegExp(TOKEN_REGEX.source, 'g');
  while ((match = regex.exec(plainText)) !== null) {
    const key = match[1].trim();
    if (!seen.has(key)) {
      seen.add(key);
      tokens.push(key);
    }
  }
  return tokens;
}

// Returns { xml, filledKeys: Set<string>, unresolvedKeys: Set<string> }
function replaceMergeFields(xml, fieldMap) {
  const nodes = parseTextNodes(xml);
  const { plainText, cumulativeStart } = buildPlainTextIndex(nodes);

  const tokenRegex = new RegExp(TOKEN_REGEX.source, 'g');
  const edits = new Map(); // nodeIndex -> new inner text
  // Local offsets below are relative to each node's ORIGINAL rawInner. Once a node has been
  // edited its text shifts, so we track the cumulative length change per node and adjust
  // later offsets into that same node by it.
  const deltas = new Map(); // nodeIndex -> cumulative length change from earlier edits
  const deltaOf = (i) => deltas.get(i) || 0;
  const filledKeys = new Set();
  const unresolvedKeys = new Set();
  let match;

  while ((match = tokenRegex.exec(plainText)) !== null) {
    const key = match[1].trim();
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;

    if (!Object.prototype.hasOwnProperty.call(fieldMap, key)) {
      unresolvedKeys.add(key);
      continue;
    }
    filledKeys.add(key);
    const value = escapeXmlText(fieldMap[key]);

    const startNodeIdx = findNodeIndexForOffset(cumulativeStart, nodes, matchStart);
    const endNodeIdx = findNodeIndexForOffset(cumulativeStart, nodes, matchEnd - 1);

    if (startNodeIdx === endNodeIdx) {
      const node = nodes[startNodeIdx];
      const d = deltaOf(startNodeIdx);
      const localStart = matchStart - cumulativeStart[startNodeIdx] + d;
      const localEnd = matchEnd - cumulativeStart[startNodeIdx] + d;
      const base = edits.has(startNodeIdx) ? edits.get(startNodeIdx) : node.rawInner;
      edits.set(startNodeIdx, base.slice(0, localStart) + value + base.slice(localEnd));
      deltas.set(startNodeIdx, d + value.length - (matchEnd - matchStart));
    } else {
      const startNode = nodes[startNodeIdx];
      const prefixLen = matchStart - cumulativeStart[startNodeIdx] + deltaOf(startNodeIdx);
      const startBase = edits.has(startNodeIdx) ? edits.get(startNodeIdx) : startNode.rawInner;
      edits.set(startNodeIdx, startBase.slice(0, prefixLen) + value);

      for (let i = startNodeIdx + 1; i < endNodeIdx; i++) {
        edits.set(i, '');
      }

      const endNode = nodes[endNodeIdx];
      const suffixStart = matchEnd - cumulativeStart[endNodeIdx];
      edits.set(endNodeIdx, endNode.rawInner.slice(suffixStart));
      deltas.set(endNodeIdx, -suffixStart);
    }
  }

  let result = '';
  let cursor = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    result += xml.slice(cursor, node.openTagStart);
    if (edits.has(i)) {
      result += `<w:t xml:space="preserve">${edits.get(i)}</w:t>`;
    } else {
      result += xml.slice(node.openTagStart, node.closeTagEnd);
    }
    cursor = node.closeTagEnd;
  }
  result += xml.slice(cursor);

  return { xml: result, filledKeys, unresolvedKeys };
}

async function loadDocumentXml(templateArrayBuffer) {
  const zip = await JSZip.loadAsync(templateArrayBuffer);
  const docPath = 'word/document.xml';
  const file = zip.file(docPath);
  if (!file) throw new Error(`${docPath} not found in template - is this a valid .docx?`);
  return { zip, docPath, xml: await file.async('string') };
}

// templateArrayBuffer: ArrayBuffer of a .docx template.
// Returns the distinct {{token}} names it contains, in first-appearance order -- used to
// build the review form for whichever template the user picks, instead of a hardcoded field list.
async function listTemplateTokens(templateArrayBuffer) {
  const { xml } = await loadDocumentXml(templateArrayBuffer);
  return listTokens(xml);
}

// templateArrayBuffer: ArrayBuffer of the source .docx
// fieldMap: { "Business Name": "...", "price": "12.95", ... } -- keys must match the
//           trimmed token name inside {{ }} in the template exactly.
// Returns { blob, filledKeys, unresolvedKeys } where unresolvedKeys are {{tokens}} present in
// the template that had no entry in fieldMap (left untouched in the output docx).
async function generateContract(templateArrayBuffer, fieldMap) {
  const { zip, docPath, xml } = await loadDocumentXml(templateArrayBuffer);
  const { xml: newXml, filledKeys, unresolvedKeys } = replaceMergeFields(xml, fieldMap);
  zip.file(docPath, newXml);

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  return { blob, filledKeys, unresolvedKeys };
}

// Exposed for the popup UI (plain <script> include, no bundler).
const DocxFillExports = { generateContract, listTemplateTokens, replaceMergeFields, escapeXmlText };
if (typeof window !== 'undefined') {
  window.DocxFill = DocxFillExports;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DocxFillExports;
}
