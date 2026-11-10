#!/usr/bin/env node
// G3：消息排序的静态契约门禁（规则见 docs/02 §3.2；门禁自证见 docs/12 R4）。
//
// 检查对象：ui/js/view/messages.js 的 messageSortValue。
// 契约：排序键必须包含**绝对时间**（请求行的 startedAtMs / 事件的整条 ISO `at`），
//       不得把时间砍成"当天毫秒偏移"——那样跨午夜必然把新消息判成更早。
//
// 当前实现仍是当天偏移，所以本门禁**现在应当是红的**；排序修好后自然变绿。
// 尚未挂进 gate-all（由 Lead 决定何时挂）。

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MESSAGES_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui/js/view/messages.js');

// 绝对时间字段名（契约 docs/02 §3.2：请求行出参 startedAt；事件用 at）
const ABSOLUTE_TIME_FIELDS = ['startedAt', 'startedAtMs', "'at'", '"at"', '.at', 'getTime()', 'valueOf()'];
// 排序键必须通过"绝对时间"取值的入口函数（允许实现抽成 helper，但不允许绕过它只算时分秒）
const ABSOLUTE_TIME_HELPERS = ['absoluteTimeOf('];
// 已知缺陷写法：把 Date 拆成时分秒再加权（当天偏移）
const TIME_OF_DAY_ONLY = /getHours\(\)\s*\*\s*[A-Z_]*(HOUR|3600000)/;

function extractFunctionBody(source, functionName) {
  const signatureIndex = source.indexOf(`function ${functionName}(`);
  if (signatureIndex < 0) return null;
  const bodyStart = source.indexOf('{', signatureIndex);
  if (bodyStart < 0) return null;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  return null;
}

const source = await fs.readFile(MESSAGES_SOURCE_PATH, 'utf8');
const body = extractFunctionBody(source, 'messageSortValue');

const failures = [];
if (!body) {
  failures.push('找不到 messageSortValue —— 排序入口被改名或删除，门禁无法判断');
} else {
  const callsAbsoluteHelper = ABSOLUTE_TIME_HELPERS.some((helperName) => body.includes(helperName));
  const hasAbsoluteField = ABSOLUTE_TIME_FIELDS.some((fieldName) => body.includes(fieldName))
    || (callsAbsoluteHelper && ABSOLUTE_TIME_FIELDS.some((fieldName) => source.includes(fieldName)));
  if (!hasAbsoluteField) {
    failures.push(`messageSortValue 没有使用绝对时间（缺 ${ABSOLUTE_TIME_FIELDS.join(' / ')} 或 absoluteTimeOf 入口）：跨日排序必然错`);
  }
  if (TIME_OF_DAY_ONLY.test(body)) {
    failures.push('messageSortValue 把时间换算成"当天毫秒偏移"（getHours()*3600000 …）：跨午夜会把新消息判成更早');
  }
}

if (failures.length === 0) {
  console.log('✅ 消息排序契约：messageSortValue 使用绝对时间字段');
  process.exit(0);
}

console.error('❌ 消息排序契约未满足：');
for (const failure of failures) console.error(`   · ${failure}`);
console.error(`\n文件：${path.relative(PROJECT_ROOT, MESSAGES_SOURCE_PATH)}`);
process.exit(1);
