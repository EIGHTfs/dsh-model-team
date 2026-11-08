// theme-config.cjs —— 构建期主题（HTML 骨架 + 样式文件清单）的解析与校验。
//
// 为什么单独成模块：这些逻辑全是"配置优先级 + 失败路径"，与"怎么拼产物"无关；
// 混在 build.cjs 里既不好单测（一 require 就会执行构建），也容易在改拼接逻辑时被顺手改坏。
// build.cjs 只负责调用 + 拼装，判定与报错都在这里。
//
// 三条硬口径（与 docs/03 §七 对应）：
//   ① 优先级：`--config <path>` → 环境变量 DSH_MODEL_TEAM_HOME 下的 config.json → 仓库内 config/config.json；
//   ② 都没配 theme → 静默回落 ui/index.html + ui/app.css（默认路径零影响）；
//   ③ **配了就必须有效**：路径不存在、html 缺 <body>/<script>、styles 里任一缺失 —— 一律直接失败，
//      报错必须带出那个具体路径。绝不"配错了就悄悄用默认"，否则会产出看着正常、其实不是目标主题的包。
//
// 路径语义：相对路径以 **仓库根** 为基准；允许绝对路径（用户自备主题可以在仓库外）。

const fs = require("node:fs");
const path = require("node:path");

// 数据根环境变量（与 src/gateway/paths.js 同名同义：部署侧用它指向插件数据目录）
const DATA_ROOT_ENV_VAR = "DSH_MODEL_TEAM_HOME";
const CONFIG_FILE_NAME = "config.json";
// 未配置主题时的缺省来源（仓库内相对路径）
const DEFAULT_THEME_HTML = path.join("ui", "index.html");
const DEFAULT_THEME_STYLES = [path.join("ui", "app.css")];

// design-only 区间：设计稿专用装饰（垫场层）只属于主题模板，构建时统一剥掉，绝不进宿主产物
const DESIGN_ONLY_HTML_PATTERN = /<!--\s*design-only:begin\s*-->[\s\S]*?<!--\s*design-only:end\s*-->/g;
const DESIGN_ONLY_CSS_PATTERN = /\/\*\s*design-only:begin\s*\*\/[\s\S]*?\/\*\s*design-only:end\s*\*\//g;

// 去掉设计稿专用装饰段（HTML 与 CSS 两种注释形态都支持）
function stripDesignOnly(text) {
  return String(text).replace(DESIGN_ONLY_HTML_PATTERN, "").replace(DESIGN_ONLY_CSS_PATTERN, "");
}

// 相对路径按仓库根解析；绝对路径原样（用户可以把主题放在仓库外）
function resolveFromRepoRoot(repoRoot, candidatePath) {
  return path.isAbsolute(candidatePath) ? candidatePath : path.resolve(repoRoot, candidatePath);
}

// 取 `--config <path>`：给了 `--config` 却没给值（或后面紧跟另一个开关）属于用法错误，直接报
function readConfigArg(argv) {
  const argumentsList = Array.isArray(argv) ? argv : [];
  const flagIndex = argumentsList.indexOf("--config");
  if (flagIndex < 0) return "";
  const value = String(argumentsList[flagIndex + 1] || "").trim();
  if (!value || value.startsWith("--")) {
    throw new Error("[theme] --config 需要一个配置文件路径，例如：node build.cjs --config ./theme/config.json");
  }
  return value;
}

// 读配置：JSON 坏掉要带路径报出来，不能静默当"没有配置"
function readJsonConfig(configPath) {
  let rawText;
  try {
    rawText = fs.readFileSync(configPath, "utf8");
  } catch (readError) {
    throw new Error(`[theme] 配置文件读取失败：${configPath}（${readError.message}）`);
  }
  try {
    return JSON.parse(rawText);
  } catch (parseError) {
    throw new Error(`[theme] 配置文件不是合法 JSON：${configPath}（${parseError.message}）`);
  }
}

function defaultTheme(repoRoot, configPath) {
  return {
    htmlPath: resolveFromRepoRoot(repoRoot, DEFAULT_THEME_HTML),
    stylePaths: DEFAULT_THEME_STYLES.map((styleRelativePath) => resolveFromRepoRoot(repoRoot, styleRelativePath)),
    source: "default",
    configPath: configPath || "",
  };
}

// TSX 主题源码段（docs/22 §7.1）：与 legacy 的 html/styles 二选一，同时配就是配置冲突。
// 为什么冲突必须失败：两条渲染路径同时生效时，界面上会一半新一半旧，
// 而且「看起来能用」会让人以为迁移完成了 —— 这种状态最难发现、最难回退。
function resolveThemeSource(theme, { repoRoot, configPath }) {
  const hasLegacyPath = theme.html !== undefined || theme.styles !== undefined;
  if (typeof theme.source !== "string" || theme.source.trim().length === 0) {
    throw new Error(`[theme] ${configPath} 里的 theme.source 必须是非空字符串（TSX 主题路径）`);
  }
  if (hasLegacyPath) {
    throw new Error(`[theme] ${configPath} 同时配了 theme.source 与 theme.html/theme.styles：`
      + "主题配置冲突，TSX 路径与 legacy 路径只能选一条");
  }
  const themeSourcePath = resolveFromRepoRoot(repoRoot, theme.source.trim());
  if (!fs.existsSync(themeSourcePath)) {
    throw new Error(`[theme] ${configPath} 指定的 TSX 主题不存在：${themeSourcePath}`);
  }
  return { themeSourcePath, source: "tsx", configPath };
}

// 把 theme 段校验并解析成绝对路径。形状不对一律失败（配了就必须有效）
function resolveThemeFromConfig(theme, { repoRoot, configPath }) {
  if (typeof theme !== "object" || theme === null || Array.isArray(theme)) {
    throw new Error(`[theme] ${configPath} 里的 theme 必须是对象：{"html": "...", "styles": ["..."]}`);
  }
  if (theme.source !== undefined) {
    const resolvedSource = resolveThemeSource(theme, { repoRoot, configPath });
    // legacy 字段在 TSX 路径下不参与构建，但 apply 目前仍按 legacy 骨架挂载（M7 才切换渲染器），
    // 所以这里给出缺省的骨架与样式路径，构建产物保持可加载。
    const fallback = defaultTheme(repoRoot, configPath);
    return { ...resolvedSource, htmlPath: fallback.htmlPath, stylePaths: fallback.stylePaths };
  }
  if (typeof theme.html !== "string" || theme.html.trim().length === 0) {
    throw new Error(`[theme] ${configPath} 里的 theme.html 必须是非空字符串（HTML 骨架路径）`);
  }
  if (!Array.isArray(theme.styles) || theme.styles.length === 0) {
    throw new Error(`[theme] ${configPath} 里的 theme.styles 必须是非空数组（按顺序内联的样式文件）`);
  }
  const brokenIndex = theme.styles.findIndex((stylePath) => typeof stylePath !== "string" || stylePath.trim().length === 0);
  if (brokenIndex >= 0) {
    throw new Error(`[theme] ${configPath} 里的 theme.styles[${brokenIndex}] 不是有效路径`);
  }
  const htmlPath = resolveFromRepoRoot(repoRoot, theme.html.trim());
  const stylePaths = theme.styles.map((stylePath) => resolveFromRepoRoot(repoRoot, stylePath.trim()));

  // 「配了就必须有效」：在解析阶段就把不存在的文件顶出来（带完整路径），
  // 而不是等到拼接时读不到才报一个没有上下文的 ENOENT。
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`[theme] ${configPath} 指定的主题 HTML 不存在：${htmlPath}`);
  }
  const missingStylePath = stylePaths.find((stylePath) => !fs.existsSync(stylePath));
  if (missingStylePath) {
    throw new Error(`[theme] ${configPath} 指定的样式文件不存在：${missingStylePath}`);
  }

  return { htmlPath, stylePaths, source: "config", configPath };
}

// 按优先级挑配置文件：显式 --config 必须存在；环境变量/仓库内配置存在才用
function resolveThemeConfig(options) {
  const settings = options || {};
  const repoRoot = settings.repoRoot;
  const argv = settings.argv || [];
  const environment = settings.env || process.env;
  if (!repoRoot) throw new Error("[theme] resolveThemeConfig 需要 repoRoot");

  const configPathFromArgv = readConfigArg(argv);
  const candidates = [];
  if (configPathFromArgv) {
    candidates.push({ configPath: resolveFromRepoRoot(repoRoot, configPathFromArgv), mustExist: true });
  }
  const dataRoot = String(environment[DATA_ROOT_ENV_VAR] || "").trim();
  if (dataRoot) candidates.push({ configPath: path.resolve(dataRoot, CONFIG_FILE_NAME), mustExist: false });
  candidates.push({ configPath: path.resolve(repoRoot, "config", CONFIG_FILE_NAME), mustExist: false });

  for (const candidate of candidates) {
    const exists = fs.existsSync(candidate.configPath);
    if (!exists) {
      if (candidate.mustExist) {
        throw new Error(`[theme] --config 指定的配置文件不存在：${candidate.configPath}`);
      }
      continue;
    }
    const config = readJsonConfig(candidate.configPath);
    const theme = config ? config.theme : undefined;
    // 配置在但没有 theme：视为"没配置主题"，回落默认（零影响）
    if (theme === undefined || theme === null) return defaultTheme(repoRoot, candidate.configPath);
    return resolveThemeFromConfig(theme, { repoRoot, configPath: candidate.configPath });
  }

  return defaultTheme(repoRoot, "");
}

// 骨架 HTML 的可用性：必须同时有 <body 与 <script>，否则 build 抽不出骨架、也剥不掉脚本
function assertThemeHtml(html, htmlPath) {
  const source = String(html == null ? "" : html);
  if (source.indexOf("<body") < 0) {
    throw new Error(`[theme] 主题 HTML 缺少 <body 标记：${htmlPath}`);
  }
  if (source.indexOf("<script") < 0) {
    throw new Error(`[theme] 主题 HTML 缺少 <script 标记：${htmlPath}`);
  }
  return source;
}

// 读一个样式文件：若它本身是 @import 入口（当前 ui/app.css 就是），按 import 顺序展开并在各自目录下解析。
// 展开规则与既有实现一致（只展开一层、按出现顺序、以该文件所在目录为基准），保证默认路径产物逐字节不变。
function readStyleFile(stylePath, { expandImports }) {
  const styleText = fs.readFileSync(stylePath, "utf8");
  if (!expandImports) return stripDesignOnly(styleText);

  const importPattern = /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/g;
  const importPaths = Array.from(styleText.matchAll(importPattern))
    .map((matched) => matched[1].replace(/^\.\//, ""));
  if (!importPaths.length) return stripDesignOnly(styleText);

  const baseDirectory = path.dirname(stylePath);
  return importPaths
    .map((relativePath) => {
      const importedPath = path.resolve(baseDirectory, relativePath);
      if (!fs.existsSync(importedPath)) {
        throw new Error(`[theme] 样式 @import 指向的文件不存在：${importedPath}（来自 ${stylePath}）`);
      }
      return stripDesignOnly(fs.readFileSync(importedPath, "utf8"));
    })
    .join("\n");
}

// 按数组顺序读全部样式；任一缺失直接失败并带出路径（配了就必须有效）
function readThemeStyles(stylePaths, options) {
  const settings = options || {};
  const expandImports = settings.expandImports !== false;
  return (stylePaths || []).map((stylePath) => {
    if (!fs.existsSync(stylePath)) {
      throw new Error(`[theme] 样式文件不存在：${stylePath}`);
    }
    return readStyleFile(stylePath, { expandImports });
  });
}

module.exports = {
  DATA_ROOT_ENV_VAR,
  DEFAULT_THEME_HTML,
  DEFAULT_THEME_STYLES,
  resolveThemeConfig,
  resolveThemeFromConfig,
  assertThemeHtml,
  readThemeStyles,
  stripDesignOnly,
};
