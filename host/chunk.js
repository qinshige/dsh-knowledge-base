/**
 * 文本分块。
 *
 * 检索质量主要由分块边界决定：知识文档多是"标题 + 若干段"，所以：
 *   1. 先按空行切段；
 *   2. 段落太长再按中文句末标点切句；
 *   3. 按目标字数贪心装箱，**块间保留一小段重叠**（避免答案正好被切在边界上）；
 *   4. 单块不超过硬上限，超长句按字符硬切。
 *
 * 目标字数取 700：中文一键 600–800 字能容纳 2–4 个自然段，既不会让检索片段
 * 碎片化到失去上下文，也不会一次把整章塞进模型上下文。
 */

const TARGET_CHARS = 700;
const MAX_CHARS = 1200;
const OVERLAP_CHARS = 120;

/** 把长段落切成句子（保留句末标点）。 */
function splitSentences(paragraph) {
  const parts = [];
  let buffer = '';
  for (const ch of paragraph) {
    buffer += ch;
    if ('。！？；!?;'.includes(ch)) {
      parts.push(buffer);
      buffer = '';
    } else if (ch === '\n') {
      parts.push(buffer);
      buffer = '';
    }
  }
  if (buffer !== '') parts.push(buffer);
  return parts;
}

function splitBlocks(text) {
  const blocks = [];
  for (const raw of String(text).split(/\n{2,}/)) {
    const block = raw.trim();
    if (block === '') continue;
    if (block.length <= MAX_CHARS) {
      blocks.push(block);
      continue;
    }
    for (const sentence of splitSentences(block)) {
      const clean = sentence.trim();
      if (clean === '') continue;
      if (clean.length <= MAX_CHARS) {
        blocks.push(clean);
        continue;
      }
      for (let i = 0; i < clean.length; i += MAX_CHARS) blocks.push(clean.slice(i, i + MAX_CHARS));
    }
  }
  return blocks;
}

/** 取上一块末尾的一段作为下一块的开头，尽量从句子边界处开始。 */
function overlapTail(chunk) {
  if (chunk.length <= OVERLAP_CHARS) return '';
  let tail = chunk.slice(chunk.length - OVERLAP_CHARS);
  const boundary = Math.max(
    tail.lastIndexOf('。'),
    tail.lastIndexOf('！'),
    tail.lastIndexOf('？'),
    tail.lastIndexOf('；'),
    tail.lastIndexOf('\n'),
  );
  if (boundary >= 0 && boundary < tail.length - 1) tail = tail.slice(boundary + 1);
  return tail.trim();
}

/**
 * 把一篇文档的正文切成检索块。
 * @param {string} text - 已归一化的正文。
 * @returns {string[]} 块文本数组（至少 1 块；空文本返回空数组）。
 */
export function chunkText(text) {
  const source = String(text ?? '').trim();
  if (source === '') return [];
  const blocks = splitBlocks(source);
  const chunks = [];
  let current = '';
  const flush = () => {
    const value = current.trim();
    if (value !== '') chunks.push(value);
    current = '';
  };
  for (const block of blocks) {
    if (current === '') {
      current = block;
      continue;
    }
    const candidate = `${current}\n\n${block}`;
    if (candidate.length <= TARGET_CHARS) {
      current = candidate;
      continue;
    }
    if (candidate.length <= MAX_CHARS && current.length < TARGET_CHARS * 0.5) {
      current = candidate;
      continue;
    }
    flush();
    const tail = overlapTail(chunks[chunks.length - 1] ?? '');
    current = tail === '' ? block : `${tail}\n\n${block}`;
    if (current.length > MAX_CHARS) current = current.slice(-MAX_CHARS);
  }
  flush();
  return chunks;
}
