/**
 * dsh-knowledge-base —— 宿主半。
 *
 * 能力：
 *   1. 6 个 `kb_*` 工具：让模型检索、阅读、导入、整理知识库；
 *   2. HTTP API：给左侧栏「我的知识库」页面做上传 / 列表 / 预览 / 检索 / 删除；
 *   3. 系统提示：静态规则 + 每次请求动态注入的文档清单；
 *   4. 数据落盘：`$DSH_HOME/knowledge-base/docs/*.json`。
 *
 * 注意两个"必须惰性取服务"的点（与 dsh-pixmart 实测一致）：
 *   - `apply()` 是同步的，`webServer` / `systemPrompt` 可能尚未就绪；
 *   - 必须用 `ctx.inject([...], cb)`，不能在 apply 里 `ctx.get()` 探测后永久跳过。
 */
import { installGuidance } from './host/guidance.js';
import { Library } from './host/library.js';
import { resolveDataDir } from './host/paths.js';
import { registerRoutes } from './host/routes.js';
import { createTools } from './host/tools.js';

export const name = 'dsh-knowledge-base';

/** `tools` 是硬依赖：没有工具注册能力，本插件没有意义。 */
export const inject = ['tools'];

/**
 * @param {any} ctx - 宿主 Cordis 上下文。
 * @param {{ dataDir?: string }} [config] - cordis.patch.yml 中本行的 `config:` 段。
 */
export function apply(ctx, config = {}) {
  const resolved = resolveDataDir(config?.dataDir);
  const library = new Library({
    dataDir: resolved.dataDir,
    logger: (message) => {
      try {
        console.warn(`[dsh-knowledge-base] ${message}`);
      } catch {
        /* 控制台不可用也不影响主流程 */
      }
    },
  });
  for (const note of resolved.notes) library.notes.push(note);

  // ① 工具：注册在插件自己的 effect 上，卸载即注销。
  ctx.effect(() => {
    const disposers = createTools(library).map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'dsh-knowledge-base: tools');

  // ② 惰性挂载 HTTP 路由与系统提示（两个服务都可能晚于 apply 就绪）。
  const lazy = ctx;
  if (typeof lazy.inject === 'function') {
    lazy.inject(['webServer'], (host) => {
      try {
        registerRoutes(host, library);
      } catch {
        /* 路由失败只会让页面拿不到数据，不能带走工具 */
      }
    });
    lazy.inject(['systemPrompt'], (host) => {
      try {
        installGuidance(host, library);
      } catch {
        /* 说明缺失只影响可发现性，不能带走工具 */
      }
    });
  } else {
    try {
      registerRoutes(ctx, library);
    } catch {
      /* 极旧宿主没有 inject：退回立即尝试 */
    }
    try {
      installGuidance(ctx, library);
    } catch {
      /* 同上 */
    }
  }

  // ③ 预热读盘：让第一次检索/第一次页面打开少等一个 I/O。
  void library.ensureReady().catch(() => {});
}

export { Library };
