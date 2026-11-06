/**
 * 交给模型的 6 个工具。
 *
 * 设计原则（与 user-actions 指南一致）：UI 上的每个操作在工具层都有对应入口，
 * 且两侧调用**同一个 Library 方法**，不维护第二套逻辑。
 *
 * 所有工具都不抛异常：失败返回 `{ ok:false, error:{ code, message, hint? } }`，
 * 让模型能读懂并自我纠正，而不是拿到一个栈。
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { chunkText } from './chunk.js';
import { SUPPORTED_FORMATS_LABEL } from './extract.js';

/** 单次从本地路径导入的字节上限（与 HTTP 上传一致）。 */
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

function textBlock(text) {
  return { type: 'text', text };
}

function fail(code, message, hint) {
  return { ok: false, error: { code, message, ...(hint === undefined ? {} : { hint }) } };
}

function pickString(source, key) {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function pickInt(source, key, fallback, min, max) {
  if (typeof source !== 'object' || source === null) return fallback;
  const value = Number(source[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function fromException(error, code = 'internal') {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof Error && typeof error.hint === 'string' ? error.hint : undefined;
  return fail(error?.code ?? code, message, hint);
}

function formatCount(chars) {
  if (chars >= 10000) return `${(chars / 10000).toFixed(1)} 万字`;
  return `${chars} 字`;
}

function formatTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
};

function renderJsonSummary(lines) {
  return [textBlock(lines.join('\n'))];
}

/**
 * 构造全部工具定义。
 * @param {import('./library.js').Library} library
 * @param {{ ctx?: any }} [options]
 */
export function createTools(library) {
  const listTool = {
    name: 'kb_list_documents',
    description: [
      '列出「我的知识库」里已入库的文档（标题、分类、字数、片段数、id、入库时间），以及整体统计。',
      '调用时机：回答跨境选品问题前先确认知识库覆盖范围；用户问「知识库里有什么」；或按分类筛选文档。',
      '知识库为空时会返回可操作的提示（让用户去左侧栏「我的知识库」上传，或指定本地文件路径用 kb_add_document 导入）。',
      '本工具只读，不产生费用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '只看某个分类，如「平台规则」；省略表示全部。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value?.ok !== true) {
          const error = value?.error ?? {};
          return renderJsonSummary([`失败 [${String(error.code)}]：${String(error.message)}`, ...(error.hint ? [String(error.hint)] : [])]);
        }
        const lines = [
          `知识库：${value.total} 篇文档 · ${value.stats.chunkCount} 个检索片段 · ${formatCount(value.stats.charCount)}`,
          `数据目录：${value.stats.dataDir}`,
        ];
        if (value.docs.length === 0) {
          lines.push('（没有匹配的文档）');
        } else {
          for (const doc of value.docs) {
            lines.push(
              `- 《${doc.title}》 [${doc.category}] ${formatCount(doc.chars)} · ${doc.chunkCount} 片段 · ${doc.id} · 分类：${doc.category} · 入库 ${formatTime(doc.createdAt)}`,
            );
          }
        }
        if (Array.isArray(value.categories) && value.categories.length > 0) lines.push(`分类：${value.categories.join(' / ')}`);
        return renderJsonSummary(lines);
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const category = pickString(args, 'category');
        const all = await library.list();
        const docs = category === undefined ? all : all.filter((doc) => doc.category === category);
        const stats = await library.stats();
        const categories = [...new Set(all.map((doc) => doc.category))];
        return { ok: true, total: docs.length, docs, stats, categories };
      } catch (error) {
        return fromException(error, 'list_failed');
      }
    },
  };

  const searchTool = {
    name: 'kb_search',
    description: [
      '在「我的知识库」里检索与问题最相关的片段（中文 BM25，按标题/正文/原句命中打分）。',
      '**这是回答跨境选品问题的第一步**：品类机会、平台规则、市场/竞品分析、选品标准、供应链物流、合规认证、广告投放等问题，',
      '都先用本工具检索，再基于返回片段回答；一个关键词不够就换同义词/英文/平台名多检索几次。',
      '返回每条的 docId / 标题 / 分类 / 片段序号 / 正文片段。需要读全文时把 docId 交给 kb_read_document。',
      '只读，不产生费用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，可中文/英文；建议 2–8 个关键词，如「亚马逊 选品 标准 利润率」。' },
        limit: { type: 'integer', description: '返回片段数，默认 8，最大 20。' },
        category: { type: 'string', description: '只在某个分类内检索，如「合规认证」；省略表示全部。' },
        docId: { type: 'string', description: '只在某一篇文档内检索（先把问题定位到单篇时用）。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value?.ok !== true) {
          const error = value?.error ?? {};
          return renderJsonSummary([`失败 [${String(error.code)}]：${String(error.message)}`, ...(error.hint ? [String(error.hint)] : [])]);
        }
        if (value.results.length === 0) {
          return renderJsonSummary([
            `知识库中没有匹配「${value.query}」的片段。`,
            '可以换同义词/英文/平台名再检索，或用 kb_list_documents 看知识库覆盖范围；仍然没有时告诉用户"知识库内没有依据"。',
          ]);
        }
        const lines = [`知识库检索「${value.query}」：命中 ${value.results.length} 个片段（共 ${value.total} 篇文档）`, ''];
        value.results.forEach((item, index) => {
          lines.push(`[${index + 1}] 《${item.title}》· 分类 ${item.category} · 片段 ${item.chunkIndex + 1} · docId ${item.docId} · 相关度 ${item.score}`);
          lines.push(item.text);
          lines.push('');
        });
        return renderJsonSummary(lines);
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const query = pickString(args, 'query');
        if (query === undefined) return fail('invalid_args', '缺少 query 参数（检索词）');
        const limit = pickInt(args, 'limit', 8, 1, 20);
        const category = pickString(args, 'category');
        const docId = pickString(args, 'docId');
        const stats = await library.stats();
        const results = await library.search(query, { limit, category, docId });
        return { ok: true, query, total: stats.docCount, results };
      } catch (error) {
        return fromException(error, 'search_failed');
      }
    },
  };

  const readTool = {
    name: 'kb_read_document',
    description: [
      '读取「我的知识库」中某一篇文档的正文（按片段顺序返回，可分段读）。',
      '调用时机：kb_search 命中片段后需要前后文/完整上下文；或用户明确要求「读一下这篇文档」。',
      '先用 kb_search 或 kb_list_documents 拿到 docId；offset 为片段起始序号（从 0 开始），一次最多 20 个片段。',
      '只读，不产生费用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        docId: { type: 'string', description: '文档 id（形如 kb_xxx），可从 kb_search / kb_list_documents 返回里取。' },
        offset: { type: 'integer', description: '起始片段序号，默认 0。' },
        limit: { type: 'integer', description: '读取片段数，默认 4，最大 20。' },
      },
      required: ['docId'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value?.ok !== true) {
          const error = value?.error ?? {};
          return renderJsonSummary([`失败 [${String(error.code)}]：${String(error.message)}`, ...(error.hint ? [String(error.hint)] : [])]);
        }
        const lines = [
          `《${value.doc.title}》 [${value.doc.category}] ${formatCount(value.doc.chars)} · 共 ${value.totalChunks} 个片段 · 当前 ${value.offset}–${value.offset + value.chunks.length - 1}`,
          '',
        ];
        value.chunks.forEach((chunk) => {
          lines.push(`--- 片段 ${chunk.index + 1}/${value.totalChunks} ---`);
          lines.push(chunk.text);
          lines.push('');
        });
        if (value.nextOffset !== null) lines.push(`还有后续内容：可再用 offset=${value.nextOffset} 继续读取。`);
        return renderJsonSummary(lines);
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const docId = pickString(args, 'docId');
        if (docId === undefined) return fail('invalid_args', '缺少 docId 参数');
        const offset = pickInt(args, 'offset', 0, 0, 100000);
        const limit = pickInt(args, 'limit', 4, 1, 20);
        const doc = await library.get(docId);
        const all = chunkText(doc.text);
        if (all.length === 0) return fail('empty_document', '这篇文档没有可读内容');
        if (offset >= all.length) {
          return fail('out_of_range', `offset=${offset} 超出范围：这篇文档共 ${all.length} 个片段（从 0 开始）`);
        }
        const slice = all.slice(offset, offset + limit);
        const nextOffset = offset + slice.length < all.length ? offset + slice.length : null;
        return {
          ok: true,
          doc: {
            id: doc.id,
            title: doc.title,
            category: doc.category,
            chars: doc.chars,
            chunkCount: all.length,
            createdAt: doc.createdAt,
          },
          totalChunks: all.length,
          offset,
          nextOffset,
          chunks: slice.map((text, index) => ({ index: offset + index, text })),
        };
      } catch (error) {
        return fromException(error, 'read_failed');
      }
    },
  };

  const addTool = {
    name: 'kb_add_document',
    description: [
      '把一个本地文件导入「我的知识库」（用户说「把这文档加进知识库」「导入这个文件」时用）。',
      '支持 .md / .txt / .csv / .tsv / .json / .html / .yml / .yaml / .docx / .xlsx；PDF 请先转存为 .docx 或 .txt。',
      'path 用**绝对路径**最稳妥；如果是当前会话工作区的文件，可先确认路径再调用。',
      '导入后文档会出现在左侧栏「我的知识库」，并参与后续 kb_search 检索。',
      '写操作：同一文件重复导入会产生多篇文档，导入前先用 kb_list_documents 确认没有重复。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地文件绝对路径（也接受相对当前宿主工作目录的路径）。' },
        title: { type: 'string', description: '文档标题；省略时用文件名（去扩展名）。' },
        category: { type: 'string', description: '分类，如「选品方法」「平台规则」「合规认证」；省略时为「未分类」。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value?.ok !== true) {
          const error = value?.error ?? {};
          return renderJsonSummary([`失败 [${String(error.code)}]：${String(error.message)}`, ...(error.hint ? [String(error.hint)] : [])]);
        }
        const lines = [
          `已导入《${value.doc.title}》 [${value.doc.category}]：${formatCount(value.doc.chars)} · ${value.doc.chunkCount} 个片段 · id ${value.doc.id}`,
        ];
        if (typeof value.note === 'string' && value.note !== '') lines.push(value.note);
        lines.push('可以直接用 kb_search 检索，或到左侧栏「我的知识库」查看。');
        return renderJsonSummary(lines);
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const rawPath = pickString(args, 'path');
        if (rawPath === undefined) return fail('invalid_args', '缺少 path 参数（本地文件路径）');
        const absolute = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
        let info;
        try {
          info = await stat(absolute);
        } catch {
          return fail('file_not_found', `找不到文件：${absolute}`, '请确认路径正确；优先使用绝对路径。');
        }
        if (!info.isFile()) return fail('not_a_file', `不是一个文件：${absolute}`);
        if (info.size > MAX_INPUT_BYTES) {
          return fail('file_too_large', `文件超过 ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)} MB 上限`, '请拆分后再导入。');
        }
        const buffer = await readFile(absolute);
        const result = await library.add({
          filename: absolute.split(/[\\/]/).pop() ?? 'document',
          buffer,
          title: pickString(args, 'title'),
          category: pickString(args, 'category'),
          source: 'path',
        });
        return { ok: true, doc: result.doc, note: result.note };
      } catch (error) {
        return fromException(error, 'add_failed');
      }
    },
  };

  const deleteTool = {
    name: 'kb_delete_document',
    description: [
      '从「我的知识库」删除一篇文档（不可恢复，只能重新上传）。',
      '**必须先得到用户明确同意**：用户说「删掉那份文档」并确认是哪一篇后再调用；不要自行清理文档。',
      '必须传 confirm: true 才会执行；不传时返回 confirm_required。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '文档 id（从 kb_list_documents 取）。' },
        confirm: { type: 'boolean', description: '用户已明确同意删除时为 true。' },
      },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value?.ok !== true) {
          const error = value?.error ?? {};
          return renderJsonSummary([`失败 [${String(error.code)}]：${String(error.message)}`, ...(error.hint ? [String(error.hint)] : [])]);
        }
        return renderJsonSummary([`已从知识库删除《${value.title}》（${value.id}）。`]);
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const id = pickString(args, 'id');
        if (id === undefined) return fail('invalid_args', '缺少 id 参数');
        const confirmed = typeof args === 'object' && args !== null && args.confirm === true;
        if (!confirmed) {
          return fail(
            'confirm_required',
            '删除知识库文档需要用户明确同意',
            '先向用户确认要删除哪一篇，得到同意后再以 confirm:true 调用；或让用户自己在左侧栏「我的知识库」里删除。',
          );
        }
        const removed = await library.remove(id);
        return { ok: true, id: removed.id, title: removed.title };
      } catch (error) {
        return fromException(error, 'delete_failed');
      }
    },
  };

  const updateTool = {
    name: 'kb_update_document',
    description: [
      '修改「我的知识库」中一篇文档的标题或分类（正文不可改，正文要改请重新上传）。',
      '调用时机：用户说「把这篇归到合规认证」「标题改成 XXX」，或整理知识库分类时。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '文档 id。' },
        title: { type: 'string', description: '新标题；省略表示不改。' },
        category: { type: 'string', description: '新分类；省略表示不改。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (value?.ok !== true) {
          const error = value?.error ?? {};
          return renderJsonSummary([`失败 [${String(error.code)}]：${String(error.message)}`]);
        }
        return renderJsonSummary([`已更新《${value.doc.title}》 → 分类 ${value.doc.category}。`]);
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const id = pickString(args, 'id');
        if (id === undefined) return fail('invalid_args', '缺少 id 参数');
        const patch = {};
        const title = pickString(args, 'title');
        const category = pickString(args, 'category');
        if (title !== undefined) patch.title = title;
        if (category !== undefined) patch.category = category;
        if (Object.keys(patch).length === 0) return fail('invalid_args', 'title 与 category 至少要给一个');
        const doc = await library.update(id, patch);
        return { ok: true, doc };
      } catch (error) {
        return fromException(error, 'update_failed');
      }
    },
  };

  return [listTool, searchTool, readTool, addTool, deleteTool, updateTool];
}

/** 工具里也复述一次支持格式，保证错误提示与文档一致。 */
export { SUPPORTED_FORMATS_LABEL };
