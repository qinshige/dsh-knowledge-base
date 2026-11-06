/**
 * 宿主半的单元测试（node:test，无第三方依赖）：
 *   - 文本/HTML/DOCX/XLSX 提取；
 *   - 分块与 BM25 检索（中文）；
 *   - 知识库增删改查、持久化重载；
 *   - 6 个工具的成功/失败路径与渲染。
 *
 * 运行：`node --test test/smoke.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chunkText } from '../host/chunk.js';
import { extractText, ExtractError } from '../host/extract.js';
import { Library } from '../host/library.js';
import { createTools } from '../host/tools.js';
import { installGuidance } from '../host/guidance.js';

// ── 极简 zip 写入器：测试里现场造 .docx / .xlsx 用 ─────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.content, 'utf8');
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function makeDocx(paragraphs) {
  const body = paragraphs
    .map(
      (text) =>
        `<w:p><w:r><w:t xml:space="preserve">${text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')}</w:t></w:r></w:p>`,
    )
    .join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return makeZip([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    { name: 'word/document.xml', content: documentXml },
  ]);
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makeXlsx(rows) {
  const shared = [];
  const sharedIndex = (value) => {
    const text = String(value);
    const index = shared.indexOf(text);
    if (index >= 0) return index;
    shared.push(text);
    return shared.length - 1;
  };
  const sheetRows = rows
    .map((cells, rowIndex) => {
      const cellXml = cells
        .map((value, cellIndex) => {
          const column = String.fromCharCode(65 + cellIndex);
          return `<c r="${column}${rowIndex + 1}" t="s"><v>${sharedIndex(value)}</v></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cellXml}</row>`;
    })
    .join('');
  const sheetXml = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const sharedXml = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
    .map((text) => `<si><t>${escapeXml(text)}</t></si>`)
    .join('')}</sst>`;
  const workbookXml = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="选品数据" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const relsXml = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  return makeZip([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: relsXml },
    { name: 'xl/sharedStrings.xml', content: sharedXml },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ]);
}

// ── 提取 ──────────────────────────────────────────────────────────────────

test('extract: markdown / html / json', () => {
  const md = extractText(Buffer.from('# 选品标准\n\n利润率至少 30%。\n\n- 重量小于 500g', 'utf8'), '标准.md');
  assert.equal(md.ext, 'md');
  assert.match(md.text, /利润率至少 30%/);

  const html = extractText(
    Buffer.from('<html><head><style>.x{color:red}</style></head><body><h1>亚马逊</h1><p>退货率 &lt; 5%</p></body></html>', 'utf8'),
    'page.html',
  );
  assert.match(html.text, /亚马逊/);
  assert.match(html.text, /退货率 < 5%/);
  assert.doesNotMatch(html.text, /color:red/);

  const json = extractText(Buffer.from('{"品类":"宠物","毛利":0.35}', 'utf8'), 'data.json');
  assert.match(json.text, /"品类": "宠物"/);
});

test('extract: docx 段落', () => {
  const buffer = makeDocx(['跨境选品第一原则：先算利润再选品。', '物流成本要控制在售价的 15% 以内。']);
  const result = extractText(buffer, '选品原则.docx');
  assert.equal(result.ext, 'docx');
  assert.match(result.text, /先算利润再选品/);
  assert.match(result.text, /物流成本/);
});

test('extract: xlsx 单元格', () => {
  const buffer = makeXlsx([
    ['品类', '毛利率', '退货率'],
    ['宠物梳', '35%', '4%'],
  ]);
  const result = extractText(buffer, '选品数据.xlsx');
  assert.equal(result.ext, 'xlsx');
  assert.match(result.text, /工作表：选品数据/);
  assert.match(result.text, /宠物梳\t35%\t4%/);
});

test('extract: 不支持的格式给可操作提示', () => {
  assert.throws(
    () => extractText(Buffer.from('%PDF-1.7'), '报告.pdf'),
    (error) => error instanceof ExtractError && error.code === 'unsupported_pdf' && /docx/.test(error.hint),
  );
  assert.throws(
    () => extractText(Buffer.from('abc'), 'legacy.doc'),
    (error) => error instanceof ExtractError && error.code === 'unsupported_legacy',
  );
});

// ── 分块 / 检索 ───────────────────────────────────────────────────────────

test('chunk: 长文被切成多块且不超上限', () => {
  const paragraph = '跨境选品需要同时考虑需求、竞争、利润与合规四个方面。'.repeat(12);
  const text = Array.from({ length: 12 }, () => paragraph).join('\n\n');
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1, '应切成多块');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1200, `块长度 ${chunk.length} 超上限`);
    assert.ok(chunk.trim().length > 0);
  }
  const joined = chunks.join('');
  assert.ok(joined.includes('合规四个方面'));
});

// ── 知识库 ────────────────────────────────────────────────────────────────

async function withLibrary(run) {
  const dir = await mkdtemp(join(tmpdir(), 'kb-test-'));
  try {
    const library = new Library({ dataDir: dir });
    await run(library, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('library: 入库 / 列表 / 检索 / 读取 / 删改 / 重载', async () => {
  await withLibrary(async (library, dir) => {
    const added = await library.add({
      filename: '亚马逊选品标准.md',
      buffer: Buffer.from(
        '# 亚马逊选品标准\n\n## 利润率\n\n净利润率建议不低于 30%，广告费占比控制在 10% 以内。\n\n## 物流\n\n头程加尾程物流成本应低于售价的 15%，优先选择重量小于 500 克的轻小件。',
        'utf8',
      ),
      category: '选品方法',
    });
    assert.match(added.doc.id, /^kb_[a-z0-9]+$/);
    assert.equal(added.doc.category, '选品方法');

    await library.add({
      filename: '欧盟合规.md',
      buffer: Buffer.from('欧盟 GPSR 要求：玩具类目必须有 CE 认证，包装需标注责任人信息。', 'utf8'),
      category: '合规认证',
    });

    const docs = await library.list();
    assert.equal(docs.length, 2);
    assert.ok(docs.every((doc) => doc.chunkCount >= 1));

    const hits = await library.search('利润率 广告费');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].title, '亚马逊选品标准');
    assert.match(hits[0].text, /净利润率/);

    const categoryHits = await library.search('认证', { category: '合规认证' });
    assert.equal(categoryHits.length, 1);
    assert.equal(categoryHits[0].title, '欧盟合规');

    const doc = await library.get(added.doc.id);
    assert.match(doc.text, /轻小件/);

    const updated = await library.update(added.doc.id, { category: '品类研究' });
    assert.equal(updated.category, '品类研究');

    // 重新构造 Library：验证磁盘持久化。
    const reloaded = new Library({ dataDir: dir });
    const reloadedDocs = await reloaded.list();
    assert.equal(reloadedDocs.length, 2);
    assert.ok(reloadedDocs.some((entry) => entry.category === '品类研究'));

    await library.remove(added.doc.id);
    const afterDelete = await library.list();
    assert.equal(afterDelete.length, 1);
  });
});

test('library: 空库检索与目录文本', async () => {
  await withLibrary(async (library) => {
    assert.deepEqual(await library.search('选品'), []);
    assert.match(library.catalogText(), /为空/);
    await library.add({ filename: 'a.md', buffer: Buffer.from('亚马逊 选品 利润率'), category: '选品方法' });
    assert.match(library.catalogText(), /选品方法/);
  });
});

// ── 工具 ──────────────────────────────────────────────────────────────────

test('tools: 检索/读取/导入/删除/修改的返回与渲染', async () => {
  await withLibrary(async (library, dir) => {
    await library.add({
      filename: '物流成本.md',
      buffer: Buffer.from('跨境小包物流成本通常占售价的 12%–18%。轻小件优先走专线小包。', 'utf8'),
      category: '供应链物流',
    });
    const tools = createTools(library);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const search = byName.get('kb_search');
    const searchResult = await search.execute({ query: '物流成本', limit: 5 });
    assert.equal(searchResult.ok, true);
    assert.ok(searchResult.results.length >= 1);
    const rendered = search.output.render({}, searchResult);
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /物流成本/);

    const list = byName.get('kb_list_documents');
    const listResult = await list.execute({});
    assert.equal(listResult.total, 1);
    assert.equal(listResult.stats.docCount, 1);

    const read = byName.get('kb_read_document');
    const docId = listResult.docs[0].id;
    const readResult = await read.execute({ docId, offset: 0, limit: 2 });
    assert.equal(readResult.ok, true);
    assert.match(readResult.chunks[0].text, /专线小包/);

    const del = byName.get('kb_delete_document');
    const blocked = await del.execute({ id: docId });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'confirm_required');
    const removed = await del.execute({ id: docId, confirm: true });
    assert.equal(removed.ok, true);
    assert.equal((await library.list()).length, 0);

    // 从本地路径导入（用临时目录里现写一个 md）。
    const { writeFile } = await import('node:fs/promises');
    const filePath = join(dir, 'local-note.md');
    await writeFile(filePath, '本地文件导入：FBA 头程海运 30 天，空运 7 天。', 'utf8');
    const add = byName.get('kb_add_document');
    const addResult = await add.execute({ path: filePath, category: '供应链物流' });
    assert.equal(addResult.ok, true);
    assert.equal((await library.list()).length, 1);
  });
});

test('tools: 参数错误的失败语义', async () => {
  await withLibrary(async (library) => {
    const byName = new Map(createTools(library).map((tool) => [tool.name, tool]));
    const search = await byName.get('kb_search').execute({});
    assert.equal(search.ok, false);
    assert.equal(search.error.code, 'invalid_args');
    const read = await byName.get('kb_read_document').execute({ docId: 'kb_notexist' });
    assert.equal(read.ok, false);
    const missing = await byName.get('kb_add_document').execute({ path: '/definitely/not/here.md' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'file_not_found');
  });
});


test('guidance: 注册静态规则与动态知识库目录', async () => {
  await withLibrary(async (library) => {
    await library.ensureReady();
    const sections = [];
    const contexts = [];
    const host = {
      get: (name) =>
        name === 'systemPrompt'
          ? {
              section: (section) => sections.push(section),
              context: (context) => contexts.push(context),
            }
          : undefined,
    };
    assert.equal(installGuidance(host, library), true);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'dsh-knowledge-base');
    assert.match(sections[0].text, /跨境选品/);
    assert.match(sections[0].text, /kb_search/);
    assert.equal(contexts.length, 1);
    assert.match(contexts[0].text(), /知识库当前为空/);

    await library.add({ filename: '选品.md', buffer: Buffer.from('选品要看利润率与竞争度。'), category: '选品方法' });
    assert.match(contexts[0].text(), /1 篇文档/);
    assert.match(contexts[0].text(), /选品方法/);
  });
});
