/**
 * 检索：中文友好的 BM25。
 *
 * 不引入分词器（零依赖）：中文按**相邻二字（bigram）**切、英文/数字按单词切。
 * 对"跨境选品 / 亚马逊 / 物流时效"这类词，bigram 的召回与精度足够，
 * 而且完全避免了词典依赖与未知词问题。
 *
 * 打分 = BM25(正文) + 标题命中加权 + 原句命中加分。
 * 同一文档最多返回 `maxPerDoc` 个片段，避免一份长文档把结果位占满。
 */

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const LATIN_WORD = /[a-z0-9][a-z0-9_+\-/.]*/g;

/** 检索词切分：返回 token 数组（保留重复，调用方按需去重）。 */
export function tokenize(text) {
  const value = String(text ?? '').toLowerCase();
  const tokens = [];
  for (const run of value.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  for (const word of value.match(LATIN_WORD) ?? []) {
    if (word.length >= 2) tokens.push(word);
  }
  return tokens;
}

function countTokens(text) {
  const counts = new Map();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

const K1 = 1.2;
const B = 0.75;

export class SearchIndex {
  /**
   * @param {Array<{docId: string, title: string, category: string, index: number, text: string}>} chunks
   */
  constructor(chunks) {
    this.entries = [];
    this.df = new Map();
    this.totalLength = 0;
    for (const chunk of chunks) {
      const tokens = countTokens(chunk.text);
      const titleTokens = new Set(tokenize(chunk.title));
      const entry = {
        docId: chunk.docId,
        title: chunk.title,
        category: chunk.category,
        chunkIndex: chunk.index,
        text: chunk.text,
        tokens,
        titleTokens,
        length: Math.max(1, chunk.text.length),
      };
      this.entries.push(entry);
      this.totalLength += entry.length;
      for (const token of tokens.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1);
    }
    this.avgLength = this.entries.length === 0 ? 1 : this.totalLength / this.entries.length;
  }

  get size() {
    return this.entries.length;
  }

  /**
   * 检索。
   * @param {string} query - 用户/模型给的自然语言关键词。
   * @param {{ limit?: number, category?: string, docId?: string, maxPerDoc?: number }} [options]
   * @returns {Array<{docId: string, title: string, category: string, chunkIndex: number, score: number, text: string}>}
   */
  search(query, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit ?? 8), 1), 30);
    const maxPerDoc = Math.min(Math.max(Number(options.maxPerDoc ?? 3), 1), 10);
    const category = typeof options.category === 'string' ? options.category.trim() : '';
    const docId = typeof options.docId === 'string' ? options.docId.trim() : '';
    const queryText = String(query ?? '').trim();
    if (queryText === '' || this.entries.length === 0) return [];

    const queryTokens = [...new Set(tokenize(queryText))];
    const scored = [];
    for (const entry of this.entries) {
      if (docId !== '' && entry.docId !== docId) continue;
      if (category !== '' && entry.category !== category) continue;
      let score = 0;
      let titleHits = 0;
      for (const token of queryTokens) {
        const df = this.df.get(token) ?? 0;
        if (df === 0) continue;
        const idf = Math.log(1 + (this.entries.length - df + 0.5) / (df + 0.5));
        const tf = entry.tokens.get(token) ?? 0;
        if (tf > 0) {
          score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * entry.length) / this.avgLength));
        }
        if (entry.titleTokens.has(token)) titleHits += idf;
      }
      score += titleHits * 1.6;
      if (queryText.length <= 24 && entry.text.includes(queryText)) score += 2.5;
      if (score <= 0) continue;
      scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const results = [];
    const perDoc = new Map();
    for (const { entry, score } of scored) {
      const used = perDoc.get(entry.docId) ?? 0;
      if (used >= maxPerDoc) continue;
      perDoc.set(entry.docId, used + 1);
      results.push({
        docId: entry.docId,
        title: entry.title,
        category: entry.category,
        chunkIndex: entry.chunkIndex,
        score: Math.round(score * 1000) / 1000,
        text: entry.text,
      });
      if (results.length >= limit) break;
    }
    return results;
  }
}
