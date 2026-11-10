// add-form.js —— 「加群表单」的**值**：选项选中后的初值、探测请求体、提交请求体都只在这里生成。
//
// 为什么单独一个模块（而不是留在主题或 forms.js）：
//   ① 主题只该做"显示"——它渲染 label、schema、values，但**不认识** baseURL / modelsEndpoint / driverId；
//   ② forms.js 是"接口动作"的薄封装，不该持有表单中间态；
//   ③ 一旦这些值散到主题里，就只能靠 grep 禁令兜着，结构上迟早漏。
// 所以这里同时满足两条：值只存在这里（`state.addForm`），对外只暴露三个意图级动作。
//
// 选项的来源是 `format/driver-view.js` 的 listGroupOptions（纯投影 `{id,label}`）；
// 把 `preset:<平台id>` 展开成"平台默认值 + 用哪个驱动"的语义，也在本文件完成——
// 这与 legacy 的 resolvePlatformSelection（ui/js/view/render.js，0.4.0 已删）是同一套口径。

// 模型列表路径的缺省值：与后端 `src/gateway/config/constants.js` 的 DEFAULT_MODELS_ENDPOINT_PATH 一致。
// 为什么不从服务端读：这是"表单预填文本"，不是契约字段；后端缺省仍然由它自己兜（提交时留空即可）。
var DEFAULT_MODELS_ENDPOINT = '/models';

var PRESET_PREFIX = 'preset:';
var DRIVER_PREFIX = 'driver:';
var FALLBACK_DRIVER_ID = 'openai-compatible';

/** 新建一份空的加群表单状态（store 初始化与"切平台重置"共用同一形状） */
function createAddFormState() {
  return { optionId: '', driverKey: '', values: {}, advancedField: null };
}

function createAddFormActions(deps) {
  var api = deps.api;
  var state = deps.state;
  var broadcast = deps.broadcast;
  var reportError = deps.reportError;

  function ensureForm() {
    if (!state.addForm) state.addForm = createAddFormState();
    return state.addForm;
  }

  function driverById(driverKey) {
    var list = Array.isArray(state.drivers) ? state.drivers : [];
    for (var index = 0; index < list.length; index += 1) {
      if (list[index] && String(list[index].id) === String(driverKey)) return list[index];
    }
    return null;
  }

  function platformById(platformId) {
    var list = Array.isArray(state.platforms) ? state.platforms : [];
    for (var index = 0; index < list.length; index += 1) {
      if (list[index] && String(list[index].id) === String(platformId)) return list[index];
    }
    return null;
  }

  /**
   * 把选项 id 展开成"驱动 + 初值 + 高级字段"。不认识的选项返回 null（调用方当作没选）。
   * 高级字段（模型列表路径）只给配置型驱动：账号型平台的目录由驱动按账号取，后端也有默认值，
   * 让用户填只会造成误配（这正是 0.4.0 之前加群页的老毛病）。
   */
  function resolveSelection(optionId) {
    var normalized = String(optionId == null ? '' : optionId);
    if (normalized.length === 0) return null;
    var isPreset = normalized.indexOf(PRESET_PREFIX) === 0;
    var isDriver = normalized.indexOf(DRIVER_PREFIX) === 0;
    if (!isPreset && !isDriver) return null;

    var driverKey;
    var initialValues = {};
    if (isPreset) {
      var platform = platformById(normalized.slice(PRESET_PREFIX.length));
      if (!platform) return null;
      driverKey = String(platform.driverId || FALLBACK_DRIVER_ID);
      if (typeof platform.baseURL === 'string' && platform.baseURL.length > 0) initialValues.baseURL = platform.baseURL;
      if (typeof platform.modelsEndpoint === 'string' && platform.modelsEndpoint.length > 0) {
        initialValues.modelsEndpoint = platform.modelsEndpoint;
      }
    } else {
      driverKey = normalized.slice(DRIVER_PREFIX.length);
      if (!driverById(driverKey)) return null;
    }

    var driver = driverById(driverKey);
    var accountDriver = isAccountAuthDriver(driver);
    var advancedField = accountDriver ? null : {
      key: 'modelsEndpoint',
      label: '模型列表路径',
      placeholder: '留空用平台默认',
      // 配置型平台才需要手填，且默认给后端同一个值（不空着，避免用户以为必填）
      initialValue: initialValues.modelsEndpoint || DEFAULT_MODELS_ENDPOINT,
    };
    if (advancedField && advancedField.initialValue) initialValues.modelsEndpoint = advancedField.initialValue;

    return { optionId: normalized, driverKey: driverKey, values: initialValues, advancedField: advancedField };
  }

  /** 选中一个选项：写 form 状态 → 广播（渲染只由事件驱动） */
  function selectGroupOption(optionId) {
    var selection = resolveSelection(optionId);
    var form = ensureForm();
    if (!selection) {
      form.optionId = '';
      form.driverKey = '';
      form.values = {};
      form.advancedField = null;
      broadcast('form:changed', { form: 'add' });
      return Promise.resolve(null);
    }
    form.optionId = selection.optionId;
    form.driverKey = selection.driverKey;
    form.values = selection.values;
    form.advancedField = selection.advancedField;
    broadcast('form:changed', { form: 'add' });
    return Promise.resolve(selection);
  }

  /** 用户在某个字段上输入：只改这一格（键由 schema/advancedField 决定，主题不认识具体字段名） */
  function setAddFormValue(fieldKey, value) {
    var form = ensureForm();
    var key = String(fieldKey == null ? '' : fieldKey);
    if (key.length === 0) return Promise.resolve(form.values);
    form.values = Object.assign({}, form.values, { [key]: String(value == null ? '' : value) });
    broadcast('form:changed', { form: 'add' });
    return Promise.resolve(form.values);
  }

  function valueOf(fieldKey) {
    var form = ensureForm();
    return typeof form.values[fieldKey] === 'string' ? form.values[fieldKey] : '';
  }

  /** 探测可用模型：请求体在这里组（含账号型的 accountRef 与配置型的 baseURL/key） */
  function probeAddForm(input) {
    var settings = input || {};
    var form = ensureForm();
    var driver = driverById(form.driverKey);
    if (!driver) return Promise.reject(new Error('请先选择平台'));
    var request = { driver: form.driverKey };
    if (isAccountAuthDriver(driver)) {
      var platformId = String(driver.platformId || '');
      var accountId = String(settings.accountId || '');
      if (!platformId || !accountId) return Promise.reject(new Error('请先选择账号'));
      request.accountRef = 'account:' + platformId + '/' + accountId;
    } else {
      request.baseURL = valueOf('baseURL');
      request.modelsEndpoint = valueOf('modelsEndpoint');
      request.apiKey = valueOf('apiKey');
    }
    return api.probeModels(buildProbePayload(request));
  }

  /** 提交：加群 payload 在这里组，主题只传"用户填的名称"与已探测的模型清单 */
  function submitAddGroup(input) {
    var settings = input || {};
    var form = ensureForm();
    var driver = driverById(form.driverKey);
    if (!driver) return Promise.reject(new Error('请先选择平台'));
    var groupName = String(settings.name || '').trim();
    var payload = {
      name: groupName,
      driver: form.driverKey,
      baseURL: valueOf('baseURL'),
      avatar: '',
    };
    var models = Array.isArray(settings.models) ? settings.models : [];
    if (models.length > 0) {
      payload.models = { static: models };
    } else if (valueOf('modelsEndpoint').length > 0) {
      payload.models = { endpoint: valueOf('modelsEndpoint') };
    }
    if (isAccountAuthDriver(driver)) {
      var platformId = String(driver.platformId || '');
      var accountId = String(settings.accountId || '');
      if (!platformId || !accountId) return Promise.reject(new Error('请先选择账号'));
      payload.auth = { apiKeyRef: 'account:' + platformId + '/' + accountId };
      payload.accessMode = 'reverse';
    } else {
      payload.auth = { apiKey: valueOf('apiKey') };
    }
    return api.createGroup(payload);
  }

  return {
    addForm: ensureForm,
    selectGroupOption: selectGroupOption,
    setAddFormValue: setAddFormValue,
    probeAddForm: probeAddForm,
    submitAddGroup: submitAddGroup,
    // 纯函数单独暴露给单测（不改变 state）
    resolveAddFormSelection: resolveSelection,
  };
}

/** 探测接口的请求体（服务端契约字段：driverId/apiKeyRef/baseURL/modelsEndpoint/apiKey） */
function buildProbePayload(request) {
  var payload = { driverId: request.driver };
  if (request.accountRef) {
    payload.apiKeyRef = request.accountRef;
  } else {
    payload.baseURL = request.baseURL || '';
    payload.modelsEndpoint = request.modelsEndpoint || DEFAULT_MODELS_ENDPOINT;
    payload.apiKey = request.apiKey || '';
  }
  return payload;
}
