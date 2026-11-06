/**
 * 知识库存储 + 索引。
 *
 * 数据只有一种落点：`<dataDir>/docs/<id>.json`（正文 + 元数据），**没有数据库**。
 * 这样用户能直接备份/拷贝整个目录，插件升级也不会碰数据格式之外的任何东西。
 *
 * 检索索引是内存派生缓存：文档变化时整体重建。个人知识库的规模（几十篇、
 * 几千个片段）重建一次是毫秒级，不值得引入增量索引的复杂度。
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { chunkText } from './chunk.js';
import { SUPPORTED_FORMATS_LABEL, extractText } from './extract.js';
import { SearchIndex } from './search.js';

/** 预设分类（用户/模型也可以写自定义分类，这里只是 UI 的常用选项）。 */
export const CATEGORIES = [
  '未分类',
  '选品方法',
  '平台规则',
  '品类研究',
  '市场数据',
  '供应链物流',
  '合规认证',
  '营销广告',
  '其他',
];

export const UNCATEGORIZED = '未分类';

const ID_PATTERN = /^kb_[a-z0-9]+$/;
const MAX_TITLE_CHARS = 120;
const MAX_CATEGORY_CHARS = 24;

function normalizeTitle(title, filename) {
  const explicit = typeof title === 'string' ? title.trim() : '';
  if (explicit !== '') return explicit.slice(0, MAX_TITLE_CHARS);
  const name = typeof filename === 'string' ? filename.trim() : '';
  const withoutExt = name.replace(/\.[^.]+$/, '');
  return (withoutExt === '' ? '未命名文档' : withoutExt).slice(0, MAX_TITLE_CHARS);
}

function normalizeCategory(category) {
  const value = typeof category === 'string' ? category.trim() : '';
  return (value === '' ? UNCATEGORIZED : value).slice(0, MAX_CATEGORY_CHARS);
}

function newId() {
  return `kb_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

function previewOf(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
}

export class Library {
  /**
   * @param {{ dataDir: string, logger?: (message: string) => void }} options
   */
  constructor({ dataDir, logger }) {
    this.dataDir = dataDir;
    this.docsDir = join(dataDir, 'docs');
    this.logger = typeof logger === 'function' ? logger : () => {};
    /** @type {Map<string, any>} */
    this.docs = new Map();
    /** @type {SearchIndex | null} */
    this.index = null;
    this.loaded = false;
    this.notes = [];
    this.tail = Promise.resolve();
    this.ready = null;
  }

  /** 串行化写操作：同一时刻只让一个 upload/delete/update 改动内存与磁盘。 */
  #enqueue(operation) {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => {});
    return run;
  }

  async #load() {
    await mkdir(this.docsDir, { recursive: true });
    let names = [];
    try {
      names = await readdir(this.docsDir);
    } catch (error) {
      this.logger(`读取文档目录失败：${error?.message ?? error}`);
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!ID_PATTERN.test(id)) continue;
      try {
        const raw = await readFile(join(this.docsDir, name), 'utf8');
        const record = JSON.parse(raw);
        if (typeof record?.text !== 'string' || record.text.trim() === '') continue;
        record.id = id;
        record.title = normalizeTitle(record.title, record.filename);
        record.category = normalizeCategory(record.category);
        this.docs.set(id, record);
      } catch (error) {
        this.logger(`跳过无法读取的文档 ${name}：${error?.message ?? error}`);
      }
    }
    this.loaded = true;
    this.#invalidateIndex();
  }

  /** 幂等初始化（首次读盘）。 */
  async ensureReady() {
    if (this.loaded) return this;
    if (this.ready === null) {
      this.ready = this.#load().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    await this.ready;
    return this;
  }

  #invalidateIndex() {
    this.index = null;
  }

  #chunksOf(record) {
    if (!Array.isArray(record._chunks)) {
      record._chunks = chunkText(record.text);
    }
    return record._chunks;
  }

  #metaOf(record) {
    const chunks = this.#chunksOf(record);
    return {
      id: record.id,
      title: record.title,
      filename: record.filename ?? '',
      ext: record.ext ?? '',
      category: record.category,
      bytes: Number(record.bytes ?? 0),
      chars: Number(record.chars ?? record.text.length),
      chunkCount: chunks.length,
      preview: record.preview ?? previewOf(record.text),
      createdAt: Number(record.createdAt ?? 0),
      updatedAt: Number(record.updatedAt ?? record.createdAt ?? 0),
      source: record.source ?? 'upload',
    };
  }

  #assertId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw Object.assign(new Error(`文档 id 不合法：${String(id)}`), { code: 'bad_id' });
    }
  }

  /** 列出全部文档元数据（按更新时间倒序）。 */
  async list() {
    await this.ensureReady();
    const docs = [...this.docs.values()]
      .map((record) => this.#metaOf(record))
      .sort((a, b) => b.createdAt - a.createdAt);
    return docs;
  }

  /** 分类清单：预设 + 文档里出现过的自定义分类。 */
  async categories() {
    const docs = await this.list();
    const seen = new Set(CATEGORIES);
    for (const doc of docs) seen.add(doc.category);
    return [...seen];
  }

  /** 统计信息（UI 头部与工具输出共用）。 */
  async stats() {
    const docs = await this.list();
    let chunkCount = 0;
    let charCount = 0;
    for (const doc of docs) {
      chunkCount += doc.chunkCount;
      charCount += doc.chars;
    }
    return {
      docCount: docs.length,
      chunkCount,
      charCount,
      dataDir: this.dataDir,
      supportedFormats: SUPPORTED_FORMATS_LABEL,
    };
  }

  /** 完整文档（正文 + 元数据），供预览与 `kb_read_document`。 */
  async get(id) {
    await this.ensureReady();
    this.#assertId(id);
    const record = this.docs.get(id);
    if (record === undefined) {
      throw Object.assign(new Error(`没有 id 为 ${id} 的文档`), { code: 'not_found' });
    }
    return { ...this.#metaOf(record), text: record.text };
  }

  /**
   * 入库一个文件（原始字节）。
   * @param {{ filename: string, buffer: Buffer, title?: string, category?: string, source?: string }} input
   */
  async add(input) {
    return this.#enqueue(async () => {
      await this.ensureReady();
      const filename = String(input.filename ?? '').trim();
      if (filename === '') throw Object.assign(new Error('缺少文件名'), { code: 'bad_filename' });
      const extracted = extractText(input.buffer, filename);
      const now = Date.now();
      const id = newId();
      const record = {
        id,
        title: normalizeTitle(input.title, filename),
        filename,
        ext: extracted.ext,
        category: normalizeCategory(input.category),
        bytes: Buffer.isBuffer(input.buffer) ? input.buffer.length : 0,
        chars: extracted.text.length,
        preview: previewOf(extracted.text),
        createdAt: now,
        updatedAt: now,
        source: typeof input.source === 'string' && input.source !== '' ? input.source : 'upload',
        text: extracted.text,
      };
      await this.#writeRecord(record);
      this.docs.set(id, record);
      this.#invalidateIndex();
      return { doc: this.#metaOf(record), note: extracted.note ?? null };
    });
  }

  /** 从本地路径入库（供 `kb_add_document` 工具使用）。 */
  async addFromFile({ path, title, category, readFileImpl }) {
    const reader = typeof readFileImpl === 'function' ? readFileImpl : readFile;
    const buffer = await reader(path);
    return this.add({ filename: path.split(/[\\/]/).pop() ?? 'document', buffer, title, category, source: 'path' });
  }

  /** 删除一篇文档。 */
  async remove(id) {
    return this.#enqueue(async () => {
      await this.ensureReady();
      this.#assertId(id);
      const record = this.docs.get(id);
      if (record === undefined) throw Object.assign(new Error(`没有 id 为 ${id} 的文档`), { code: 'not_found' });
      try {
        await unlink(join(this.docsDir, `${id}.json`));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      this.docs.delete(id);
      this.#invalidateIndex();
      return { id, title: record.title };
    });
  }

  /** 改标题/分类。 */
  async update(id, patch = {}) {
    return this.#enqueue(async () => {
      await this.ensureReady();
      this.#assertId(id);
      const record = this.docs.get(id);
      if (record === undefined) throw Object.assign(new Error(`没有 id 为 ${id} 的文档`), { code: 'not_found' });
      if (patch.title !== undefined) record.title = normalizeTitle(patch.title, record.filename);
      if (patch.category !== undefined) record.category = normalizeCategory(patch.category);
      record.updatedAt = Date.now();
      await this.#writeRecord(record);
      this.#invalidateIndex();
      return this.#metaOf(record);
    });
  }

  /** 懒建索引。 */
  async #ensureIndex() {
    await this.ensureReady();
    if (this.index !== null) return this.index;
    const chunks = [];
    for (const record of this.docs.values()) {
      const list = this.#chunksOf(record);
      list.forEach((text, index) => {
        chunks.push({
          docId: record.id,
          title: record.title,
          category: record.category,
          index,
          text,
        });
      });
    }
    this.index = new SearchIndex(chunks);
    return this.index;
  }

  /**
   * 检索知识库。
   * @param {string} query
   * @param {{ limit?: number, category?: string, docId?: string, maxPerDoc?: number }} [options]
   */
  async search(query, options = {}) {
    const index = await this.#ensureIndex();
    return index.search(query, options);
  }

  /**
   * 给模型看的「知识库覆盖范围」摘要（动态系统提示上下文用）。
   *
   * **必须是同步的**：`systemPrompt.context()` 的 text 是同步函数，不能等 I/O。
   * 所以这里只读内存里已加载的文档；首次读盘还没完成时返回初始化提示。
   */
  catalogText() {
    if (!this.loaded) return '知识库正在初始化（首次读盘）……下一步请求即可读出文档清单。';
    const docs = [...this.docs.values()]
      .map((record) => this.#metaOf(record))
      .sort((a, b) => b.createdAt - a.createdAt);
    if (docs.length === 0) {
      return '知识库当前为空（0 篇文档）。用户问跨境选品相关问题时，先说明知识库还没有内容，并提示用户：左侧栏「我的知识库」→ 上传文档（支持 .md/.txt/.docx/.xlsx/.csv/.html），或让 Agent 用 kb_add_document 从本地路径导入。';
    }
    const usedCategories = [...new Set(docs.map((doc) => doc.category))];
    const totalChunks = docs.reduce((sum, doc) => sum + doc.chunkCount, 0);
    const lines = [
      `知识库当前有 ${docs.length} 篇文档（分类：${usedCategories.join(' / ')}），共 ${totalChunks} 个检索片段。` +
        '回答跨境选品问题前，先调用 kb_search 检索；需要上下文时用 kb_read_document 读全文。',
      '文档清单（标题 / 分类 / 字数 / id）：',
    ];
    docs.slice(0, 30).forEach((doc, index) => {
      lines.push(`${index + 1}. 《${doc.title}》 / ${doc.category} / ${doc.chars} 字 / ${doc.id}`);
    });
    if (docs.length > 30) lines.push(`……另有 ${docs.length - 30} 篇未列出，可用 kb_list_documents 查看全部。`);
    return lines.join('\n');
  }

  async #writeRecord(record) {
    await mkdir(this.docsDir, { recursive: true });
    const target = join(this.docsDir, `${record.id}.json`);
    const temp = `${target}.tmp`;
    const payload = JSON.stringify({ ...record, _chunks: undefined, chunkCount: undefined });
    await writeFile(temp, payload, 'utf8');
    await rename(temp, target);
  }
}
