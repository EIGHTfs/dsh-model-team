// G9：构建期主题（TSX 主题源码）配置。
//
// 为什么值得单测：主题配置的优先级与"配了必须有效"这两条，出错的后果都是**产出包不对却看不出来**
// （构建成功、页面正常、只是不是你以为的主题）。所以这里把每条失败路径都钉成断言。
// 0.4.0 起只支持 theme.source（TSX）；legacy 的 theme.html / theme.styles 已移除，配了必须报错。
// 断言里**没有任何本机绝对路径**：仓库根、配置、主题文件全部在 os.tmpdir() 下现造。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import themeConfig from '../scripts/lib/theme-config.cjs';

const { resolveThemeConfig, DEFAULT_THEME_SOURCE } = themeConfig;

const VALID_THEME_SOURCE = `export default defineTheme({ meta: { id: 'probe', name: 'Probe', contractVersion: 1 } });\n`;

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'theme-config-'));
}

/** 造一个可用的 TSX 主题文件，返回相对仓库根的路径 */
async function createThemeSource(repoRoot, relativePath = path.join('themes', 'probe.tsx')) {
  const absolutePath = path.join(repoRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, VALID_THEME_SOURCE);
  return { relativePath, absolutePath };
}

async function writeConfig(configPath, config) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

/** 仓库根：造一个自带默认主题的最小仓库（默认主题要从 repoRoot 相对解析） */
async function createRepoRoot() {
  const repoRoot = await makeTempRoot();
  const defaultAbsolute = path.join(repoRoot, DEFAULT_THEME_SOURCE);
  await fs.mkdir(path.dirname(defaultAbsolute), { recursive: true });
  await fs.writeFile(defaultAbsolute, VALID_THEME_SOURCE);
  return repoRoot;
}

test('G9-①：都没有配置 → source=default，回落到仓库内 ui/themes/tim.tsx', async () => {
  const repoRoot = await createRepoRoot();
  const resolved = resolveThemeConfig({ argv: [], repoRoot, env: {} });
  assert.equal(resolved.source, 'default');
  assert.equal(resolved.themeSourcePath, path.join(repoRoot, DEFAULT_THEME_SOURCE));
});

test('G9-②：--config 优先于环境变量（两份配置都给，取 --config 的）', async () => {
  const repoRoot = await createRepoRoot();
  const fromArgv = await createThemeSource(repoRoot, path.join('themes', 'argv.tsx'));
  const fromEnv = await createThemeSource(repoRoot, path.join('themes', 'env.tsx'));
  const argvConfig = await writeConfig(path.join(repoRoot, 'argv-config.json'), { theme: { source: fromArgv.relativePath } });
  await writeConfig(path.join(repoRoot, 'data-root', 'config.json'), { theme: { source: fromEnv.relativePath } });

  const resolved = resolveThemeConfig({
    argv: ['--config', argvConfig],
    repoRoot,
    env: { DSH_MODEL_TEAM_HOME: path.join(repoRoot, 'data-root') },
  });
  assert.equal(resolved.themeSourcePath, fromArgv.absolutePath);
});

test('G9-③：环境变量优先于仓库内 config/config.json', async () => {
  const repoRoot = await createRepoRoot();
  const envTheme = await createThemeSource(repoRoot, path.join('themes', 'env.tsx'));
  const repoSettings = await createThemeSource(repoRoot, path.join('themes', 'repo.tsx'));
  await writeConfig(path.join(repoRoot, 'config', 'config.json'), { theme: { source: repoSettings.relativePath } });
  await writeConfig(path.join(repoRoot, 'data-root', 'config.json'), { theme: { source: envTheme.relativePath } });

  const resolved = resolveThemeConfig({
    argv: [],
    repoRoot,
    env: { DSH_MODEL_TEAM_HOME: path.join(repoRoot, 'data-root') },
  });
  assert.equal(resolved.themeSourcePath, envTheme.absolutePath);
});

test('G9-④：配置里的 theme.source 不存在 → 抛错且错误信息含该路径（不回落默认）', async () => {
  const repoRoot = await createRepoRoot();
  const missingSource = path.join('themes', 'missing.tsx');
  const configPath = await writeConfig(path.join(repoRoot, 'config', 'config.json'), { theme: { source: missingSource } });

  assert.throws(
    () => resolveThemeConfig({ argv: [], repoRoot, env: {} }),
    (error) => error.message.includes(path.join(repoRoot, missingSource)) && error.message.includes(configPath),
  );
});

test('G9-⑤：--config 指向不存在的配置文件 → 抛错（用法错误不许静默回落）', async () => {
  const repoRoot = await createRepoRoot();
  const missingConfig = path.join(repoRoot, 'no-such-config.json');
  assert.throws(
    () => resolveThemeConfig({ argv: ['--config', missingConfig], repoRoot, env: {} }),
    (error) => error.message.includes(missingConfig),
  );
});

test('G9-⑥：配置存在但没有 theme 段 → 视为未配置，回落默认主题', async () => {
  const repoRoot = await createRepoRoot();
  await writeConfig(path.join(repoRoot, 'config', 'config.json'), { somethingElse: true });
  const resolved = resolveThemeConfig({ argv: [], repoRoot, env: {} });
  assert.equal(resolved.source, 'default');
  assert.equal(resolved.themeSourcePath, path.join(repoRoot, DEFAULT_THEME_SOURCE));
});

test('G9-⑦：theme.source 形状不对（非字符串/空串）→ 抛错', async () => {
  const repoRoot = await createRepoRoot();
  await writeConfig(path.join(repoRoot, 'config', 'config.json'), { theme: { source: 42 } });
  assert.throws(() => resolveThemeConfig({ argv: [], repoRoot, env: {} }), /theme\.source 必须是非空字符串/);

  await writeConfig(path.join(repoRoot, 'config', 'config.json'), { theme: { source: '   ' } });
  assert.throws(() => resolveThemeConfig({ argv: [], repoRoot, env: {} }), /theme\.source 必须是非空字符串/);
});

test('G9-⑧：legacy 的 theme.html / theme.styles 已移除 → 配了就报错（不静默走旧路径）', async () => {
  const repoRoot = await createRepoRoot();
  await writeConfig(path.join(repoRoot, 'config', 'config.json'), { theme: { html: 'ui/index.html', styles: ['ui/app.css'] } });
  assert.throws(
    () => resolveThemeConfig({ argv: [], repoRoot, env: {} }),
    /theme\.html \/ theme\.styles 已移除/,
  );
});
