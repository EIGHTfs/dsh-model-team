// 测试辅助：把宿主 ui/js 的纯函数分片在独立 vm 上下文里跑一遍，
// 拿到它们挂在 globalThis 上的转调入口（dshHostGeometry / dshHostUiFormat / dshHostTargetSource / dshHostListRules）。
//
// 为什么需要：主题 SDK 现在只是"按名字转调宿主实现"（单一实现留在宿主），
// 所以单测跑 SDK 时必须先有宿主那份；直接读源码跑一遍最贴近真实加载顺序。
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const HOST_PART_PATHS = [
  'ui/js/float/geometry.js',
  'ui/js/float/panel-fields.js',
  'ui/js/format/ui-format.js',
  'ui/js/float/target-source.js',
  'ui/js/format/list-rules.js',
  'ui/js/format/driver-view.js',
];

/** 宿主分片在加载期用到的少量环境垫片（都只在函数体内被调用，加载期不会真的跑） */
function createHostSandbox(extraGlobals = {}) {
  return vm.createContext({
    console,
    warnOnce: () => {},
    escapeHtml: (value) => String(value == null ? '' : value),
    renderAvatar: () => '?',
    ...extraGlobals,
  });
}

export async function loadHostGlobals(extraGlobals = {}) {
  const sandbox = createHostSandbox(extraGlobals);
  for (const relativePath of HOST_PART_PATHS) {
    const sourceText = await fs.readFile(path.join(PROJECT_ROOT, relativePath), 'utf8');
    vm.runInContext(sourceText, sandbox, { filename: relativePath });
  }
  return {
    dshHostGeometry: sandbox.dshHostGeometry,
    dshHostPanelFields: sandbox.dshHostPanelFields,
    dshHostUiFormat: sandbox.dshHostUiFormat,
    dshHostTargetSource: sandbox.dshHostTargetSource,
    dshHostListRules: sandbox.dshHostListRules,
    dshHostDriverView: sandbox.dshHostDriverView,
  };
}

/** 宿主分片的源码列表（供需要逐行扫描的用例复用） */
export const HOST_PART_FILES = HOST_PART_PATHS;
