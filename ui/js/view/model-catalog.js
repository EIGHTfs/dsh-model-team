// model-catalog.js —— 加群页的「模型目录」：状态操作（加行/删行/恢复默认）、
// 「获取可用模型」探测接线（POST /_team/models/probe）、错误文案映射。
// 目录只存在 viewState.modelCatalog（不进全局 store）：它是表单草稿，不是会话级真相。

// 探测失败文案：优先按后端 error.code 给固定措辞，hint 作为补充。
// 'probe-failed' 覆盖「非密钥型平台」（如反代账号）：那些平台没有 API Key 概念，
// 文案里不能出现「API Key」，否则用户会去找一个根本不存在的填写框。
const PROBE_ERROR_TEXT = {
  'probe-unauthorized': '凭证无效或缺失，请检查 API Key',
  'probe-not-found': '接口地址不对（找不到 /models）',
  'probe-timeout': '请求超时，检查网络或地址',
  'probe-failed': '该平台无需密钥，请确认账号已登录'
};

function probeErrorMessage(errorPayload) {
  const code = errorPayload && errorPayload.code ? errorPayload.code : '';
  const hint = errorPayload && errorPayload.hint ? errorPayload.hint : '';
  const baseText = PROBE_ERROR_TEXT[code] || '探测失败，请稍后重试';
  return hint ? baseText + '（' + hint + '）' : baseText;
}

function currentPlatformForForm() {
  const current = ensureState();
  const platformId = viewState.addForm.platformId;
  return (current.platforms || []).filter(function (platform) { return platform.id === platformId; })[0]
    || (current.platforms || [])[0] || null;
}

// 「获取可用模型」：POST /_team/models/probe，只读探测、不落盘、不写 localStorage
function probeModelCatalog() {
  if (viewState.modelCatalog.probe.loading) return;      // loading 中禁止重复点击
  const platform = currentPlatformForForm();
  const baseURL = String(viewState.addForm.values.baseURL || (platform && platform.baseURL) || '').trim();
  if (!baseURL) {
    viewState.modelCatalog.probe.error = '请先填写 API 地址再探测';
    rerender();
    return;
  }

  viewState.modelCatalog.probe = { loading: true, error: '' };
  rerender();

  api.probeModels({
    driverId: platform ? platform.driverId : undefined,
    baseURL: baseURL,
    modelsEndpoint: (platform && platform.modelsEndpoint) || '/models',
    apiKey: String(viewState.addForm.values.apiKey || '')
  }).then(function (result) {
    viewState.modelCatalog.probe = { loading: false, error: '' };
    if (!result || !Array.isArray(result.models)) {
      viewState.modelCatalog.probe.error = probeErrorMessage(result && result.error);
      rerender();
      return;
    }
    // 成功：用探测结果覆盖目录，但保留用户已经改过的同名显示名
    const previousNames = {};
    viewState.modelCatalog.models.forEach(function (model) {
      if (model.id && model.name) previousNames[model.id] = model.name;
    });
    viewState.modelCatalog.models = result.models.map(function (model) {
      return { id: model.id, name: previousNames[model.id] || model.name || '' };
    });
    viewState.modelCatalog.mode = 'manual';
    rerender();
  });
}

// 目录行操作：加行 / 删行 / 恢复默认
function addModelRow() {
  viewState.modelCatalog.mode = 'manual';
  viewState.modelCatalog.models.push({ id: '', name: '' });
  rerender();
}

function removeModelRow(index) {
  viewState.modelCatalog.models.splice(index, 1);
  if (!viewState.modelCatalog.models.length) viewState.modelCatalog.mode = 'auto';
  rerender();
}

function resetModelCatalog() {
  viewState.modelCatalog = { mode: 'auto', models: [], probe: { loading: false, error: '' } };
  rerender();
}

// 提交用：过滤掉 id 为空的行
function collectStaticModels() {
  return viewState.modelCatalog.models
    .map(function (model) { return { id: String(model.id || '').trim(), name: String(model.name || '').trim() }; })
    .filter(function (model) { return model.id; });
}
