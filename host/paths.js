/**
 * 数据目录解析与路径安全。
 *
 * 优先级（与 dsh-pixmart 在真实 desktop 宿主上实测得到的结论一致）：
 *   1. 插件配置里的显式 `dataDir`（本插件预留，当前 patch 里不配）
 *   2. 环境变量 `DSH_HOME`
 *   3. `<用户主目录>/.dsh`
 *
 * 第 3 级不是保险丝而是必需：由桌面 GUI 启动的宿主进程不设置 `DSH_HOME`，
 * 少了这一级就会退化成 `<profile 目录>/knowledge-base`——用 cwd 散落用户数据是反模式。
 */
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

const CASE_INSENSITIVE_FS = sep === '\\';

function stripTrailingSeparators(value) {
  let end = value.length;
  while (end > 1 && (value[end - 1] === '\\' || value[end - 1] === '/')) end -= 1;
  return value.slice(0, end);
}

/**
 * 解析本插件的数据目录。
 * @param {unknown} configured - 插件配置中的 `dataDir`；空串/空白视为未配置。
 * @returns {{ dataDir: string, notes: string[] }}
 */
export function resolveDataDir(configured) {
  const notes = [];
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit !== '') return { dataDir: resolve(explicit), notes };

  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    return { dataDir: resolve(stripTrailingSeparators(fromEnv), 'knowledge-base'), notes };
  }
  notes.push('DSH_HOME 未设置（GUI 启动的宿主即如此），按约定回落到 <用户主目录>/.dsh');
  try {
    const userHome = homedir();
    if (userHome !== '') {
      return { dataDir: resolve(stripTrailingSeparators(userHome), '.dsh', 'knowledge-base'), notes };
    }
  } catch {
    /* 落到最后一级 */
  }
  notes.push('DSH_HOME 与用户主目录都取不到，数据目录退化为进程工作目录下的 knowledge-base（临时）');
  return { dataDir: resolve(process.cwd(), 'knowledge-base'), notes };
}

function normalizeForCompare(value) {
  const absolute = resolve(value);
  return CASE_INSENSITIVE_FS ? absolute.toLowerCase() : absolute;
}

/** `candidate` 是否位于 `parent` 之内（含相等）。 */
export function isContained(parent, candidate) {
  const base = normalizeForCompare(parent);
  const target = normalizeForCompare(candidate);
  if (target === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target.startsWith(prefix);
}

/**
 * 校验并返回绝对路径；越界即抛。
 * @throws Error 当 `candidate` 落在 `parent` 之外。
 */
export function assertContained(parent, candidate) {
  const absolute = resolve(candidate);
  if (!isContained(parent, absolute)) {
    throw new Error(`路径越界：${absolute} 不在 ${resolve(parent)} 之内`);
  }
  return absolute;
}
