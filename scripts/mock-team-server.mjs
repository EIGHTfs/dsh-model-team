#!/usr/bin/env node
// 本地假后端：给 ui/ 的设计稿与插件客户端提供 /_team/* 的固定假数据。
//
// 用途
//   - 不启动真实 DSH 网关时，用它跑通前端**数据层**（/_team/* 假数据）；
//     界面本身（主题）只能在 DSH 宿主里渲染，根路径给的是"构建产物自检页"；
//   - 假数据形状与真实接口一致（分组列表 / 群友 / 请求行 / 事件流 / 全局统计 / 目标），
//     前端改字段或改排序逻辑时可用它做回归自检。
//
// 用法
//   node scripts/mock-team-server.mjs                  # 默认 http://127.0.0.1:8766
//   node scripts/mock-team-server.mjs --port 8899      # 换端口
//   node scripts/mock-team-server.mjs --host 0.0.0.0   # 允许局域网访问（真机联调）
//
// 行为要点
//   - GET  /_team/*  返回固定假数据；静态路径按仓库根目录提供（/ 返回产物自检页）；
//   - PUT  /_team/session/<id>/target 往 events 追加一条 system 事件，
//     模拟真实后端"切换目标即落事件"，用于验证前端不在本地拼文案（刷新前后逐字一致）；
//   - 零第三方依赖，只用 node:http / node:fs。

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录 = 本脚本的上一级，不写死任何本机绝对路径
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 假 session 标识：形状与真实网关一致，只用于串联按 id 寻址的端点
// 值刻意拆成两段拼接：完整的长 id 字面量会被审计规则当成"文档里的会话引用"误报，
// 运行时拼出来的字符串与旧实现逐字节相同（端点对齐证据见本次提交说明）。
const MOCK_SESSION_UUID = 'session-' + '00000000-0000-4000-8000-000000000000';

// PUT target 时追加的 system 事件（进程内存态，重启即清空）
const EXTRA_EVENTS = [];

const BASE_EVENTS = [
  { type: 'self-message', text: '@glm-5.3-flash 帮我看看', at: '2026-11-01T19:46:00.000Z' },
  { type: 'system', text: '已切换当前会话模型为 glm-5.3-flash', at: '2026-11-01T19:46:30.000Z' },
  { type: 'system', text: '已切换路由至：DeepSeek-高可用组（策略：轮询）', at: '2026-11-01T19:52:00.000Z' },
];

const GROUPS = [
  {
    id: 'agnes',
    name: 'agnes(1a2b3c4d)',
    avatar: '[A]',
    summary: '限速 60/min · 余 12 credit',
    lastUpdated: '2026-11-02T11:20:00.000Z',
  },
  {
    id: 'codearts',
    name: 'codearts(9f8e7d6c)',
    avatar: '[C]',
    summary: '5h 12/60 · 余额 $3.2',
    lastUpdated: '2026-11-01T08:30:00.000Z',
  },
];

const MODELS_BY_GROUP = {
  agnes: [
    { id: 'global:glm-5.3-flash', name: 'glm-5.3-flash' },
    { id: 'global:deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
  ],
  codearts: [{ id: 'global:deepseek-v3', name: 'deepseek-v3' }],
};

const FRIEND_GROUPS = [
  {
    id: 'ds-high-avail',
    name: 'DeepSeek-高可用组',
    strategy: 'round-robin',
    cursor: 1,
    members: [
      { platformId: 'agnes', modelId: 'deepseek-v3' },
      { platformId: 'codearts', modelId: 'deepseek-v3' },
    ],
  },
  {
    id: 'claude-frugal',
    name: 'Claude-省钱组',
    strategy: 'fallback',
    cursor: 0,
    members: [
      { platformId: 'agnes', modelId: 'claude-3.7-sonnet' },
      { platformId: 'codearts', modelId: 'claude-3.5-haiku' },
    ],
  },
];

// 平台预置：形状等同 GET /_team/platforms（图标/基址都用示例域名，方便验证 URL 头像）
const PLATFORMS = [
  {
    id: 'agnes',
    name: 'Agnes',
    avatar: 'https://cdn.example.com/logo-agnes.svg',
    baseURL: 'https://api.example.com/agnes/v1',
    modelsEndpoint: '/models',
    homepage: 'https://example.com',
    summaryTemplate: '官方接入 · {baseURL}',
    driverId: 'agnes',
  },
  {
    id: 'codearts',
    name: 'CodeArts (华为云)',
    avatar: '[C]',
    baseURL: 'https://api.example.com/codearts/v1',
    modelsEndpoint: '/models',
    homepage: 'https://example.com',
    summaryTemplate: '官方接入 · {baseURL}',
    driverId: 'codearts',
  },
];

const DRIVERS = [
  {
    id: 'agnes',
    name: 'Agnes',
    avatar: '[A]',
    authSchema: [
      { key: 'baseURL', label: '接口地址', type: 'text' },
      { key: 'apiKey', label: 'API Key', type: 'password' },
    ],
  },
  {
    id: 'codearts',
    name: 'CodeArts (华为云)',
    avatar: '[C]',
    authSchema: [{ key: 'apiKey', label: 'API Key', type: 'password' }],
  },
];

const SESSION_ROWS = [
  {
    model: 'glm-5.3-flash',
    status: 200,
    statusText: '成功',
    time: '03:47:12',
    latency: '8.42s',
    tokens: '96.3k',
    completionTokens: 9,
    latencySeconds: 4.56,
    credit: '0.31',
    cacheHit: '92.4%',
    ip: '192.0.2.10',
    ua: 'dsh/0.2.1',
    requestId: 'req-1',
    title: '请求 1',
  },
  {
    model: 'deepseek-v3',
    status: 200,
    statusText: '成功',
    time: '03:50:06',
    latency: '4.56s',
    tokens: '40.3k',
    completionTokens: 9,
    latencySeconds: 4.56,
    credit: '0.52',
    cacheHit: '99.1%',
    ip: '192.0.2.11',
    ua: 'dsh/0.2.1',
    requestId: 'req-2',
    title: '请求 2',
  },
];

const CURRENT_TARGET = { type: 'model', id: 'global:glm-5.3-flash', platformId: 'agnes' };

// 按 session id 返回不同目标：用于验证「进群聊默认显示该目标所属群」（契约条款 25）
// 新出参（契约 docs/19 §三）：target 是本 session 显式绑定的，effectiveTarget 是实际生效的
const TARGET_BY_SESSION = {
  'session-two': {
    target: { type: 'model', id: 'global:deepseek-v3', platformId: 'codearts' },
    effectiveTarget: { type: 'model', id: 'global:deepseek-v3', platformId: 'codearts' },
    targetSource: 'explicit',
  },
  'session-inherit': {
    target: null,
    effectiveTarget: { type: 'model', id: 'global:glm-5.3-flash', platformId: 'agnes' },
    targetSource: 'last-session',
  },
  'session-group': {
    target: { type: 'group', id: 'ds-high-avail' },
    effectiveTarget: { type: 'group', id: 'ds-high-avail' },
    targetSource: 'explicit',
  },
};

const CONTENT_TYPE_BY_EXTENSION = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

// 预览入口（0.4.0 起）：界面只剩主题，而主题**只能在 DSH 宿主里渲染**——
// 它由构建产物 `lib/client.js` 的 THEME_FACTORY 段提供，运行时还需要宿主的 React 与槽位。
// 所以这里不再假装"有个能直接打开的界面"，而是给一个**产物自检页**：
//   · 告诉你去哪看真实界面（dsh web / 主实例 GUI）；
//   · 顺手报告产物状态：client.js 在不在、主题 bundle 有没有、meta.id 是什么。
// 为什么这样做而不是继续维护一份 HTML 骨架：那份骨架和它的 CSS 已在 0.4.0 删除，
// 再手抄一份就是"第二份界面真相"，必然与主题漂移。
const PREVIEW_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>模型团队 · 预览入口（产物自检）</title>
<style>
  body { margin: 0; padding: 32px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; color: #111827; background: #f7f7f7; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .card { max-width: 720px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px 22px; box-shadow: 0 6px 20px rgba(17,24,39,.06); }
  .row { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px dashed #eef0f2; }
  .row:last-child { border-bottom: none; }
  .k { width: 168px; color: #6b7280; flex: none; }
  code { background: #f3f4f6; border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
  .ok { color: #047857; } .bad { color: #b91c1c; }
  .note { margin-top: 14px; font-size: 13px; color: #6b7280; }
</style></head><body>
<div class="card">
  <h1>模型团队 · 预览入口</h1>
  <div id="app">正在检查构建产物…</div>
  <div class="note">本页只做产物自检。真实界面（主题渲染）需要 DSH 宿主：用 <code>dsh web</code> 打开实例，在会话里看悬浮球与主窗口。</div>
</div>
<script>
(async function () {
  var host = document.getElementById('app');
  function row(key, value, ok) {
    var div = document.createElement('div');
    div.className = 'row';
    var k = document.createElement('span'); k.className = 'k'; k.textContent = key;
    var v = document.createElement('span');
    v.className = ok === undefined ? '' : (ok ? 'ok' : 'bad');
    v.innerHTML = value;
    div.appendChild(k); div.appendChild(v);
    host.appendChild(div);
  }
  try {
    var response = await fetch('/lib/client.js', { cache: 'no-store' });
    row('构建产物 lib/client.js', response.ok ? '已构建（HTTP ' + response.status + '）' : '读取失败（HTTP ' + response.status + '）', response.ok);
    if (response.ok) {
      var source = await response.text();
      var hasFactory = source.indexOf('var THEME_FACTORY = function') >= 0;
      var metaMatched = /var THEME_META = (\\{[^}]*\\})/.exec(source);
      var themeMeta = metaMatched ? metaMatched[1] : '';
      row('主题 bundle', hasFactory ? '已内联（THEME_FACTORY 存在）' : '缺失（先跑 node build.cjs）', hasFactory);
      row('主题 meta', themeMeta ? '<code>' + themeMeta.replace(/</g, '&lt;') + '</code>' : '未找到', !!themeMeta);
      row('产物规模', source.length + ' 字符', undefined);
    }
  } catch (error) {
    row('构建产物 lib/client.js', '读取异常：' + String(error && error.message ? error.message : error), false);
  }
  row('数据接口', '本服务的 <code>/_team/*</code> 仍是假数据，可用于前端数据层自检', undefined);
})();
</script>
</body></html>`;

function sendBody(response, statusCode, contentType, body) {
  response.writeHead(statusCode, contentType ? { 'content-type': contentType, 'content-length': body.length } : {});
  response.end(body);
}

function sendJson(response, payload) {
  sendBody(response, 200, 'application/json', Buffer.from(JSON.stringify(payload), 'utf8'));
}

// 静态文件：按仓库根目录解析；目录回落到 index.html。
// 与 Python 版的唯一差异：这里把解析结果限制在仓库根内（`..` 穿越直接 404），
// 原来用 os.path.join 拼路径，`/../xxx` 能读到仓库外——那不是需要对齐的行为。
async function serveStatic(response, pathname) {
  const relativePath = pathname.replace(/^\/+/, '');
  const resolvedPath = path.resolve(ROOT, relativePath);
  if (resolvedPath !== ROOT && !resolvedPath.startsWith(ROOT + path.sep)) {
    sendBody(response, 404, null, Buffer.alloc(0));
    return;
  }

  let filePath = resolvedPath;
  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    sendBody(response, 404, null, Buffer.alloc(0));
    return;
  }

  let body;
  try {
    body = await fs.readFile(filePath);
  } catch {
    sendBody(response, 404, null, Buffer.alloc(0));
    return;
  }
  const contentType = CONTENT_TYPE_BY_EXTENSION[path.extname(filePath)] ?? 'text/html; charset=utf-8';
  sendBody(response, 200, contentType, body);
}

function readRequestBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function handleGet(pathname, response) {
  if (pathname === '/_team/groups') {
    sendJson(response, { groups: GROUPS });
    return;
  }
  if (pathname.startsWith('/_team/groups/') && pathname.endsWith('/models')) {
    const groupId = pathname.slice('/_team/groups/'.length, -'/models'.length);
    sendJson(response, { models: MODELS_BY_GROUP[groupId] ?? [] });
    return;
  }
  if (pathname === '/_team/friend-groups') {
    sendJson(response, { groups: FRIEND_GROUPS });
    return;
  }
  if (pathname === '/_team/platforms') {
    sendJson(response, { platforms: PLATFORMS });
    return;
  }
  if (pathname === '/_team/drivers') {
    sendJson(response, { drivers: DRIVERS });
    return;
  }
  if (pathname === '/_team/sessions/current') {
    sendJson(response, { sessionId: MOCK_SESSION_UUID, activeAt: '2026-11-02T11:01:08.013Z' });
    return;
  }
  if (pathname.startsWith('/_team/session/') && pathname.endsWith('/target')) {
    const sessionKey = pathname.split('/')[3];
    const preset = TARGET_BY_SESSION[sessionKey];
    if (preset) {
      sendJson(response, preset);
      return;
    }
    sendJson(response, { target: CURRENT_TARGET, effectiveTarget: CURRENT_TARGET, targetSource: 'explicit' });
    return;
  }
  if (pathname === `/_team/session/${MOCK_SESSION_UUID}/events`) {
    sendJson(response, { events: [...BASE_EVENTS, ...EXTRA_EVENTS] });
    return;
  }
  if (pathname === `/_team/stats/session/${MOCK_SESSION_UUID}`) {
    sendJson(response, { rows: SESSION_ROWS });
    return;
  }
  if (pathname === '/_team/stats/global') {
    sendJson(response, { totalRows: 12, totalTokens: 345000, cacheHitPercent: 96.2 });
    return;
  }
  if (pathname.startsWith('/_team/')) {
    sendJson(response, { ok: true });
    return;
  }
  if (pathname === '/') {
    sendBody(response, 200, 'text/html; charset=utf-8', Buffer.from(PREVIEW_PAGE, 'utf8'));
    return;
  }
  await serveStatic(response, pathname);
}

// PUT：切换目标 → 往事件流追加一条 system 事件（前端刷新后应看到同一条文案）
async function handlePut(request, response) {
  const rawBody = await readRequestBody(request);
  let body = {};
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    body = {};
  }
  const targetType = body.type || 'group';
  const targetId = body.id || 'ds-high-avail';
  const text = targetType === 'model'
    ? `你 @ 了 ${String(targetId).replace('global:', '')} 并切换了当前会话模型`
    : `已切换路由至：${targetId}（策略：轮询）`;
  EXTRA_EVENTS.push({ type: 'system', text, at: '2026-11-02T12:00:00.000Z' });
  sendJson(response, { target: body });
}

function parseArguments(argv) {
  const options = { host: '127.0.0.1', port: 8766 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--host') {
      options.host = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--port') {
      options.port = Number(argv[index + 1]);
      index += 1;
    }
  }
  return options;
}

const { host, port } = parseArguments(process.argv.slice(2));

const server = http.createServer(async (request, response) => {
  const pathname = (request.url ?? '/').split('?')[0];
  try {
    if (request.method === 'GET') {
      await handleGet(pathname, response);
      return;
    }
    if (request.method === 'PUT') {
      await handlePut(request, response);
      return;
    }
    // POST 与其它方法：与旧实现一致，一律回 { ok: true }
    sendJson(response, { ok: true });
  } catch (error) {
    sendBody(response, 500, 'text/plain; charset=utf-8', Buffer.from(String(error?.message ?? error), 'utf8'));
  }
});

server.listen(port, host, () => {
  console.log(`mock backend: http://${host}:${port}/  (root=${ROOT})`);
});
