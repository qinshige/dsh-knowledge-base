/**
 * 宿主 HTTP API —— client 半与宿主之间的唯一通道。
 *
 * 为什么是 HTTP：包式 client 半的 `factory(require)` 只拿到 `require`（没有 `host.call`），
 * 与 dsh-pixmart 的实测契约一致。所以客户端所有读写都走本插件自己的路由。
 *
 * 安全约定：
 *   1. 只接受环回来源（这是本机能力，不对外暴露）；
 *   2. 上传体上限 25MB，JSON 体上限 256KB；
 *   3. 所有错误都转成结构化 JSON（`{ok:false,error:{code,message,hint}}`），不留未处理 rejection；
 *   4. 写操作只接受 POST。
 */
import { ExtractError } from './extract.js';

const API_PREFIX = '/knowledge-base/api';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? '';
  return LOOPBACK.has(address);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  });
  response.end(body);
}

function fail(response, status, code, message, hint) {
  sendJson(response, status, { ok: false, error: { code, message, ...(hint === undefined ? {} : { hint }) } });
}

/** 带 HTTP 状态码的请求体错误。 */
class BodyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * 读完整请求体（超过上限即拒绝，不继续占内存）。
 * @param {import('node:http').IncomingMessage} request
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    request.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > limit) {
        finish(() => {
          request.removeAllListeners('data');
          request.resume();
          reject(
            new BodyError(
              413,
              'too_large',
              `请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限` + (limit === MAX_JSON_BYTES ? '' : '，请拆分文件后重试'),
            ),
          );
        });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => finish(() => resolve(Buffer.concat(chunks))));
    request.on('error', (error) => finish(() => reject(error)));
  });
}

async function readJsonBody(request) {
  const raw = await readBody(request, MAX_JSON_BYTES);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new BodyError(400, 'bad_json', '请求体不是合法 JSON');
  }
}

function readHeader(request, name) {
  const value = request.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw === '') return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function pickString(source, key) {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function errorStatus(error) {
  if (error instanceof BodyError) return error.status;
  if (error instanceof ExtractError) return 400;
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'not_found') return 404;
  if (code === 'bad_id' || code === 'bad_filename') return 400;
  return 500;
}

function errorPayload(error) {
  const hint = error instanceof Error && typeof error.hint === 'string' ? error.hint : undefined;
  return {
    code: typeof error?.code === 'string' ? error.code : 'internal',
    message: error instanceof Error ? error.message : String(error),
    ...(hint === undefined ? {} : { hint }),
  };
}

/**
 * 注册本插件的 HTTP 路由。
 * @param {any} ctx - 已注入 `webServer` 的宿主上下文。
 * @param {import('./library.js').Library} library
 * @returns {boolean} 是否注册成功。
 */
export function registerRoutes(ctx, library) {
  const server = ctx.get?.('webServer');
  if (typeof server !== 'object' || server === null || typeof server.register !== 'function') return false;

  const dispatch = async (request, response) => {
    try {
      if (!isLoopback(request)) {
        fail(response, 403, 'forbidden', '知识库接口只接受本机访问');
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let path = url.pathname;
      if (!path.startsWith(API_PREFIX)) {
        fail(response, 404, 'not_found', '未知的知识库接口');
        return;
      }
      path = path.slice(API_PREFIX.length);
      if (path.length > 1) path = path.replace(/\/+$/, '');
      const method = (request.method ?? 'GET').toUpperCase();

      if (path === '/library' && method === 'GET') {
        const [docs, stats, categories] = await Promise.all([library.list(), library.stats(), library.categories()]);
        sendJson(response, 200, { ok: true, docs, stats, categories });
        return;
      }

      if (path === '/doc' && method === 'GET') {
        const id = url.searchParams.get('id') ?? '';
        if (id === '') {
          fail(response, 400, 'missing_id', '缺少 id 参数');
          return;
        }
        const doc = await library.get(id);
        sendJson(response, 200, { ok: true, doc });
        return;
      }

      if (path === '/search' && method === 'GET') {
        const query = (url.searchParams.get('q') ?? '').trim();
        if (query === '') {
          fail(response, 400, 'missing_query', '缺少 q 参数');
          return;
        }
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 8), 1), 30);
        const category = (url.searchParams.get('category') ?? '').trim();
        const results = await library.search(query, { limit, category: category === '' ? undefined : category });
        sendJson(response, 200, { ok: true, query, results });
        return;
      }

      if (path === '/upload' && method === 'POST') {
        const declared = Number(request.headers['content-length'] ?? 0);
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
          fail(
            response,
            413,
            'too_large',
            `文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`,
            '请拆分文件后再上传。',
          );
          request.resume();
          return;
        }
        const body = await readBody(request, MAX_UPLOAD_BYTES);
        const rawName = readHeader(request, 'x-file-name');
        const filename = (rawName.split(/[\\/]/).pop() ?? '').trim();
        if (filename === '') {
          fail(response, 400, 'missing_filename', '缺少文件名（x-file-name 请求头）');
          return;
        }
        if (body.length === 0) {
          fail(response, 400, 'empty_file', '文件是空的');
          return;
        }
        const result = await library.add({
          filename,
          buffer: body,
          title: readHeader(request, 'x-file-title') || undefined,
          category: readHeader(request, 'x-category') || undefined,
          source: 'upload',
        });
        sendJson(response, 200, { ok: true, doc: result.doc, note: result.note });
        return;
      }

      if (path === '/update' && method === 'POST') {
        const body = await readJsonBody(request);
        const id = pickString(body, 'id');
        if (id === undefined) {
          fail(response, 400, 'missing_id', '缺少 id');
          return;
        }
        const patch = {};
        const title = pickString(body, 'title');
        const category = pickString(body, 'category');
        if (title !== undefined) patch.title = title;
        if (category !== undefined) patch.category = category;
        if (Object.keys(patch).length === 0) {
          fail(response, 400, 'nothing_to_update', 'title 与 category 至少要给一个');
          return;
        }
        const doc = await library.update(id, patch);
        sendJson(response, 200, { ok: true, doc });
        return;
      }

      if (path === '/delete' && method === 'POST') {
        const body = await readJsonBody(request);
        const id = pickString(body, 'id');
        if (id === undefined) {
          fail(response, 400, 'missing_id', '缺少 id');
          return;
        }
        const removed = await library.remove(id);
        sendJson(response, 200, { ok: true, id: removed.id, title: removed.title });
        return;
      }

      if (path === '/ping' && method === 'GET') {
        const stats = await library.stats();
        sendJson(response, 200, { ok: true, docCount: stats.docCount, dataDir: stats.dataDir });
        return;
      }

      fail(response, 404, 'not_found', `未知接口：${method} ${path}`);
    } catch (error) {
      try {
        sendJson(response, errorStatus(error), { ok: false, error: errorPayload(error) });
      } catch {
        /* 响应已经发出或连接已断：没有第二件事能做 */
      }
    }
  };

  try {
    const dispose = server.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (request, response) => {
        void dispatch(request, response);
      },
    });
    ctx.effect(() => dispose, 'dsh-knowledge-base: http routes');
    return true;
  } catch {
    return false;
  }
}

/** 供测试与文档引用的常量。 */
export { API_PREFIX, MAX_UPLOAD_BYTES };
