#!/usr/bin/env node
// check-theme-compile.mjs —— 每个主题都必须能单独编译通过。
//
// 为什么需要：主题样式写在模板字符串里，注释里出现反引号会截断模板，
// 这类错误 `node --check` 查不出来，只有真正跑一次编译才暴露；
// 而默认构建只编译"配置里选中的那一个主题"，另一个坏了没人发现。
//
// 判据：ui/themes/*.tsx 逐个编译成功；任一失败即非零退出并打印该主题的错误。

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildThemeBundle } from './build-theme.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES_DIRECTORY = path.join(PROJECT_ROOT, 'ui', 'themes');

// 旧式规则：全局（html[data-dmt-theme] 前缀）隐藏 .team-app —— 会把主题自身的主窗口一起藏掉
// （真机踩过：主题窗口 0×0、界面只剩球，而门禁与单测全绿）
const LEGACY_GLOBAL_HIDE_PATTERN = /html\[data-dmt-theme\][\s\S]{0,200}?\.team-app[\s\S]{0,200}?display:\s*none/;

async function main() {
  let fileNames = [];
  try {
    fileNames = (await fs.readdir(THEMES_DIRECTORY)).filter((name) => name.endsWith('.tsx')).sort();
  } catch {
    console.error('❌ 找不到 ui/themes 目录');
    return 1;
  }
  if (fileNames.length === 0) {
    console.error('❌ ui/themes 里没有 .tsx 主题');
    return 1;
  }

  const failures = [];
  for (const fileName of fileNames) {
    const absolutePath = path.join(THEMES_DIRECTORY, fileName);
    try {
      const built = await buildThemeBundle(absolutePath);
      const expectedId = path.basename(fileName, '.tsx');
      const problemsForFile = [];
      if (built.meta?.id !== expectedId) {
        problemsForFile.push(`meta.id 是「${built.meta?.id ?? '(缺)'}」，应与文件名一致（${expectedId}）`);
      }
      const bundleText = String(built.bundleCode ?? '');
      if (!(built.bytes > 0) || bundleText.length === 0) problemsForFile.push('编译产物为空');
      if (!bundleText.includes('data-theme-root')) problemsForFile.push('产物缺少主题根字面量 data-theme-root');
      // 注释里为了说明历史也可能出现这条规则的字面量：先剥掉 CSS/JS 注释再判定
      const codeWithoutComments = bundleText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (LEGACY_GLOBAL_HIDE_PATTERN.test(codeWithoutComments)) {
        problemsForFile.push('仍用「全局隐藏 legacy」的旧规则（html[data-dmt-theme] … display:none），会把主题自己的主窗口藏掉；应收窄到 .dmt-host');
      }
      if (problemsForFile.length > 0) {
        failures.push({ fileName, message: problemsForFile.join('；') });
        continue;
      }
      console.log(`✅ ${fileName} 编译通过（${built.bytes} 字节，meta.id=${built.meta.id}）`);
    } catch (error) {
      failures.push({ fileName, message: error && error.message ? error.message : String(error) });
    }
  }

  if (failures.length > 0) {
    console.error(`❌ 主题编译失败：${failures.length} 个`);
    for (const failure of failures) {
      console.error(`   · ${failure.fileName}: ${failure.message.split('\n')[0]}`);
    }
    return 1;
  }
  console.log(`✅ 全部主题可独立编译：${fileNames.length} 个`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('主题编译检查自身异常：', error);
  process.exit(3);
});
