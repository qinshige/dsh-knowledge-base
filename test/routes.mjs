/**
 * HTTP 路由的端到端测试：真起一个 http server，把 `registerRoutes` 注册的
 * prefix handler 挂上去，然后用 fetch 走一遍上传 / 列表 / 检索 / 预览 / 改分类 / 删除。
 *
 * 这一层验证的是「client 半真正会调到的接口形状」——包括中文文件名走
 * `x-file-name` 百分号编码、错误状态码、以及写操作只接受 POST。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Library } from '../host/library.js';
import { API_PREFIX, registerRoutes } from '../host/routes.js';

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'kb-routes-'));
  const library = new Library({ dataDir: dir });
  await library.ensureReady();
  let route = null;
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (definition) => { route = definition; return () => {}; } } : undefined),
    effect: (fn) => fn(),
  };
  assert.equal(registerRoutes(ctx, library), true);
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, API_PREFIX);

  const server = createServer((request, response) => {
    if (request.url && request.url.startsWith(API_PREFIX)) {
      void route.handler(request, response);
      return;
    }
    response.writeHead(404).end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, options) => {
    const response = await fetch(origin + API_PREFIX + path, options);
    const data = await response.json();
    return { status: response.status, data };
  };
  try {
    await run({ call, origin, library });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('routes: 上传 → 列表 → 检索 → 预览 → 改分类 → 删除', async () => {
  await withServer(async ({ call }) => {
    const body = Buffer.from('# 亚马逊选品\n\n净利润率不低于 30%，物流成本低于售价 15%。', 'utf8');
    const uploaded = await call('/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent('亚马逊 选品标准.md'),
        'x-category': encodeURIComponent('选品方法'),
      },
      body,
    });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
    assert.equal(uploaded.data.ok, true);
    assert.equal(uploaded.data.doc.title, '亚马逊 选品标准');
    assert.equal(uploaded.data.doc.category, '选品方法');
    const docId = uploaded.data.doc.id;

    const library = await call('/library');
    assert.equal(library.status, 200);
    assert.equal(library.data.docs.length, 1);
    assert.equal(library.data.stats.docCount, 1);

    const search = await call('/search?q=' + encodeURIComponent('净利润率'));
    assert.equal(search.status, 200);
    assert.equal(search.data.results.length, 1);
    assert.match(search.data.results[0].text, /净利润率不低于 30%/);

    const doc = await call('/doc?id=' + encodeURIComponent(docId));
    assert.equal(doc.status, 200);
    assert.match(doc.data.doc.text, /物流成本低于售价/);

    const updated = await call('/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: docId, category: '品类研究' }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.doc.category, '品类研究');

    const deleted = await call('/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: docId }),
    });
    assert.equal(deleted.status, 200);
    assert.equal((await call('/library')).data.docs.length, 0);
  });
});

test('routes: 错误语义（缺参 / 未知接口 / 非法 JSON / 只读 GET 不被写）', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('/search')).status, 400);
    assert.equal((await call('/doc?id=kb_notexist')).status, 404);
    assert.equal((await call('/nope')).status, 404);
    assert.equal((await call('/delete', { method: 'POST' })).status, 400);
    const badJson = await call('/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.data.error.code, 'bad_json');
    // 写路由只接受 POST：GET 落到 404，不做任何事。
    assert.equal((await call('/delete?id=kb_x')).status, 404);
  });
});

test('routes: 不支持格式返回 400 且带提示', async () => {
  await withServer(async ({ call }) => {
    const response = await call('/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('报告.pdf') },
      body: Buffer.from('%PDF-1.7 fake'),
    });
    assert.equal(response.status, 400);
    assert.equal(response.data.ok, false);
    assert.equal(response.data.error.code, 'unsupported_pdf');
    assert.match(response.data.error.hint, /docx/);
  });
});
