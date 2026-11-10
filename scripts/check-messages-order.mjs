#!/usr/bin/env node
// G2：消息排序逆序检测（排序规则见 docs/02 §3.2 的 startedAt；门禁自证见 docs/12 R4）。
//
// 为什么单独成脚本、不进 gate-all：它读**真实运行数据**（请求行 + 会话事件），
// 放进总门禁会让 CI 依赖本机数据、不可重复。它只是"现场体检"工具。
//
// 用法：
//   node scripts/check-messages-order.mjs --data-root <插件数据根>
//   node scripts/check-messages-order.mjs --fixture <fixture.json>   # 离线复现
//
// 逻辑：用**生产的 buildMessages**（同一份 ui/js/view/messages.js，不复制逻辑）逐群合并，
// 再看输出里相邻两条的"绝对时间"是否非递减；绝对时间优先取 startedAtMs / at。
// 有逆序 → 打印两条明细并以 1 退出。

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MESSAGES_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui/js/view/messages.js');

function parseArgs(argv) {
  const options = { dataRoot: null, fixture: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--data-root') options.dataRoot = argv[index + 1];
    else if (token === '--fixture') options.fixture = argv[index + 1];
  }
  return options;
}

/** 用生产实现（同一份源码，注入最小依赖）算出某群的消息序列 */
async function loadBuildMessages() {
  const source = await fs.readFile(MESSAGES_SOURCE_PATH, 'utf8');
  // 生产文件是普通分片（无 import/export），在函数作用域里求值即可拿到 buildMessages
  // eslint-disable-next-line no-new-func
  return new Function(`${source};return buildMessages;`)();
}

async function readJsonLines(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (readError) {
    if (readError?.code === 'ENOENT') return [];
    throw readError;
  }
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { /* 坏行跳过，不阻塞体检 */ }
  }
  return rows;
}

/** 绝对时间：请求行用 startedAtMs，会话事件用 at；都没有返回 null（不参与逆序判定） */
function absoluteTimeOf(message) {
  if (message.type === 'row') {
    const startedAtMs = message.row?.startedAtMs;
    if (typeof startedAtMs === 'number' && Number.isFinite(startedAtMs)) return startedAtMs;
    const atIso = message.row?.at;
    if (typeof atIso === 'string' && !Number.isNaN(Date.parse(atIso))) return Date.parse(atIso);
    return null;
  }
  const eventIso = message.at;
  if (typeof eventIso === 'string' && !Number.isNaN(Date.parse(eventIso))) return Date.parse(eventIso);
  return null;
}

function describeMessage(message) {
  if (message.type === 'row') {
    return `请求行 ${message.time || '?'} model=${message.row?.model ?? '?'} status=${message.row?.status ?? '?'}`;
  }
  return `${message.type === 'mine' ? '我的消息' : '系统提示'} ${message.time || '?'} ${(message.text || '').slice(0, 40)}`;
}

/** 逐群体检：返回 { groupId, total, inversions: [{prev, next}] } */
function checkGroup(buildMessages, groupId, rows, events) {
  const messages = buildMessages(groupId, rows, events);
  const inversions = [];
  let previous = null;
  for (const message of messages) {
    const absoluteTime = absoluteTimeOf(message);
    if (absoluteTime === null) continue;         // 无绝对时间不参与比较（契约：排最后、不比较）
    if (previous && absoluteTime < previous.absoluteTime) {
      inversions.push({ prev: previous.message, next: message });
    }
    previous = { absoluteTime, message };
  }
  return { groupId, total: messages.length, inversions };
}

async function collectFromDataRoot(dataRoot) {
  const requestsPath = path.join(dataRoot, 'stats', 'requests.jsonl');
  const requestRows = await readJsonLines(requestsPath);
  const sessionsDir = path.join(dataRoot, 'sessions');
  let eventFiles = [];
  try {
    eventFiles = (await fs.readdir(sessionsDir)).filter((name) => name.endsWith('.events.jsonl'));
  } catch { eventFiles = []; }

  const events = [];
  for (const fileName of eventFiles) {
    const rows = await readJsonLines(path.join(sessionsDir, fileName));
    for (const row of rows) events.push(row);
  }

  const groupIds = new Set();
  for (const row of requestRows) if (row?.account?.id) groupIds.add(String(row.account.id));
  for (const event of events) if (event?.groupId) groupIds.add(String(event.groupId));

  const byGroup = new Map();
  for (const groupId of groupIds) {
    byGroup.set(groupId, {
      rows: requestRows.filter((row) => row?.account?.id === groupId),
      events: events.filter((event) => event?.groupId === groupId),
    });
  }
  return byGroup;
}

async function collectFromFixture(fixturePath) {
  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const byGroup = new Map();
  for (const [groupId, payload] of Object.entries(fixture.groups || {})) {
    byGroup.set(groupId, { rows: payload.rows || [], events: payload.events || [] });
  }
  return byGroup;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dataRoot && !options.fixture) {
    console.error('用法：node scripts/check-messages-order.mjs --data-root <插件数据根> | --fixture <fixture.json>');
    process.exit(2);
  }

  const buildMessages = await loadBuildMessages();
  const byGroup = options.fixture ? await collectFromFixture(options.fixture) : await collectFromDataRoot(options.dataRoot);
  const sourceLabel = options.fixture ? `fixture ${options.fixture}` : `data-root ${options.dataRoot}`;

  let totalGroups = 0;
  let badGroups = 0;
  let totalInversions = 0;
  for (const [groupId, payload] of byGroup) {
    totalGroups += 1;
    const result = checkGroup(buildMessages, groupId, payload.rows, payload.events);
    if (result.inversions.length === 0) {
      console.log(`✅ ${groupId}：${result.total} 条消息，无逆序`);
      continue;
    }
    badGroups += 1;
    totalInversions += result.inversions.length;
    console.log(`❌ ${groupId}：${result.total} 条消息，${result.inversions.length} 处逆序`);
    for (const { prev, next } of result.inversions.slice(0, 5)) {
      console.log(`   ↳ 逆序对：${describeMessage(prev)}  →  ${describeMessage(next)}`);
    }
  }

  console.log(`\n数据来源：${sourceLabel}`);
  console.log(`结论：${totalGroups} 个群，其中 ${badGroups} 个有逆序，共 ${totalInversions} 处`);
  process.exit(badGroups === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`体检失败：${error?.message ?? error}`);
  process.exit(2);
});
