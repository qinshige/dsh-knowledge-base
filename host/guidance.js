/**
 * 系统提示：静态规则 + 动态知识库目录。
 *
 * 静态部分（section）让模型知道"什么时候、按什么顺序用这些工具"；
 * 动态部分（context）每次组装时读取当前入库清单，模型不必先调工具才知道库里有什么。
 */
export const GUIDANCE_SECTION = 'dsh-knowledge-base';
export const GUIDANCE_ORDER = 3040;
export const CATALOG_CONTEXT = 'dsh-knowledge-base-catalog';
export const CATALOG_ORDER = 2960;

export const GUIDANCE_TEXT = [
  '## 我的知识库（插件 dsh-knowledge-base）',
  '',
  '用户上传的跨境选品知识文档存放在「我的知识库」里（左侧栏「我的知识库」图标可打开、上传、预览、删除）。',
  '**当用户问跨境选品相关问题时**（品类机会、市场与竞品、平台规则、选品标准与利润模型、供应链物流、合规认证、广告投放、店铺运营等），',
  '**先检索知识库，再基于库内内容回答**，不要凭空编造库内没有的结论。',
  '',
  '标准顺序：',
  '1. 看动态上下文里的「知识库文档清单」（如果没有，调用 `kb_list_documents`）；',
  '2. 用 `kb_search` 检索，query 用 2–8 个关键词（中文/英文/平台名都可以）；一个词不够就换同义词、英文缩写、平台名再检索 2–3 次；',
  '3. 命中片段不够回答时，用 `kb_read_document` 按 docId 读全文或前后片段；',
  '4. 回答时**引用文档标题**并说明"来自你的知识库"；库内没有依据的内容必须明确标注"知识库外的通用经验/外部信息"，不要把两者混在一起。',
  '',
  '知识库为空时：先说明库里还没有内容，再提示用户去左侧栏「我的知识库」上传文档（支持 .md/.txt/.docx/.xlsx/.csv/.html），',
  '或让用户给出本地文件路径后用 `kb_add_document` 导入；**不要**因为库是空的就停止回答——外部知识要标注清楚。',
  '检索无结果时换关键词重试，仍无结果就如实说明，**不要反复用同一个查询重试**。',
  '',
  '工具的写操作：`kb_add_document` 导入文件（避免重复导入同一份）、`kb_update_document` 改标题/分类、',
  '`kb_delete_document` 删除（**必须先得到用户明确同意**，并传 confirm:true）。',
].join('\n');

/**
 * 注册静态规则与动态目录。
 * **必须经 `ctx.inject(['systemPrompt'], …)` 调用**：服务在 `apply()` 时刻可能尚未就绪，
 * 直接 `ctx.get()` 会静默拿到 undefined 并永久跳过注册。
 *
 * @param {any} host - 已注入 `systemPrompt` 的上下文。
 * @param {{ catalogText: () => string }} library - 提供当前知识库目录文本。
 * @returns {boolean} 是否真的注册成功。
 */
export function installGuidance(host, library) {
  const service = host.get('systemPrompt');
  if (typeof service !== 'object' || service === null || typeof service.section !== 'function') return false;
  service.section({ name: GUIDANCE_SECTION, order: GUIDANCE_ORDER, text: GUIDANCE_TEXT });
  if (typeof service.context === 'function') {
    service.context({
      name: CATALOG_CONTEXT,
      order: CATALOG_ORDER,
      text: () => library.catalogText(),
    });
  }
  return true;
}
