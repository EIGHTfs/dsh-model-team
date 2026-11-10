// theme-config.cjs —— 构建期主题（TSX 主题源码）的解析与校验。
//
// 为什么单独成模块：这些逻辑全是"配置优先级 + 失败路径"，与"怎么拼产物"无关；
// 混在 build.cjs 里既不好单测（一 require 就会执行构建），也容易在改拼接逻辑时被顺手改坏。
// build.cjs 只负责调用 + 拼装，判定与报错都在这里。
//
// 三条硬口径（与 docs/03 §七 对应）：
//   ① 优先级：`--config <path>` → 环境变量 DSH_MODEL_TEAM_HOME 下的 config.json → 仓库内 config/config.json；
//   ② 都没配 theme → 静默回落 ui/themes/tim.tsx（0.4.0 起已没有 legacy HTML 这条路）；
//   ③ **配了就必须有效**：路径不存在、形状不对 —— 一律直接失败，报错必须带出具体路径。
//      绝不"配错了就悄悄用默认"，否则会产出看着正常、其实不是目标主题的包。
//
// 路径语义：相对路径以 **仓库根** 为基准；允许绝对路径（用户自备主题可以在仓库外）。

const fs = require("node:fs");
const path = require("node:path");

// 数据根环境变量（与 src/gateway/paths.js 同名同义：部署侧用它指向插件数据目录）
const DATA_ROOT_ENV_VAR = "DSH_MODEL_TEAM_HOME";
const CONFIG_FILE_NAME = "config.json";
// 未配置主题时的缺省来源：TSX 主题源码（仓库内相对路径）
const DEFAULT_THEME_SOURCE = path.join("ui", "themes", "tim.tsx");

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

// 未配置主题：回落仓库自带的默认 TSX 主题（不存在就是仓库坏了，直接失败）
function defaultTheme(repoRoot, configPath) {
  const themeSourcePath = resolveFromRepoRoot(repoRoot, DEFAULT_THEME_SOURCE);
  if (!fs.existsSync(themeSourcePath)) {
    throw new Error(`[theme] 默认主题源码不存在：${themeSourcePath}（仓库应自带 ui/themes/tim.tsx）`);
  }
  return { themeSourcePath, source: "default", configPath: configPath || "" };
}

// TSX 主题源码段（docs/03 §7.1）：只认 theme.source。
// 0.4.0 起 legacy 的 theme.html / theme.styles 已移除——配了就直接失败，
// 否则会产出"看着正常、其实还在走旧渲染路径"的包（这种状态最难发现）。
function resolveThemeSource(theme, { repoRoot, configPath }) {
  const hasLegacyPath = theme.html !== undefined || theme.styles !== undefined;
  if (hasLegacyPath) {
    throw new Error(`[theme] ${configPath} 里的 theme.html / theme.styles 已移除（0.4.0 起只支持 theme.source，`
      + "界面样式由主题 TSX 自带）");
  }
  if (typeof theme.source !== "string" || theme.source.trim().length === 0) {
    throw new Error(`[theme] ${configPath} 里的 theme.source 必须是非空字符串（TSX 主题路径）`);
  }
  const themeSourcePath = resolveFromRepoRoot(repoRoot, theme.source.trim());
  if (!fs.existsSync(themeSourcePath)) {
    throw new Error(`[theme] ${configPath} 指定的 TSX 主题不存在：${themeSourcePath}`);
  }
  return { themeSourcePath, source: "config", configPath };
}

// 把 theme 段校验并解析成绝对路径。形状不对一律失败（配了就必须有效）
function resolveThemeFromConfig(theme, options) {
  const settings = options || {};
  const configPath = settings.configPath || "";
  if (typeof theme !== "object" || theme === null || Array.isArray(theme)) {
    throw new Error(`[theme] ${configPath} 里的 theme 必须是对象：{"source": "ui/themes/tim.tsx"}`);
  }
  return resolveThemeSource(theme, { repoRoot: settings.repoRoot, configPath });
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
    // 配置在但没有 theme：视为"没配置主题"，回落默认
    if (theme === undefined || theme === null) return defaultTheme(repoRoot, candidate.configPath);
    return resolveThemeFromConfig(theme, { repoRoot, configPath: candidate.configPath });
  }

  return defaultTheme(repoRoot, "");
}

module.exports = {
  DATA_ROOT_ENV_VAR,
  DEFAULT_THEME_SOURCE,
  resolveThemeConfig,
  resolveThemeFromConfig,
};
