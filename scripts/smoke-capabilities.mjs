#!/usr/bin/env node
// smoke-capabilities.mjs —— 能力冒烟：一条命令把「这个插件现在还能做什么」全跑一遍。
//
// 为什么需要（本项目反复踩的坑）：
//   重构 UI / 改链路之后，功能是**一个接一个被用户发现没的**（登录不能发起、账号列表空、
//   模型列表空、消息不刷新、排序乱）。每次都是"发现一个 → 排查半天 → 修一个"。
//   根因不是某个 bug，而是我们从来没有一份「能力基线 + 一次性体检」。
//   本脚本就是那份体检：把 v0.3.0 起就成立的能力逐条打一次，输出通过/失败表。
//
// 用法：
//   node scripts/smoke-capabilities.mjs --base http://127.0.0.1:3083 --token <token>
//   node scripts/smoke-capabilities.mjs --base ... --token ... --group qoder --platform qoder
//   DSH_SMOKE_BASE=... DSH_SMOKE_TOKEN=... node scripts/smoke-capabilities.mjs
//
// 判据：任一项失败 → 退出码 1，并在表格里给出「期望 / 实际」。
// 设计原则：只读为主；唯一会写的是「登录发起」（生成本地授权页，不联网、不落凭据）。

import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 8000;

function parseArgs(argv) {
  const args = {
    base: process.env.DSH_SMOKE_BASE || 'http://127.0.0.1:3083',
    token: process.env.DSH_SMOKE_TOKEN || '',
    platform: 'qoder',
    group: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--base' && next) { args.base = next; index += 1; }
    else if (token === '--token' && next) { args.token = next; index += 1; }
    else if (token === '--platform' && next) { args.platform = next; index += 1; }
    else if (token === '--group' && next) { args.group = next; index += 1; }
    else if (token === '--timeout' && next) { args.timeoutMs = Number(next); index += 1; }
  }
  return args;
}

function buildHeaders(args, extra = {}) {
  const headers = { accept: 'application/json', ...extra };
  if (args.token) headers.cookie = `dsh_token=${args.token}`;
  return headers;
}

async function callApi(args, path, { method = 'GET', body } = {}) {
  const url = `${args.base.replace(/\/$/, '')}/_team${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: buildHeaders(args, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    return { ok: response.ok, status: response.status, payload };
  } catch (error) {
    return { ok: false, status: 0, payload: null, error: String(error && error.message ? error.message : error) };
  } finally {
    clearTimeout(timer);
  }
}

// 每项：名称 / 期望 / 执行 → { pass, detail }
function createChecks(args) {
  const checks = [];
  const add = (name, expectation, run) => checks.push({ name, expectation, run });

  add('元信息 meta', '返回 virtualModel 与 providerIds', async () => {
    const result = await callApi(args, '/meta');
    const value = result.payload || {};
    const pass = result.ok && typeof value.virtualModel === 'string' && Array.isArray(value.providerIds);
    return { pass, detail: `status=${result.status} virtualModel=${value.virtualModel ?? '(无)'}` };
  });

  add('群列表 groups', '数组，且每项有 id / name / driver', async () => {
    const result = await callApi(args, '/groups');
    const rows = result.payload?.groups ?? result.payload ?? [];
    const pass = result.ok && Array.isArray(rows) && rows.length > 0 && rows.every((row) => row && row.id && row.name);
    return { pass, detail: `status=${result.status} 群数=${Array.isArray(rows) ? rows.length : '非数组'}` };
  });

  add('驱动列表 drivers', '含账号型驱动，且带 platformId + authKind', async () => {
    const result = await callApi(args, '/drivers');
    const rows = result.payload?.drivers ?? result.payload ?? [];
    const reverseDriver = (Array.isArray(rows) ? rows : []).find((row) => String(row?.authKind || '').includes('reverse'));
    const pass = result.ok && Boolean(reverseDriver) && typeof reverseDriver.platformId === 'string' && reverseDriver.platformId.length > 0;
    return {
      pass,
      detail: reverseDriver
        ? `驱动=${reverseDriver.id} platformId=${reverseDriver.platformId ?? '(缺)'} authKind=${reverseDriver.authKind ?? '(缺)'}`
        : `未找到账号型驱动（drivers=${Array.isArray(rows) ? rows.length : '非数组'}）`,
    };
  });

  add('平台预置 platforms', '数组（可为空，但接口必须 200）', async () => {
    const result = await callApi(args, '/platforms');
    const rows = result.payload?.platforms ?? result.payload ?? [];
    return { pass: result.ok && Array.isArray(rows), detail: `status=${result.status} 条数=${Array.isArray(rows) ? rows.length : '非数组'}` };
  });

  add(`账号列表（${args.platform}）`, '数组且至少一条账号（含 nickname、不含 token）', async () => {
    const result = await callApi(args, `/reverse/accounts?platform=${encodeURIComponent(args.platform)}`);
    const rows = result.payload?.accounts ?? result.payload ?? [];
    const list = Array.isArray(rows) ? rows : [];
    const hasToken = JSON.stringify(list).match(/access_token|refresh_token|token":/i);
    const pass = result.ok && list.length > 0 && Boolean(list[0].accountId) && !hasToken;
    return { pass, detail: `status=${result.status} 账号数=${list.length} 首个=${list[0]?.nickname ?? list[0]?.accountId ?? '(空)'}${hasToken ? ' ⚠️含 token 字段' : ''}` };
  });

  add(`登录发起（${args.platform}）`, '返回 loginUrl（生成授权页，不联网）', async () => {
    const result = await callApi(args, '/reverse/login/start', { method: 'POST', body: { platform: args.platform } });
    const payload = result.payload || {};
    const pass = result.ok && typeof payload.loginUrl === 'string' && payload.loginUrl.startsWith('http');
    return { pass, detail: `status=${result.status} loginUrl=${payload.loginUrl ? '有' : '(无)'}` };
  });

  add('全局统计 stats/global', '返回 totalRows 与 cacheHitPercent', async () => {
    const result = await callApi(args, '/stats/global');
    const payload = result.payload || {};
    const pass = result.ok && typeof payload.totalRows === 'number' && typeof payload.cacheHitPercent === 'string';
    return { pass, detail: `status=${result.status} totalRows=${payload.totalRows ?? '(无)'} 命中率=${payload.cacheHitPercent ?? '(无)'}` };
  });

  add('好友分组 friend-groups', '返回数组（可为空）', async () => {
    const result = await callApi(args, '/friend-groups');
    const rows = result.payload?.groups ?? result.payload ?? [];
    return { pass: result.ok && Array.isArray(rows), detail: `status=${result.status} 分组数=${Array.isArray(rows) ? rows.length : '非数组'}` };
  });

  add('SSE 事件流 /stream', '连上后能收到至少一行（心跳或事件）', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(args.timeoutMs, 25000));
    try {
      const response = await fetch(`${args.base.replace(/\/$/, '')}/_team/stream`, {
        headers: { ...buildHeaders(args), accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return { pass: false, detail: `status=${response.status}` };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = '';
      while (received.length < 8) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
        if (received.includes('\n')) break;
      }
      try { await reader.cancel(); } catch { /* 断开即可 */ }
      return { pass: received.length > 0, detail: received.length > 0 ? `首帧=${JSON.stringify(received.slice(0, 40))}` : '连上但无数据' };
    } catch (error) {
      return { pass: false, detail: String(error && error.message ? error.message : error) };
    } finally {
      clearTimeout(timer);
    }
  });

  // 群相关检查：需要 groupId（缺省取群列表第一个反代群）
  add('群可用模型', '该群模型列表非空（反代群应来自上游目录）', async (context) => {
    const groupId = args.group || context.suggestedGroupId;
    if (!groupId) return { pass: false, detail: '没有可用群 id（先建群或用 --group 指定）' };
    const result = await callApi(args, `/groups/${encodeURIComponent(groupId)}/models`);
    const rows = result.payload?.models ?? result.payload ?? [];
    const list = Array.isArray(rows) ? rows : [];
    return { pass: result.ok && list.length > 0, detail: `group=${groupId} status=${result.status} 模型数=${list.length}` };
  });

  add('会话目标读回', '返回 target 字段（可为 null）', async (context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return { pass: false, detail: '没有会话 id 可用' };
    const result = await callApi(args, `/session/${encodeURIComponent(sessionId)}/target`);
    const payload = result.payload || {};
    const pass = result.ok && Object.prototype.hasOwnProperty.call(payload, 'target');
    return { pass, detail: `session=${sessionId.slice(0, 18)}… target=${JSON.stringify(payload.target ?? null)}` };
  });

  return checks;
}

async function discoverContext(args) {
  const groups = await callApi(args, '/groups');
  const rows = groups.payload?.groups ?? groups.payload ?? [];
  const list = Array.isArray(rows) ? rows : [];
  const reverseGroup = list.find((row) => String(row?.driver || '').startsWith('reverse')) || list[0];
  const sessions = await callApi(args, '/sessions/current');
  return {
    suggestedGroupId: args.group || reverseGroup?.id || '',
    sessionId: sessions.payload?.sessionId || '',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.token) {
    console.error('缺 token：--token <dsh_token> 或环境变量 DSH_SMOKE_TOKEN');
    console.error('  取法：从实例启动日志里找 token=… 的那一行（`grep -o "token=[A-Za-z0-9_-]*" <实例日志>`）');
    return 2;
  }
  const context = await discoverContext(args);
  const checks = createChecks(args);
  const results = [];
  for (const check of checks) {
    const outcome = await check.run(context);
    results.push({ ...check, ...outcome });
  }

  const failed = results.filter((item) => !item.pass);
  console.log(`\n能力冒烟：${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  console.log(`目标：${args.base}  平台：${args.platform}  群：${context.suggestedGroupId || '(无)'}\n`);
  for (const item of results) {
    console.log(`${item.pass ? '✅' : '❌'} ${item.name}`);
    console.log(`     期望：${item.expectation}`);
    console.log(`     实际：${item.detail}`);
  }
  if (failed.length > 0) {
    console.log('\n❌ 有失败项：上面每条的「期望 / 实际」就是差异所在，按条目修即可（不必逐个现象排查）。');
    return 1;
  }
  console.log('\n✅ 全部通过');
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('冒烟脚本自身异常：', error);
  process.exit(3);
});
