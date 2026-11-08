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

// 表单当前选中的「平台 / 驱动」组合。
// 为什么不能用 currentPlatformForForm：下拉里有两类值——preset:<平台id> 与 driver:<驱动id>；
// 反代走的是后者（没有平台预置），旧实现只查 platforms，找不到就**回落到第一个平台**，
// 于是反代点探测会把请求发去 Agnes，拿回 401 → 界面显示「请检查 API Key」，看着像凭据问题。
function resolveProbeTarget() {
  const current = ensureState();
  const selection = resolvePlatformSelection(
    current.platforms || [],
    current.drivers || [],
    viewState.addForm.platformId
  );
  return { platform: selection.platform, driver: selection.driver };
}

// 账号型驱动（如反代）：凭据是账号引用，不需要地址与 Key
function isAccountAuthDriver(driver) {
  return Boolean(driver && driver.authKind === 'reverse-account');
}

// 探测请求体：纯函数，便于单测（不读 DOM、不读全局状态）
//   target: { platform, driver }
//   values: 表单值（baseURL / apiKey）
//   accountId: 账号型驱动选中的账号 id
function buildProbePayload(target, values, accountId) {
  const driver = target && target.driver ? target.driver : null;
  const platform = target && target.platform ? target.platform : null;
  const formValues = values || {};

  if (isAccountAuthDriver(driver)) {
    const platformId = String(driver.platformId || '');
    const trimmedAccountId = String(accountId || '').trim();
    if (!trimmedAccountId) return { error: '请先登录后再获取模型列表' };
    if (!platformId) return { error: '驱动缺少平台标识，无法组装账号引用' };
    // 账号型驱动自己按引用取凭据；不需要 baseURL，也不需要 apiKey
    return { payload: { driverId: driver.id, apiKeyRef: 'account:' + platformId + '/' + trimmedAccountId } };
  }

  const baseURL = String(formValues.baseURL || (platform && platform.baseURL) || '').trim();
  if (!baseURL) return { error: '请先填写 API 地址再探测' };
  return {
    payload: {
      driverId: platform ? platform.driverId : (driver ? driver.id : undefined),
      baseURL: baseURL,
      modelsEndpoint: (platform && platform.modelsEndpoint) || '/models',
      apiKey: String(formValues.apiKey || '')
    }
  };
}

// 「获取可用模型」：POST /_team/models/probe，只读探测、不落盘、不写 localStorage
function probeModelCatalog() {
  if (viewState.modelCatalog.probe.loading) return;      // loading 中禁止重复点击
  const target = resolveProbeTarget();
  const accountSelectNode = document.querySelector('#reverseAccountSelect');
  const accountId = accountSelectNode ? String(accountSelectNode.value || '') : '';
  const built = buildProbePayload(target, viewState.addForm.values, accountId);
  if (built.error) {
    viewState.modelCatalog.probe.error = built.error;
    rerender();
    return;
  }

  viewState.modelCatalog.probe = { loading: true, error: '' };
  rerender();

  api.probeModels(built.payload).then(function (result) {
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
