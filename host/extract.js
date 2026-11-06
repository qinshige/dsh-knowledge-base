/**
 * 文档正文提取。
 *
 * 目标：**零运行时依赖**（包式插件不保证能装第三方依赖），所以：
 *   - 纯文本类（.md / .txt / .csv / .json / .html / .yml …）直接解码；
 *   - Office Open XML（.docx / .xlsx）本质是 zip + XML，用 `node:zlib` 自己解，
 *     不引 `mammoth` / `xlsx`；
 *   - PDF 暂不支持（解析 CJK 字体映射需要完整 PDF 引擎，做不对比做不了更糟），
 *     明确返回可操作的提示，让用户另存为 .docx / .txt 再上传。
 */
import { inflateRawSync } from 'node:zlib';

/** 单个文档入库的正文上限：超出部分截断（检索用不到百万字，且要保护内存）。 */
export const MAX_DOC_CHARS = 600_000;

/** 提取失败：带稳定的 code，便于工具/HTTP 把它转成可读错误。 */
export class ExtractError extends Error {
  /**
   * @param {string} code - 机读错误码。
   * @param {string} message - 给用户/模型看的中文说明。
   * @param {string} [hint] - 可操作的下一步。
   */
  constructor(code, message, hint) {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
    this.hint = hint;
  }
}

const TEXT_EXTS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl',
  'html', 'htm', 'xml', 'yml', 'yaml', 'ini', 'conf', 'rst', 'adoc',
]);

/** 文件名 → 小写扩展名（不含点）。 */
export function extOf(filename) {
  const name = typeof filename === 'string' ? filename : '';
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

/** 给用户看的支持格式清单。 */
export const SUPPORTED_FORMATS_LABEL =
  '.md / .txt / .csv / .tsv / .json / .html / .yml / .yaml / .docx / .xlsx';

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      try {
        return String.fromCodePoint(Number.parseInt(dec, 10));
      } catch {
        return '';
      }
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function decodeHtmlEntities(text) {
  return decodeXmlEntities(text);
}

function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 2048);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function normalizeLineEndings(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\u2060]/g, '')
    .replace(/[ \t]+\n/g, '\n');
}

// ─────────────────────────────────────────────────────────────── zip（docx/xlsx）

/**
 * 读 zip 的中央目录，返回 `文件名 → { method, data }`。
 * 只实现 Office 文档需要的子集：不支持加密、不支持 zip64（docx/xlsx 不会用到）。
 */
function readZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExtractError('not_zip', '文件不是有效的 DOCX/XLSX（zip 结构缺失）');
  const total = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let pointer = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== CD_SIG) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, { method, data: buffer.subarray(dataStart, dataStart + compressedSize) });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipText(entries, name) {
  const entry = entries.get(name);
  if (entry === undefined) return undefined;
  try {
    const raw = entry.method === 8 ? inflateRawSync(entry.data) : entry.data;
    return raw.toString('utf8');
  } catch {
    throw new ExtractError('zip_read_failed', `无法解压 ${name}`);
  }
}

function documentXmlToText(xml) {
  const paragraphs = [];
  const paragraphRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let match;
  while ((match = paragraphRe.exec(xml)) !== null) {
    const inner = match[1];
    const tokenRe =
      /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;
    let text = '';
    let token;
    while ((token = tokenRe.exec(inner)) !== null) {
      if (token[0].startsWith('<w:t')) text += decodeXmlEntities(token[1]);
      else if (token[0].startsWith('<w:tab')) text += '\t';
      else text += '\n';
    }
    paragraphs.push(text);
  }
  if (paragraphs.length === 0) {
    const fallback = [];
    const textRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = textRe.exec(xml)) !== null) fallback.push(decodeXmlEntities(m[1]));
    if (fallback.length === 0) throw new ExtractError('empty_docx', 'DOCX 里没有可提取的文字');
    return fallback.join('\n');
  }
  return paragraphs.join('\n');
}

function extractDocx(buffer) {
  const entries = readZipEntries(buffer);
  const xml = readZipText(entries, 'word/document.xml');
  if (xml === undefined) {
    throw new ExtractError('not_docx', '文件里找不到 word/document.xml，不是 Word .docx 文档');
  }
  return documentXmlToText(xml);
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(String(ref ?? '').toUpperCase());
  if (letters === null) return 0;
  let index = 0;
  for (const ch of letters[0]) index = index * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function extractXlsx(buffer) {
  const entries = readZipEntries(buffer);
  const sharedXml = readZipText(entries, 'xl/sharedStrings.xml') ?? '';
  const sharedStrings = [];
  const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let si;
  while ((si = siRe.exec(sharedXml)) !== null) {
    let text = '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(si[1])) !== null) text += decodeXmlEntities(t[1]);
    sharedStrings.push(text);
  }

  // 工作表名 + 顺序：workbook.xml 的 <sheet name=… r:id=…>；rels 映射 rId → 路径。
  const workbookXml = readZipText(entries, 'xl/workbook.xml') ?? '';
  const relsXml = readZipText(entries, 'xl/_rels/workbook.xml.rels') ?? '';
  const relTargets = new Map();
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let rel;
  while ((rel = relRe.exec(relsXml)) !== null) {
    const attrs = rel[1];
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id !== undefined && target !== undefined) relTargets.set(id, target);
  }
  const sheets = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let sheet;
  while ((sheet = sheetRe.exec(workbookXml)) !== null) {
    const attrs = sheet[1];
    const name = decodeXmlEntities(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    const target = rid === undefined ? undefined : relTargets.get(rid);
    if (target !== undefined) sheets.push({ name, path: target.startsWith('/') ? target.slice(1) : `xl/${target}` });
  }
  if (sheets.length === 0) {
    // 老文件/非常规写法：退回按文件名排序。
    const names = [...entries.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));
    for (const name of names) sheets.push({ name: name.replace(/^.*\//, '').replace(/\.xml$/, ''), path: name });
  }
  if (sheets.length === 0) throw new ExtractError('not_xlsx', '文件里找不到工作表，不是 Excel .xlsx 文档');

  const chunks = [];
  for (const sheet of sheets) {
    const xml = readZipText(entries, sheet.path);
    if (xml === undefined) continue;
    const lines = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let row;
    while ((row = rowRe.exec(xml)) !== null) {
      const cells = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cell;
      while ((cell = cellRe.exec(row[1])) !== null) {
        const attrs = cell[1] ?? '';
        const body = cell[2] ?? '';
        const refMatch = /\br="([A-Z]+\d+)"/.exec(attrs);
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        let value = '';
        if (type === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (v !== undefined) value = sharedStrings[Number(v)] ?? '';
        } else if (type === 'inlineStr') {
          const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
          let t;
          while ((t = tRe.exec(body)) !== null) value += decodeXmlEntities(t[1]);
        } else {
          value = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        }
        if (value === '') continue;
        const index = refMatch === null ? cells.length : columnIndex(refMatch[1]);
        if (index > 200) continue;
        while (cells.length < index) cells.push('');
        cells[index] = value.replace(/\s+/g, ' ').trim();
      }
      const line = cells.join('\t').trim();
      if (line !== '') lines.push(line);
      if (lines.length >= 5000) break;
    }
    if (lines.length > 0) chunks.push(`## 工作表：${sheet.name || 'Sheet'}\n${lines.join('\n')}`);
    if (chunks.join('\n').length > MAX_DOC_CHARS) break;
  }
  if (chunks.length === 0) throw new ExtractError('empty_xlsx', 'XLSX 里没有可提取的单元格文本');
  return chunks.join('\n\n');
}

// ─────────────────────────────────────────────────────────────── 纯文本类

function htmlToText(html) {
  return decodeHtmlEntities(
    String(html)
      .replace(/<!Doctype[^>]*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从上传的字节里提取正文。
 * @param {Buffer|Uint8Array} buffer - 原始文件字节。
 * @param {string} filename - 原始文件名（决定解析方式）。
 * @returns {{ text: string, ext: string, truncated: boolean, note?: string }}
 */
export function extractText(buffer, filename) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const ext = extOf(filename);
  if (bytes.length === 0) throw new ExtractError('empty_file', '文件是空的');

  let text = '';
  let note;
  if (ext === 'docx') {
    text = extractDocx(bytes);
  } else if (ext === 'xlsx') {
    text = extractXlsx(bytes);
  } else if (TEXT_EXTS.has(ext)) {
    if (looksBinary(bytes)) {
      throw new ExtractError('binary_file', `「${filename}」看起来不是文本文件`, '请改传 .md / .txt / .docx / .xlsx');
    }
    text = bytes.toString('utf8');
    if (ext === 'html' || ext === 'htm') text = htmlToText(text);
    else if (ext === 'json' || ext === 'jsonl') {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* 不是合法 JSON 就按原文入库 */
      }
    }
  } else if (ext === 'pdf') {
    throw new ExtractError(
      'unsupported_pdf',
      '暂不支持 PDF 直接解析',
      '请把 PDF 另存为 .docx 或 .txt 后再上传；也可以把 PDF 里的关键段落复制成一个 .md 文件。',
    );
  } else if (ext === 'doc' || ext === 'xls' || ext === 'ppt' || ext === 'pptx') {
    throw new ExtractError(
      'unsupported_legacy',
      `暂不支持 .${ext} 格式`,
      '请用 Office / WPS 另存为 .docx（Word）或 .xlsx（Excel）后再上传。',
    );
  } else {
    throw new ExtractError(
      'unsupported_format',
      `不支持的文件格式：${ext === '' ? '（无扩展名）' : '.' + ext}`,
      `支持：${SUPPORTED_FORMATS_LABEL}；PDF 请先转成 .docx / .md / .txt。`,
    );
  }

  text = normalizeLineEndings(text).trim();
  if (text === '') throw new ExtractError('empty_text', '从文件里没有提取到文字内容');
  if (text.length > MAX_DOC_CHARS) {
    text = text.slice(0, MAX_DOC_CHARS);
    note = `正文超过 ${Math.round(MAX_DOC_CHARS / 10000)} 万字，已截断后入库`;
  }
  return { text, ext, truncated: note !== undefined, note };
}
