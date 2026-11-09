#!/usr/bin/env node
// check-no-local-paths.mjs —— 禁止「绝对路径 / 本机专属描述」进仓库。
//
// 为什么：仓库要能换机、换部署、被第三方 clone 后照常工作。
//   · 绝对路径（/volume1/...、/var/packages/...、/tmp/...）在别的机器上不存在；
//   · 本机专属描述（内网 IP、设备名、厂商挂载点）只对本机有效，还会泄露部署结构。
// 正确写法：占位符（<repoRoot>、<dataRoot>、<本机IP>、<临时目录>）或相对路径（docs/…、src/…）。
//
// 允许的地方（不扫）：.trash/、artifacts/、node_modules/、.git/、本脚本自身。
//
// 用法：node scripts/check-no-local-paths.mjs   （供 gate-all 调用，也可单独跑）

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(MODULE_PATH), '..');

// 扫描范围：会被分发或被人照着读的文件
const SCANNED_DIRECTORIES = ['src', 'lib', 'ui', 'scripts', 'config', 'test', 'docs'];
const SCANNED_FILES = ['README.md', 'build.cjs', 'package.json', 'cordis.patch.yml'];
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml']);
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.git', '.trash', 'artifacts', '参考资料', '参考项目']);

// 规则：名字 + 正则 + 说明（说明会出现在报错里，告诉人怎么改）
const RULES = [
  { name: '绝对路径（卷/系统目录）', pattern: /(^|[^A-Za-z0-9._-])\/(volume[0-9]+|var\/packages|usr\/syno|opt\/syno|home\/[A-Za-z0-9._-]+|Users\/[A-Za-z0-9._-]+)\// },
  { name: '绝对路径（临时目录）', pattern: /(^|[^A-Za-z0-9._-])\/tmp\// },
  { name: '厂商挂载点', pattern: /@appdata|@appstore/ },
  { name: '内网 IP', pattern: /\b(10|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { name: '本机设备名/主机名', pattern: /\bsa6400(\.local)?\b/i },
];

function listFiles() {
  const collected = [];
  const walk = (relativeDirectory) => {
    const absoluteDirectory = path.join(PROJECT_ROOT, relativeDirectory);
    let entries = [];
    try { entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        walk(relativePath);
        continue;
      }
      if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) continue;
      collected.push(relativePath.split(path.sep).join('/'));
    }
  };
  for (const directory of SCANNED_DIRECTORIES) walk(directory);
  for (const fileName of SCANNED_FILES) {
    if (fs.existsSync(path.join(PROJECT_ROOT, fileName))) collected.push(fileName);
  }
  return collected.filter((relativePath) => relativePath !== 'scripts/check-no-local-paths.mjs');
}

function main() {
  const files = listFiles();
  const failures = [];
  for (const relativePath of files) {
    const lines = fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8').split('\n');
    lines.forEach((lineText, index) => {
      // 行内豁免：明确标注是为了说明"这是占位符示例"的行不报（例如本文档里的反例）
      if (lineText.includes('dsh-allow-local-path')) return;
      for (const rule of RULES) {
        // 临时目录例外：测试与脚本里用 /tmp 建临时根是运行期行为（不随仓库分发），
        // 但仍禁止把"某台机器上的固定路径"写进源码/文档。
        if (rule.name === '绝对路径（临时目录）' && (relativePath.startsWith('test/') || relativePath.startsWith('scripts/'))) continue;
        if (!rule.pattern.test(lineText)) continue;
        failures.push({ file: relativePath, line: index + 1, rule: rule.name, text: lineText.trim().slice(0, 120) });
        break;
      }
    });
  }

  if (failures.length > 0) {
    console.error(`❌ 发现绝对路径 / 本机专属描述：${failures.length} 处`);
    for (const failure of failures) {
      console.error(`   · ${failure.file}:${failure.line} [${failure.rule}]`);
      console.error(`     ${failure.text}`);
    }
    console.error('\n   改法：换成占位符（<repoRoot> / <dataRoot> / <本机IP> / <临时目录>）或相对路径。');
    console.error('   确需举反例示范时，在该行加注释标记 dsh-allow-local-path。');
    return 1;
  }
  console.log(`✅ 无绝对路径与本机专属描述：扫描 ${files.length} 个文件`);
  return 0;
}

process.exit(main());
