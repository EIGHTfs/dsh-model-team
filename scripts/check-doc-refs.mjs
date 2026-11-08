// 文档编号引用门禁：文档里出现的 `NN` 与 docs/NN 必须指向真实存在的文档。
//
// 为什么需要：文档重编号过一次（22/24/24A/25 合并为 03，其余整体重排），
// 全库有数百处编号引用；只靠人改必然漏，漏了就是死链——读者按编号找不到东西，
// 却不会有任何报错。这里把「引用」变成可机器检查的契约。
//
// 规则：
//   1. 反引号里的两位编号（可带 A 后缀），如 `02`、`03`、`24A`
//   2. 形如 docs/NN 的路径引用
//   3. 允许纯数字但不在文档名里的情况（如 `03` 条款 = 本文档内部编号，指自身）
//   4. 白名单：明确指向本文档自身的编号不报（避免每段都要写全路径）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fileURLToPathUrl(url) { return fileURLToPath(url); }

// 文档编号上限：超过它的反引号两位数字不当作文档引用（例如「96 行」这种行数说明）
const MAX_DOCUMENT_NUMBER = 30;

const DOCS_DIRECTORY = 'docs';
const REFERENCE_PATTERN = /`(\d{2}[A-Z]?)`|docs\/(\d{2}[A-Z]?)/g;

// 收集现有文档编号（文件名前缀）
function listDocumentNumbers(docsDirectory) {
  const numbers = new Set();
  for (const fileName of fs.readdirSync(docsDirectory)) {
    if (!fileName.endsWith('.md')) continue;
    const matched = /^(\d{2}[A-Z]?)-/.exec(fileName);
    if (matched) numbers.add(matched[1]);
  }
  return numbers;
}

// 扫描一个文件里所有引用；返回 [{ reference, line }]
function collectReferences(sourceText) {
  const references = [];
  const lines = sourceText.split('\n');
  lines.forEach((lineText, index) => {
    for (const match of lineText.matchAll(REFERENCE_PATTERN)) {
      const reference = match[1] ?? match[2];
      if (reference) references.push({ reference, line: index + 1 });
    }
  });
  return references;
}

export function checkDocumentReferences({ repoRoot = process.cwd(), logger = console } = {}) {
  const docsDirectory = path.join(repoRoot, DOCS_DIRECTORY);
  if (!fs.existsSync(docsDirectory)) {
    logger.log('✅ 文档引用检查：没有 docs 目录，跳过');
    return { ok: true, failures: [] };
  }

  const knownNumbers = listDocumentNumbers(docsDirectory);
  const failures = [];

  // 检查范围：docs/*.md 与仓库根 README.md
  const targets = fs.readdirSync(docsDirectory)
    .filter((fileName) => fileName.endsWith('.md'))
    .map((fileName) => path.join(docsDirectory, fileName));
  const readmePath = path.join(repoRoot, 'README.md');
  if (fs.existsSync(readmePath)) targets.push(readmePath);

  for (const filePath of targets) {
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const selfNumber = /^(\d{2}[A-Z]?)-/.exec(path.basename(filePath))?.[1] ?? null;
    for (const { reference, line } of collectReferences(sourceText)) {
      // 指向自己的编号不算错（如 03 文档里写「`03` 条款 8」）
      if (reference === selfNumber) continue;
      // 超出编号范围的不算文档引用（行数、端口、协议号等）
      const numericValue = Number.parseInt(reference, 10);
      if (!Number.isFinite(numericValue) || numericValue > MAX_DOCUMENT_NUMBER) continue;
      if (knownNumbers.has(reference)) continue;
      failures.push({
        file: path.relative(repoRoot, filePath),
        line,
        reference,
        reason: `没有编号为 ${reference} 的文档`,
      });
    }
  }

  if (failures.length > 0) {
    logger.error(`❌ 文档引用检查失败：${failures.length} 处`);
    for (const failure of failures.slice(0, 30)) {
      logger.error(`   · ${failure.file}:${failure.line} 引用 \`${failure.reference}\` —— ${failure.reason}`);
    }
    return { ok: false, failures };
  }

  logger.log(`✅ 文档引用一致：${targets.length} 份文档，引用的编号全部存在`);
  return { ok: true, failures: [] };
}

// CLI 入口：node scripts/check-doc-refs.mjs
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = fileURLToPathUrl(import.meta.url);
if (invokedPath === selfPath) {
  const result = checkDocumentReferences();
  process.exit(result.ok ? 0 : 1);
}
