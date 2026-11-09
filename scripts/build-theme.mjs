#!/usr/bin/env node
//
// build-theme.mjs —— 把 TSX 主题编译成可内联进 lib/client.js 的 CJS 代码。
//
// 为什么用 esbuild-wasm 而不是 esbuild：
//   本工作区挂在 CIFS 上（`cifs rw,nosuid,nodev,noexec`，且无软链接能力），
//   原生的 esbuild 两条路都堵死 ——
//     · 安装：npm 要在 node_modules/.bin 建软链，直接 ENOTSUP 中断；
//     · 运行：它的可执行文件在 noexec 挂载上 exec 被拒（Permission denied / exit 126）。
//   实测同一二进制复制到 btrfs 上就能跑，说明不是文件坏，是挂载策略。
//   esbuild-wasm 是同一官方引擎的 WASM 构建：不需要 exec、不需要软链，
//   选项与 docs/03 §7.2 完全一致，只是「怎么跑」换了。产物与原生版**结构等价**
//   （外部依赖仍是 require 字面量、无裸 import、react 未被打进来、字面量保留）。
//
// WASM 版没有文件系统（它是给浏览器用的），所以由本脚本把源码喂给 esbuild：
//   · 入口用 stdin（contents + resolveDir + loader）传；
//   · 本地 import 由 node-fs 插件读盘并补后缀（.tsx/.ts/.jsx/.js）；
//   · 平台模块表一律 external —— 产物里只留 require("react") 这类字面量。
//
// 用法：
//   node scripts/build-theme.mjs --dry        # 用内置最小 TSX 自检编译链路，不落盘
//   node scripts/build-theme.mjs              # 编译配置里的 theme.source，打印摘要（不写产物）
//   （build.cjs 通过 import 调用 buildThemeBundle 拿到代码再内联）

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const moduleRequire = createRequire(path.join(REPO_ROOT, 'package.json'));

/** 平台模块表（docs/03 §2.2）：宿主注入的 require 只能解析这些 specifier，其余一律打进 bundle */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

// 本地模块后缀补全顺序：与 esbuild 默认一致（先 jsx/tsx 再 js/ts 会让 .js 被 .tsx 抢走，这里按 esbuild 的实际顺序写）
const RESOLVE_SUFFIXES = ['', '.tsx', '.ts', '.jsx', '.js'];
const LOADER_BY_EXTENSION = { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.js': 'js', '.css': 'text' };
const THEME_REQUIRED_MARKER_PREFIX = 'data-theme-root';
const MIN_STYLES_SNIPPET_LENGTH = 40;

/** 内置最小主题：--dry 用它证明「编译链路本身是通的」，不依赖仓库里有没有主题文件 */
const DRY_RUN_TSX = `
import { defineTheme } from '../theme-sdk/index';

export default defineTheme({
  meta: { id: 'dry-run', name: 'dry run', contractVersion: 1 },
  Root: function DryRunRoot() {
    return <div data-theme-root="dry-run">dry</div>;
  },
});
`.trim();

let esbuildPromise = null;

/**
 * 加载并初始化 esbuild-wasm（一个进程只初始化一次：wasm 编译约 700ms，每次构建都初始化纯属浪费）。
 * browser 入口在 Node 里跑需要补一个 self 全局（它按 Web Worker 的全局写代码）。
 */
async function loadEsbuild() {
  if (esbuildPromise) return esbuildPromise;
  esbuildPromise = (async () => {
    let esbuild;
    try {
      esbuild = moduleRequire('esbuild-wasm/lib/browser.js');
    } catch (loadError) {
      throw new Error(`[theme] 缺少构建依赖 esbuild-wasm：先跑 npm install（${loadError.message}）`);
    }
    // browser 入口按 Web Worker 的全局写代码，Node 里补一个 self 别名即可；
    // （不需要伪造 location：初始化时传的是 wasmModule，不走 URL 解析这条路）
    if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
    const wasmPath = moduleRequire.resolve('esbuild-wasm/esbuild.wasm');
    const wasmModule = await WebAssembly.compile(fs.readFileSync(wasmPath));
    await esbuild.initialize({ wasmModule, worker: false });
    return esbuild;
  })();
  return esbuildPromise;
}

/**
 * 把本机文件系统接到 WASM 版 esbuild 上。
 * 这不是「改造产物」：wasm 版本来就没有 fs，浏览器里也是靠插件喂文件；
 * 这里只做 esbuild 常规的解析语义（相对路径 + 后缀补全），非相对导入一律报错。
 */
function createNodeFsPlugin() {
  return {
    name: 'node-fs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (resolveRequest) => {
        if (PLATFORM_MODULES.includes(resolveRequest.path)) return { path: resolveRequest.path, external: true };
        if (!resolveRequest.path.startsWith('.')) {
          return { errors: [{ text: `主题只能 import 平台模块或本地文件，不支持：${resolveRequest.path}` }] };
        }
        const basePath = path.resolve(resolveRequest.resolveDir, resolveRequest.path);
        for (const suffix of RESOLVE_SUFFIXES) {
          const candidatePath = basePath + suffix;
          if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) return { path: candidatePath };
        }
        return { errors: [{ text: `解析不到本地模块：${resolveRequest.path}（基准 ${basePath}）` }] };
      });
      build.onLoad({ filter: /.*/ }, (loadRequest) => ({
        contents: fs.readFileSync(loadRequest.path, 'utf8'),
        loader: LOADER_BY_EXTENSION[path.extname(loadRequest.path)] || 'js',
      }));
    },
  };
}

/**
 * 执行编译产物校验契约（docs/03 §4.2：defineTheme 的校验在构建期跑一次）。
 * 产物里有 require("react")，所以给一组桩：主题模块顶层只声明组件，不渲染，桩够用。
 * 顶层就调用 hook 的主题会在这里失败——那本来也是错的写法（组件函数体才会被 React 调用）。
 */
function readThemeDefinition(bundleCode) {
  const stubModules = {
    react: {
      createElement: () => null,
      Fragment: 'Fragment',
      useState: (initialValue) => [initialValue, () => {}],
      useMemo: (factory) => factory(),
      useRef: (initialValue) => ({ current: initialValue }),
      useSyncExternalStore: () => 0,
      useEffect: () => {},
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' },
    'react-dom': {},
    'react-dom/client': {},
  };
  const sandboxModule = { exports: {} };
  const sandboxRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(stubModules, specifier)) return stubModules[specifier];
    throw new Error(`[theme] 构建期校验时遇到未打桩的模块：${specifier}（平台模块表里没有它，或是主题漏了 external）`);
  };
  vm.runInNewContext(bundleCode, {
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: sandboxRequire,
    console,
  }, { filename: 'theme-bundle.cjs' });
  const exported = sandboxModule.exports || {};
  const definition = exported.default || exported;
  if (!definition || typeof definition !== 'object' || !definition.meta) {
    throw new Error('[theme] 编译产物没有导出主题定义：入口必须 export default defineTheme({...})');
  }
  return definition;
}

/** 产物断言（docs/03 §7.4）：缺一条即失败，报错要能指出是哪个文件 */
export function assertThemeBundle(bundleCode, themeDefinition) {
  const problems = [];
  const themeId = themeDefinition && themeDefinition.meta ? String(themeDefinition.meta.id) : '';
  // JSX 编译后属性变成对象字面量（"data-theme-root": "tim"），所以不能按 HTML 属性形式找；
  // 只认字面量：写成 data-theme-root={meta.id} 时构建期无法核对，主题规范里要求写死字面量。
  const declaredThemeIds = [...bundleCode.matchAll(/data-theme-root["']?\s*[:=]\s*["']([a-z0-9-]+)["']/g)].map((matched) => matched[1]);
  if (themeId && !declaredThemeIds.includes(themeId)) {
    problems.push(`产物里找不到 ${THEME_REQUIRED_MARKER_PREFIX}="${themeId}"（实际出现：${declaredThemeIds.join('、') || '无'}）——主题根节点必须带 data-theme-root="<meta.id>" 字面量`);
  }
  if (!bundleCode.includes('contractVersion')) problems.push('产物里找不到 contractVersion');
  if (bundleCode.includes('node_modules')) problems.push('产物里出现 node_modules 路径片段（有依赖被真打进来了）');
  const bareImports = bundleCode.split('\n').filter((line) => /^\s*import\s.+from\s/.test(line));
  if (bareImports.length) problems.push(`产物里有裸 import 语句：${bareImports[0].trim()}`);
  const requiredSpecifiers = [...bundleCode.matchAll(/require\("([^"]+)"\)/g)].map((matched) => matched[1]);
  const unknownSpecifiers = requiredSpecifiers.filter((specifier) => !PLATFORM_MODULES.includes(specifier));
  if (unknownSpecifiers.length) {
    problems.push(`产物 require 了平台模块表之外的东西：${[...new Set(unknownSpecifiers)].join('、')}（应打进 bundle 或加进平台模块表）`);
  }
  if (themeDefinition && typeof themeDefinition.styles === 'string' && themeDefinition.styles.length > MIN_STYLES_SNIPPET_LENGTH) {
    // 只在**同一行内**取样比对：产物里的换行是转义过的 \n（两个字符），带真实换行的片段永远匹配不上。
    const stylesHead = themeDefinition.styles.split('\n')[0].trim().slice(0, MIN_STYLES_SNIPPET_LENGTH);
    if (!bundleCode.includes(stylesHead)) problems.push(`主题声明了 styles，但产物的字符串里找不到那段 CSS（取样：${stylesHead.slice(0, 20)}…）——样式没被内联`);
  }
  if (problems.length) {
    throw new Error(`[theme] 产物断言不通过：\n  - ${problems.join('\n  - ')}`);
  }
  return problems;
}

/** 编译一处主题源码：入口内容 + 基准目录 → CJS 代码字符串 */

// 把产物注释里的本机绝对路径换成仓库相对路径（只动 `// …` 注释行，不碰代码与字符串）
function stripAbsolutePathComments(bundleCode) {
  const repoRootPrefix = `${REPO_ROOT}${path.sep}`;
  return String(bundleCode)
    .split('\n')
    .map((lineText) => {
      if (!lineText.startsWith('// ')) return lineText;
      const targetPath = lineText.slice(3).trim();
      if (!path.isAbsolute(targetPath)) return lineText;
      const relativePath = targetPath.startsWith(repoRootPrefix)
        ? targetPath.slice(repoRootPrefix.length).split(path.sep).join('/')
        : path.basename(targetPath);
      return `// ${relativePath}`;
    })
    .join('\n');
}

export async function compileTheme({ sourceText, resolveDir, sourcefile = 'theme.tsx' }) {
  const esbuild = await loadEsbuild();
  const result = await esbuild.build({
    stdin: { contents: sourceText, resolveDir, sourcefile, loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['es2020'],
    jsx: 'automatic',
    jsxImportSource: 'react',
    // 默认 charset=ascii 会把中文转成 \uXXXX 转义：产物不可读，且「样式是否内联」这类断言按原字符比对时会假红
    charset: 'utf8',
    external: PLATFORM_MODULES,
    loader: { '.css': 'text' },
    minify: false,
    metafile: true,
    plugins: [createNodeFsPlugin()],
  });
  const outputFile = result.outputFiles && result.outputFiles[0];
  if (!outputFile) throw new Error('[theme] 编译没有产出文件');
  // 产物里不能出现本机绝对路径：esbuild 会为每个模块写一行 `// <绝对路径>` 注释，
  // clone 到别的机器后那行就是无意义信息，也会泄露部署结构。这里统一改写成仓库相对路径。
  const sanitizedCode = stripAbsolutePathComments(outputFile.text);
  return { bundleCode: sanitizedCode, bytes: Buffer.byteLength(sanitizedCode), metafile: result.metafile };
}

/** 对外主入口（build.cjs 用）：编译配置指定的主题文件，返回代码 + 元信息（已过契约校验与产物断言） */
export async function buildThemeBundle(themeSourcePath) {
  const absolutePath = path.isAbsolute(themeSourcePath)
    ? themeSourcePath
    : path.resolve(REPO_ROOT, themeSourcePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`[theme] 主题源码不存在：${absolutePath}`);
  }
  const sourceText = fs.readFileSync(absolutePath, 'utf8');
  const compiled = await compileTheme({ sourceText, resolveDir: path.dirname(absolutePath), sourcefile: path.basename(absolutePath) });
  const themeDefinition = readThemeDefinition(compiled.bundleCode);
  assertThemeBundle(compiled.bundleCode, themeDefinition);
  return { bundleCode: compiled.bundleCode, meta: themeDefinition.meta, bytes: compiled.bytes, sourcePath: absolutePath, metafile: compiled.metafile };
}

function readArgument(argv, flagName) {
  const flagIndex = argv.indexOf(flagName);
  return flagIndex < 0 ? '' : String(argv[flagIndex + 1] || '');
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry');
  const explicitSource = readArgument(argv, '--source');

  if (dryRun) {
    // --dry：编译内置最小主题，证明链路可用；不落盘、不读配置
    const startedAt = Date.now();
    const compiled = await compileTheme({
      sourceText: DRY_RUN_TSX,
      resolveDir: path.join(REPO_ROOT, 'ui', 'themes'),
      sourcefile: 'dry-run.tsx',
    });
    const themeDefinition = readThemeDefinition(compiled.bundleCode);
    assertThemeBundle(compiled.bundleCode, themeDefinition);
    console.log(`[theme] --dry 编译通过：${compiled.bytes} 字节，${Date.now() - startedAt}ms，未落盘`);
    console.log(`[theme] 主题 meta：${JSON.stringify(themeDefinition.meta)}`);
    console.log(`[theme] require 清单：${[...new Set([...compiled.bundleCode.matchAll(/require\("([^"]+)"\)/g)].map((matched) => matched[1]))].join(', ')}`);
    return 0;
  }

  const themeConfig = moduleRequire('./scripts/lib/theme-config.cjs');
  const resolvedTheme = themeConfig.resolveThemeConfig({ argv, repoRoot: REPO_ROOT });
  const themeSourcePath = explicitSource || resolvedTheme.themeSourcePath;
  if (!themeSourcePath) {
    console.log('[theme] 配置里没有 theme.source：走 legacy 路径，本次不编译 TSX 主题');
    return 0;
  }
  const builtTheme = await buildThemeBundle(themeSourcePath);
  console.log(`[theme] 编译通过：${builtTheme.bytes} 字节，产物断言全过`);
  console.log(`[theme] 主题 meta：${JSON.stringify(builtTheme.meta)}`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
}
