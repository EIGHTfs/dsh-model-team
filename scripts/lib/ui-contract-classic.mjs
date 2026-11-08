// ui-contract-classic.mjs —— 界面契约门禁的「classic（TSX）侧」断言。
//
// 为什么要单独一个文件：新界面的摘要规则必须和旧界面吃同一道门禁
// （否则「legacy 守住了、新界面漏了」没人会发现），但把那套逻辑塞进 check-ui-contract.mjs
// 会把那个文件顶过 400 行。这里只放 classic 侧的加载器、两条断言与它们的自证变体。
//
// 被测的是**将进产物的同一份代码**：ui/themes/base/views/list.tsx 用构建期同一个编译器编译后在 vm 里执行。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');
const LIST_SOURCE_PATH = path.join(PROJECT_ROOT, 'ui', 'theme-sdk', 'list-rules.ts');

const REACT_STUB = {
  useState: (initialValue) => [initialValue, () => {}],
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useEffect: () => {},
  useRef: (initialValue) => ({ current: initialValue }),
};
const JSX_RUNTIME_STUB = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };

/** 编译并执行 classic 列表的纯函数，返回其导出（buildListItemProps 等） */
export async function loadClassicListHelpers() {
  const buildTheme = await import('../build-theme.mjs');
  const sourceText = fs.readFileSync(LIST_SOURCE_PATH, 'utf8');
  const compiled = await buildTheme.compileTheme({ sourceText, resolveDir: path.dirname(LIST_SOURCE_PATH), sourcefile: 'list-rules.ts' });
  const sandboxModule = { exports: {} };
  vm.runInNewContext(compiled.bundleCode, {
    module: sandboxModule,
    exports: sandboxModule.exports,
    // list.tsx 会 import theme-sdk（hooks/actions）：单测路径不调用它们，用宽容桩即可
    require: (specifier) => {
      if (specifier === 'react') return REACT_STUB;
      if (specifier === 'react/jsx-runtime') return JSX_RUNTIME_STUB;
      return new Proxy({}, { get: () => () => undefined });
    },
    console,
    window: undefined,
  }, { filename: 'classic-list.cjs' });
  return sandboxModule.exports;
}

/** U-5：classic 侧同样是「后端给什么就显示什么」——副标题逐字等于接口值 */
export function checkClassicSummaryPassthrough(context) {
  const helpers = context.classicList;
  if (!helpers || typeof helpers.buildListItemView !== 'function') return ['classic 列表助手没加载到 buildListItemView'];
  const groups = Array.isArray(context.groups) ? context.groups : [];
  const comparable = groups.filter((group) => typeof group.summary === 'string' && group.summary.trim() !== '');
  if (comparable.length === 0) return ['后端没有带内容的 summary，classic 侧无从比对'];
  const problems = [];
  for (const group of comparable) {
    const props = helpers.buildListItemView(group, '', () => {});
    if (props.subtitle !== group.summary) {
      problems.push(`群 ${group.id}：classic 副标题被加工\n        接口：${JSON.stringify(group.summary)}\n        渲染：${JSON.stringify(props.subtitle)}`);
    }
  }
  return problems;
}

/** U-6：classic 侧 summary 为空（空串 / 纯空格 / 缺失）→ 副标题为空串，skin 因此不渲染节点 */
export function checkClassicEmptySummary(context) {
  const helpers = context.classicList;
  if (!helpers || typeof helpers.buildListItemView !== 'function') return ['classic 列表助手没加载到 buildListItemView'];
  const problems = [];
  const fixtures = [['空字符串', ''], ['只有空格', '   '], ['字段缺失', undefined]];
  for (const [label, summary] of fixtures) {
    const props = helpers.buildListItemView({ id: 'fixture', name: 'fixture', summary }, '', () => {});
    if (props.subtitle !== '') {
      problems.push(`${label}：classic 副标题应为空串（整行不渲染），实际 ${JSON.stringify(props.subtitle)}`);
    }
  }
  return problems;
}

/** 把 classic 助手换成变体（只替换 context，不碰真源码） */
function withClassicList(context, mutate) {
  return { ...context, classicList: mutate(context.classicList || {}) };
}

/**
 * 自证变体：违例必须红、合规必须绿。
 * 违例用「包一层」的方式表达（实现被改好之后仍然有效），不依赖真源码里的具体写法。
 */
export const CLASSIC_SELF_TEST_VARIANTS = [
  {
    assertionId: 'U-5',
    expect: 'red',
    label: 'classic 侧给副标题加料（加工了内容）',
    apply: (context) => withClassicList(context, (helpers) => ({
      ...helpers,
      buildListItemView: (group, currentGroupId, onClick) => {
        const props = helpers.buildListItemView(group, currentGroupId, onClick);
        return { ...props, subtitle: `${props.subtitle}（补一句后端没给的话）` };
      },
    })),
  },
  { assertionId: 'U-5', expect: 'green', label: 'classic 真实现（原样透传）', apply: (context) => context },
  {
    assertionId: 'U-6',
    expect: 'red',
    label: 'classic 侧空 summary 用「—」兜底',
    apply: (context) => withClassicList(context, (helpers) => ({
      ...helpers,
      buildListItemView: (group, currentGroupId, onClick) => {
        const props = helpers.buildListItemView(group, currentGroupId, onClick);
        return { ...props, subtitle: props.subtitle || '—' };
      },
    })),
  },
  { assertionId: 'U-6', expect: 'green', label: 'classic 真实现（空值不占位）', apply: (context) => context },
];
