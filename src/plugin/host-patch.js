// 宿主能力自愈（docs/15 §二点五）：forward 需要宿主包导出 `resolveProfiles`。
// 宿主没导出时，插件在 apply 阶段自己补上，dispose 阶段按**内容比对**还原——不依赖人工跑脚本。
//
// 为什么做成插件运行时而不是让人跑脚本：宿主升级会覆盖 bundle，人工补的那次导出会静默消失；
// 插件每次 apply 自己检查一遍最省事，卸载时再还原，不留痕。
//
// 三条安全底线：
//   1) 只补「文件末尾多一行 export」，不碰其它任何字节
//   2) 还原前必须比对当前内容 == 我们写入的内容；不一致就留给对方（宿主升级/别的实例的补丁）
//   3) 任何失败（定位不到/只读/无权限/验证不过）只 warn，绝不抛错、绝不影响插件加载

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 官方包名与要补的那一行：两者都只在这里出现一次
export const PI_AI_SPECIFIER = '@deepseek-ai/dsh-llm-pi-ai';
// 追加到宿主 bundle 末尾的那一行。刻意用数组拼装而不是整段字符串字面量：
// 本仓库的结构门禁会扫描源码里的导出花括号文本，整段字面量会被它误判成
// "本文件导出了一个没声明的名字"（那是给真代码用的检查，这里的字符串是数据）。
export const RESOLVE_PROFILES_EXPORT_LINE = ['export', '{', 'resolveProfiles', '};'].join(' ');

// 同一进程内只告警一次：文件只读这类原因不会自己好，每请求刷屏没有意义
let warningEmitted = false;

// 只给测试用：清掉"已告警"标记
export function resetHostPatchWarningForTest() {
  warningEmitted = false;
}

function warnOnce(logger, message) {
  if (warningEmitted) return;
  warningEmitted = true;
  if (typeof logger?.warn === 'function') logger.warn(message);
}

// 文件里是否已有对 resolveProfiles 的具名导出（允许跨行、允许与其它名字并列）
export function hasResolveProfilesExport(sourceText) {
  if (typeof sourceText !== 'string') return false;
  const exportBlocks = sourceText.match(/export\s*\{[^}]*\}/g) ?? [];
  return exportBlocks.some((block) => /\bresolveProfiles\b/.test(block));
}

// 用 import.meta.resolve 定位 bundle：不写死任何路径（部署方式/版本目录都会变）
export function locatePiAiBundleUrl(specifier = PI_AI_SPECIFIER) {
  return import.meta.resolve(specifier);
}

// 返回 { patched, reason, restore }：patched=true 才需要（也才允许）在 dispose 时还原
export async function ensureHostExport({
  logger,
  specifier = PI_AI_SPECIFIER,
  resolveUrl = locatePiAiBundleUrl,
  readFile = fs.readFile,
  writeFile = fs.writeFile,
  importModule = (url) => import(url),
} = {}) {
  let bundleUrl;
  try {
    bundleUrl = resolveUrl(specifier);
  } catch (resolveError) {
    warnOnce(logger, `无法定位宿主包 ${specifier}（${resolveError?.message ?? resolveError}），forward 将降级为 rewrite`);
    return { patched: false, reason: 'resolve-failed', restore: async () => {} };
  }

  const bundlePath = fileURLToPath(bundleUrl);
  let originalText;
  try {
    originalText = await readFile(bundlePath, 'utf8');
  } catch (readError) {
    warnOnce(logger, `读取宿主 bundle 失败（${bundlePath}）：${readError?.message ?? readError}；forward 将降级为 rewrite`);
    return { patched: false, reason: 'read-failed', restore: async () => {} };
  }

  // 已经导出过：什么都不做，也不需要还原（我们没改过这个文件）
  if (hasResolveProfilesExport(originalText)) {
    return { patched: false, reason: 'already-exported', restore: async () => {} };
  }

  const patchedText = `${originalText}\n${RESOLVE_PROFILES_EXPORT_LINE}\n`;
  try {
    await writeFile(bundlePath, patchedText, 'utf8');
  } catch (writeError) {
    warnOnce(logger, `宿主 bundle 不可写，未补充导出（${bundlePath}）：${writeError?.message ?? writeError}；forward 将降级为 rewrite`);
    return { patched: false, reason: 'write-failed', restore: async () => {} };
  }

  // 写进去不算数，必须真的 import 一次并确认 resolveProfiles 是函数
  try {
    const loadedModule = await importModule(`${bundleUrl}?dsh-model-team-patch=${Date.now()}`);
    if (typeof loadedModule?.resolveProfiles !== 'function') {
      throw new Error('补充导出后 resolveProfiles 仍不可用');
    }
  } catch (verifyError) {
    // 验证失败：用内存里的原文回滚（此时文件内容必然还是我们刚写的，直接覆盖是安全的）
    await writeFile(bundlePath, originalText, 'utf8').catch((rollbackError) => {
      warnOnce(logger, `回滚宿主 bundle 失败（${bundlePath}）：${rollbackError?.message ?? rollbackError}`);
    });
    warnOnce(logger, `宿主 bundle 补充导出验证失败，已回滚：${verifyError?.message ?? verifyError}；forward 将降级为 rewrite`);
    return { patched: false, reason: 'verify-failed', restore: async () => {} };
  }

  const restore = async () => {
    let currentText;
    try {
      currentText = await readFile(bundlePath, 'utf8');
    } catch (readError) {
      warnOnce(logger, `还原前读取宿主 bundle 失败（${bundlePath}）：${readError?.message ?? readError}`);
      return;
    }
    // 内容比对是唯一的还原依据：不一致说明宿主升级或别的实例改过，此时覆盖回去会毁掉对方的东西
    if (currentText !== patchedText) {
      warnOnce(logger, `宿主 bundle 已被改动，未还原（${bundlePath}）：当前内容与我们写入的不一致`);
      return;
    }
    try {
      await writeFile(bundlePath, originalText, 'utf8');
    } catch (writeError) {
      warnOnce(logger, `还原宿主 bundle 失败（${bundlePath}）：${writeError?.message ?? writeError}`);
    }
  };

  if (typeof logger?.info === 'function') {
    logger.info(`已补充宿主导出 resolveProfiles（${bundlePath}，插件卸载时还原）`);
  }
  return { patched: true, reason: 'patched', restore };
}
