// 会话 id 来源门禁：**当前会话 id 只能来自宿主槽位**，服务端「最近活跃」推断不得覆盖。
//
// 为什么需要（真实事故）：切换模型后请求仍走旧平台。取证发现 UI 把新目标写进了会话 A，
//    而真正在跑请求的是会话 B —— 因为兜底接口 `/_team/sessions/current` 返回的是
//    「宿主最近活跃会话」，它在槽位值到达之前先占位，就出现了「写 A 跑 B」。
//    文档 `docs/14` §1.3 早已规定：session id 只能以槽位为准，服务端接口只服务没有前端上下文的场景。
//
// 判据（静态 + 行为两条，缺一不可）：
//   1. 静态：`getCurrentSession(` 只允许出现在 `ui/js/interaction/session-bridge.js` 里，
//      且必须落在 `fetchSessionOnce` 函数体内（其它地方调用即红）。
//   2. 静态：`fetchSessionOnce` 体内必须有「已有会话 id 就返回」的守卫（不得无条件覆盖）。
//   3. 行为：由 `test/session-id-source.test.js` 覆盖三种时序（槽位先到 / 兜底先到 / 兜底期间槽位到达）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(MODULE_PATH), '..');

// 允许调用「最近活跃会话」兜底的唯一文件
const FALLBACK_FILE = 'ui/js/interaction/session-bridge.js';
const FALLBACK_FUNCTION = 'fetchSessionOnce';
// 需要扫描的源码范围（产物 lib/client.js 不扫：它是拼接结果，必然命中）
const SCANNED_ROOTS = ['ui', 'lib/client-parts', 'src'];
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.tsx']);

// 定位兜底调用点：api.getCurrentSession( / getCurrentSession(
// 排除「定义」而非「调用」的写法（function getCurrentSession( / getCurrentSession: …）
const FALLBACK_CALL = /getCurrentSession\s*\(/;
const FALLBACK_DEFINITION = /function\s+getCurrentSession\s*\(|getCurrentSession\s*:\s*(function|\()/;

function listSourceFiles(rootRelative) {
  const collected = [];
  const walk = (relativeDirectory) => {
    const absoluteDirectory = path.join(PROJECT_ROOT, relativeDirectory);
    let entries = [];
    try { entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) { walk(relativePath); continue; }
      if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) continue;
      collected.push(relativePath.split(path.sep).join('/'));
    }
  };
  walk(rootRelative);
  return collected;
}

// 取出某个函数体（按花括号配对，够用的粗粒度切片）
function extractFunctionBody(sourceText, functionName) {
  const declarationIndex = sourceText.indexOf(`function ${functionName}(`);
  if (declarationIndex < 0) return null;
  const bodyStart = sourceText.indexOf('{', declarationIndex);
  if (bodyStart < 0) return null;
  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return sourceText.slice(bodyStart, index + 1);
    }
  }
  return null;
}

export function checkSessionIdSource({ logger = console } = {}) {
  const failures = [];

  // 判据 1：兜底调用只许出现在唯一文件里
  for (const rootRelative of SCANNED_ROOTS) {
    for (const relativePath of listSourceFiles(rootRelative)) {
      const absolutePath = path.join(PROJECT_ROOT, relativePath);
      const sourceText = fs.readFileSync(absolutePath, 'utf8');
      const lines = sourceText.split('\n');
      lines.forEach((lineText, index) => {
        if (!FALLBACK_CALL.test(lineText)) return;
        if (FALLBACK_DEFINITION.test(lineText)) return;                // 定义处不算调用
        if (lineText.trim().startsWith('//') || lineText.trim().startsWith('*')) return;  // 注释里提到不算
        if (relativePath === FALLBACK_FILE) return;                    // 唯一允许的业务调用点
        if (relativePath === 'lib/client-parts/foundation/session.js') return;  // api 封装层：只返回 payload，不写状态
        // store/session.js 的启动兜底允许存在，但**必须标记来源为 fallback**（= 不可用于写目标）
        if (relativePath === 'ui/js/store/session.js') {
          const marksFallback = /sessionIdSource\s*=\s*['"]fallback['"]/.test(sourceText);
          if (marksFallback) return;
        }
        failures.push({
          file: relativePath,
          line: index + 1,
          reason: '当前会话 id 只能来自宿主槽位；「最近活跃会话」兜底只允许在 session-bridge 的 fetchSessionOnce 内调用',
        });
      });
    }
  }

  // 判据 2：兜底必须带「已知 id 就不覆盖」的守卫
  const bridgePath = path.join(PROJECT_ROOT, FALLBACK_FILE);
  if (!fs.existsSync(bridgePath)) {
    failures.push({ file: FALLBACK_FILE, line: 0, reason: '找不到会话桥文件（被改名或删除？）' });
  } else {
    const bridgeSource = fs.readFileSync(bridgePath, 'utf8');
    const body = extractFunctionBody(bridgeSource, FALLBACK_FUNCTION);
    if (!body) {
      failures.push({ file: FALLBACK_FILE, line: 0, reason: `找不到 ${FALLBACK_FUNCTION}：兜底入口缺失说明会话 id 来源不再受控` });
    } else {
      const hasKnownIdGuard = /getState\(\)\s*\.\s*sessionId/.test(body) && /\breturn\b/.test(body);
      if (!hasKnownIdGuard) {
        failures.push({
          file: FALLBACK_FILE,
          line: 0,
          reason: `${FALLBACK_FUNCTION} 缺少「已有会话 id 就返回」的守卫：兜底值会覆盖槽位值，导致写目标写进别的会话`,
        });
      }
    }
  }

  // 判据 3：写会话目标前必须校验「会话 id 来自槽位」
  const storeSessionPath = path.join(PROJECT_ROOT, 'ui/js/store/session.js');
  if (fs.existsSync(storeSessionPath)) {
    const storeSource = fs.readFileSync(storeSessionPath, 'utf8');
    const switchBody = extractFunctionBody(storeSource, 'switchTarget');
    if (!switchBody) {
      failures.push({ file: 'ui/js/store/session.js', line: 0, reason: '找不到 switchTarget：写目标的入口不受控' });
    } else if (!/sessionIdSource\s*!==\s*['"]slot['"]/.test(switchBody)) {
      failures.push({
        file: 'ui/js/store/session.js',
        line: 0,
        reason: "switchTarget 未校验 sessionIdSource === 'slot'：fallback 会话 id 会被用来写目标，落到别的会话上",
      });
    }
  } else {
    failures.push({ file: 'ui/js/store/session.js', line: 0, reason: '找不到会话状态模块' });
  }

  if (failures.length > 0) {
    logger.error(`❌ 会话 id 来源检查失败：${failures.length} 处`);
    for (const failure of failures) {
      logger.error(`   · ${failure.file}${failure.line ? ':' + failure.line : ''} —— ${failure.reason}`);
    }
    return { ok: false, failures };
  }

  logger.log('✅ 会话 id 来源合规：兜底只出现在唯一入口，且带「不覆盖槽位值」守卫');
  return { ok: true, failures: [] };
}

const INVOKED_PATH = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (INVOKED_PATH === MODULE_PATH) {
  const result = checkSessionIdSource();
  process.exit(result.ok ? 0 : 1);
}
