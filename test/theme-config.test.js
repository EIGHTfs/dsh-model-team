// G9：构建期主题（HTML 骨架 + 样式清单）配置。
//
// 为什么值得单测：主题配置的三级优先级与"配了必须有效"这两条，出错的后果都是**产出包不对却看不出来**
// （构建成功、页面正常、只是不是你以为的主题）。所以这里把每条失败路径都钉成断言。
// 断言里**没有任何本机绝对路径**：仓库根、配置、主题文件全部在 os.tmpdir() 下现造。
//
// 被测模块是 CommonJS（build.cjs 用 require），这里用默认导入取同名函数。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import themeConfig from '../scripts/lib/theme-config.cjs';

const { resolveThemeConfig, assertThemeHtml, readThemeStyles } = themeConfig;

const VALID_HTML = '<html><body><div class="team-app" id="floatDock"></div><script>1</script></html>';

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'theme-config-'));
}

// 造一套可用的主题：html + 两个样式文件（内容带标记，便于断言顺序）
async function createTheme(directory, { name = 'theme', styleMarkers = ['.a{}', '.b{}'] } = {}) {
  const themeDirectory = path.join(directory, name);
  await fs.mkdir(themeDirectory, { recursive: true });
  const htmlPath = path.join(themeDirectory, 'index.html');
  await fs.writeFile(htmlPath, VALID_HTML);
  const stylePaths = [];
  for (const [index, marker] of styleMarkers.entries()) {
    const stylePath = path.join(themeDirectory, `style-${index + 1}.css`);
    await fs.writeFile(stylePath, `/* ${marker} */\n${marker}\n`);
    stylePaths.push(stylePath);
  }
  return { directory: themeDirectory, htmlPath, stylePaths };
}

async function writeConfig(configPath, config) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

test('G9-①：都没有配置 → source=default，回落仓库内 ui/index.html + ui/app.css', async () => {
  const repoRoot = await makeTempRoot();
  const theme = resolveThemeConfig({ argv: [], env: {}, repoRoot });

  assert.equal(theme.source, 'default');
  assert.equal(theme.htmlPath, path.join(repoRoot, 'ui', 'index.html'));
  assert.deepEqual(theme.stylePaths, [path.join(repoRoot, 'ui', 'app.css')]);
  assert.equal(theme.configPath, '');
});

test('G9-②：--config 优先于环境变量（两份配置都给，取 --config 的）', async () => {
  const repoRoot = await makeTempRoot();
  const fromArgv = await createTheme(repoRoot, { name: 'from-argv' });
  const fromEnv = await createTheme(repoRoot, { name: 'from-env' });
  const argvConfigPath = path.join(repoRoot, 'argv.json');
  const envRoot = path.join(repoRoot, 'env-home');
  const envConfigPath = path.join(envRoot, 'config.json');
  await writeConfig(argvConfigPath, { theme: { html: fromArgv.htmlPath, styles: fromArgv.stylePaths } });
  await writeConfig(envConfigPath, { theme: { html: fromEnv.htmlPath, styles: fromEnv.stylePaths } });

  const theme = resolveThemeConfig({ argv: ['--config', argvConfigPath], env: { DSH_MODEL_TEAM_HOME: envRoot }, repoRoot });

  assert.equal(theme.source, 'config');
  assert.equal(theme.configPath, argvConfigPath);
  assert.equal(theme.htmlPath, fromArgv.htmlPath);
});

test('G9-③：环境变量优先于仓库内 config/config.json', async () => {
  const repoRoot = await makeTempRoot();
  const fromRepoConfig = await createTheme(repoRoot, { name: 'from-repo' });
  const fromEnv = await createTheme(repoRoot, { name: 'from-env' });
  await writeConfig(path.join(repoRoot, 'config', 'config.json'), {
    theme: { html: fromRepoConfig.htmlPath, styles: fromRepoConfig.stylePaths },
  });
  const envRoot = path.join(repoRoot, 'env-home');
  await writeConfig(path.join(envRoot, 'config.json'), {
    theme: { html: fromEnv.htmlPath, styles: fromEnv.stylePaths },
  });

  const theme = resolveThemeConfig({ argv: [], env: { DSH_MODEL_TEAM_HOME: envRoot }, repoRoot });

  assert.equal(theme.htmlPath, fromEnv.htmlPath);
  assert.equal(theme.configPath, path.join(envRoot, 'config.json'));
});

test('G9-④：配置里的 html 路径不存在 → 抛错且错误信息含该路径（不回落默认）', async () => {
  const repoRoot = await makeTempRoot();
  const theme = await createTheme(repoRoot);
  const missingHtmlPath = path.join(repoRoot, 'no-such-theme', 'index.html');
  const configPath = path.join(repoRoot, 'config', 'config.json');
  await writeConfig(configPath, { theme: { html: missingHtmlPath, styles: theme.stylePaths } });

  assert.throws(
    () => resolveThemeConfig({ argv: [], env: {}, repoRoot }),
    (error) => {
      assert.match(error.message, /主题 HTML 不存在/);
      assert.ok(error.message.includes(missingHtmlPath), '错误里必须带出不存在的那个路径');
      return true;
    },
  );
});

test('G9-⑤：主题 HTML 缺 <body → assertThemeHtml 抛错且带路径', async () => {
  const htmlPath = path.join(await makeTempRoot(), 'no-body.html');
  await fs.writeFile(htmlPath, '<html><script>1</script></html>');

  assert.throws(
    () => assertThemeHtml('<html><script>1</script></html>', htmlPath),
    (error) => {
      assert.match(error.message, /缺少 <body/);
      assert.ok(error.message.includes(htmlPath));
      return true;
    },
  );
});

test('G9-⑥：主题 HTML 缺 <script → assertThemeHtml 抛错且带路径', async () => {
  const htmlPath = path.join(await makeTempRoot(), 'no-script.html');
  await fs.writeFile(htmlPath, '<html><body></body></html>');

  assert.throws(
    () => assertThemeHtml('<html><body></body></html>', htmlPath),
    (error) => {
      assert.match(error.message, /缺少 <script/);
      assert.ok(error.message.includes(htmlPath));
      return true;
    },
  );
});

test('G9-⑦：styles 顺序被保留（按数组顺序返回，不排序不合并）', async () => {
  const repoRoot = await makeTempRoot();
  const theme = await createTheme(repoRoot, { styleMarkers: ['.second{}', '.first{}'] });
  const configPath = path.join(repoRoot, 'config', 'config.json');
  // 故意让"数组顺序"与"文件名字典序"相反，才能证明用的是数组顺序
  const orderedStyles = [theme.stylePaths[1], theme.stylePaths[0]];
  await writeConfig(configPath, { theme: { html: theme.htmlPath, styles: orderedStyles } });

  const resolved = resolveThemeConfig({ argv: [], env: {}, repoRoot });
  assert.deepEqual(resolved.stylePaths, orderedStyles);

  const styleTexts = readThemeStyles(resolved.stylePaths, { expandImports: false });
  assert.match(styleTexts[0], /\.first\{\}/);
  assert.match(styleTexts[1], /\.second\{\}/);
});

test('G9-⑧：styles 里有一个不存在 → 抛错且错误信息含该路径', async () => {
  const repoRoot = await makeTempRoot();
  const theme = await createTheme(repoRoot);
  const missingStylePath = path.join(repoRoot, 'no-such-style.css');
  const configPath = path.join(repoRoot, 'config', 'config.json');
  await writeConfig(configPath, { theme: { html: theme.htmlPath, styles: [...theme.stylePaths, missingStylePath] } });

  assert.throws(
    () => resolveThemeConfig({ argv: [], env: {}, repoRoot }),
    (error) => {
      assert.match(error.message, /样式文件不存在/);
      assert.ok(error.message.includes(missingStylePath));
      return true;
    },
  );
});

test('G9-⑨：--config 指向不存在的配置文件 → 抛错（用法错误不许静默回落）', async () => {
  const repoRoot = await makeTempRoot();
  const missingConfigPath = path.join(repoRoot, 'no-such-config.json');

  assert.throws(
    () => resolveThemeConfig({ argv: ['--config', missingConfigPath], env: {}, repoRoot }),
    (error) => {
      assert.match(error.message, /--config 指定的配置文件不存在/);
      assert.ok(error.message.includes(missingConfigPath));
      return true;
    },
  );
});

test('G9-⑩：配置存在但没有 theme 段 → 视为未配置，回落默认路径', async () => {
  const repoRoot = await makeTempRoot();
  const configPath = path.join(repoRoot, 'config', 'config.json');
  await writeConfig(configPath, { groups: [], virtualModel: 'dsh-model-team' });

  const theme = resolveThemeConfig({ argv: [], env: {}, repoRoot });

  assert.equal(theme.source, 'default');
  assert.equal(theme.htmlPath, path.join(repoRoot, 'ui', 'index.html'));
  assert.equal(theme.configPath, configPath, '仍要记下读的是哪份配置，便于日志排查');
});

test('G9-⑪：theme.styles 不是非空数组 / theme.html 不是字符串 → 抛错（形状不对必须失败）', async () => {
  const repoRoot = await makeTempRoot();
  const theme = await createTheme(repoRoot);
  const configPath = path.join(repoRoot, 'config', 'config.json');

  await writeConfig(configPath, { theme: { html: theme.htmlPath, styles: [] } });
  assert.throws(() => resolveThemeConfig({ argv: [], env: {}, repoRoot }), /theme\.styles 必须是非空数组/);

  await writeConfig(configPath, { theme: { html: '', styles: theme.stylePaths } });
  assert.throws(() => resolveThemeConfig({ argv: [], env: {}, repoRoot }), /theme\.html 必须是非空字符串/);
});
