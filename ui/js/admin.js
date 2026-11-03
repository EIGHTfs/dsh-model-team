// admin.js —— 管理侧交互：加群提交、数据库导入导出。
// 导出取 api.exportConfig() 的结果触发下载；导入交给 api.importConfig() 校验后展示回执。

const REVOKE_URL_DELAY_MS = 1500;   // 下载触发后延迟回收 blob URL
const GROUP_ID_SUFFIX_LENGTH = 8;   // 新群名后面拼的 id 尾号长度

// 提交加群表单：选中的平台决定 driver（authSchema 校验）与默认头像/摘要模板。
// 平台信息全部来自 /_team/platforms，这里只用返回值，不写死任何平台字段。
function submitNewGroup() {
  // 重复点击保护：请求在途时直接返回。没有这道闸，双击会连发两次建群，
  // 后端不去重 → 列表里出现同名群（G-12 的另一半症状）。
  if (viewState.addForm.submitting) return;
  const current = ensureState();
  // 平台选择值有两种形态：preset:<平台id>（预置，带 baseURL/头像/摘要模板）
  // 或 driver:<驱动id>（通用入口，只有驱动本身）。两种都要支持提交。
  const selection = resolvePlatformSelection(current.platforms || [], current.drivers || [], viewState.addForm.platformId);
  const selectedPlatform = selection.platform;
  const selectedDriver = selection.driver;
  if (!selectedDriver) { toast('平台/驱动列表未就绪'); return; }

  // 以 DOM 里的实际表单值为准：预填值只写进了 input 的 value，不一定同步回 viewState
  const nameNode = document.querySelector('#groupNameInput');
  const groupName = String((nameNode && nameNode.value) || viewState.addForm.name || '').trim();
  if (!groupName) { toast('请填写群名称'); return; }

  const authValues = {};
  Array.prototype.slice.call(document.querySelectorAll('[data-auth-key]')).forEach(function (node) {
    authValues[node.dataset.authKey] = String(node.value || '').trim();
  });

  const missingLabels = (selectedDriver.authSchema || []).filter(function (field) {
    return field.required && !authValues[field.key];
  }).map(function (field) { return field.label; });
  if (missingLabels.length) { toast('请填写必填项：' + missingLabels.join('、')); return; }

  const groupId = 'mock-' + Date.now().toString(36);
  // 摘要按平台模板渲染（{baseURL} 占位），模板也来自后端
  const domBaseURL = document.querySelector('[data-auth-key="baseURL"]');
  const baseURL = String((domBaseURL && domBaseURL.value) || viewState.addForm.values.baseURL || (selectedPlatform && selectedPlatform.baseURL) || '');
  const summaryTemplate = (selectedPlatform && selectedPlatform.summaryTemplate) || '已连接 · {baseURL}';
  const summary = summaryTemplate.replace('{baseURL}', baseURL);

  const newGroup = {
    id: groupId,
    name: groupName + '(' + groupId.slice(-GROUP_ID_SUFFIX_LENGTH) + ')',
    avatar: (selectedPlatform && selectedPlatform.avatar) || selectedDriver.avatar || '',
    driverId: selectedDriver.id,
    platformId: selectedPlatform ? selectedPlatform.id : '',
    credentialRef: 'local://' + (selectedPlatform ? selectedPlatform.id : selectedDriver.id) + '/' + groupId,
    summary: summary,
    lastUpdated: new Date().toISOString()
  };
  // 提交载荷：平台头像与摘要模板一并带给后端（群配置字段）
  // 模型目录：manual 且有有效行 → models.static；否则走自动拉取 models.endpoint
  const staticModels = collectStaticModels();
  const modelsPayload = staticModels.length
    ? { static: staticModels }
    : { endpoint: (selectedPlatform && selectedPlatform.modelsEndpoint) || '/models' };

  // 提交载荷按 docs/09「POST /_team/groups 请求体（冻结）」逐字段对齐：
  //   driver（不是 driverId）、baseURL 在顶层、summary 是 { template } 对象、auth 只放凭证。
  //   读侧（GET /_team/groups）仍用 driverId，两套命名不要混。
  const submitPayload = {
    name: groupName,
    driver: selectedDriver.id,
    baseURL: String(baseURL || '').trim(),
    auth: { apiKey: authValues.apiKey },
    models: modelsPayload,
    avatar: newGroup.avatar
  };
  if (summaryTemplate) {
    submitPayload.summary = { template: summaryTemplate };
  }

  viewState.addForm.submitting = true;
  const submitButton = document.querySelector('#btnSubmitGroup');
  if (submitButton) submitButton.disabled = true;

  // 提交后**以后端返回的群为准**：失败必须提示且不插入本地对象。
  // 曾经的写法是 .catch(function () { return null; }) 吞掉错误后再无条件 push，
  // 导致「界面显示 7 个群、config.json 里只有 2 个」的幽灵群，且重复点击会堆同名群。
  api.createGroup(submitPayload).then(function (created) {
    const savedGroup = created && created.group ? created.group : null;
    if (!savedGroup) {
      // 后端没返回群信息：视为失败，不做乐观插入
      viewState.addForm.submitting = false;
      toast('添加失败：服务端未返回群信息');
      store.render();
      return;
    }
    // 本地字段打底（platformId 等前端概念），后端字段覆盖（id / credentialRef 以服务端为准）。
    // summary 例外：POST 回显的是**写入形状** { template }，列表渲染要的是渲染后字符串，
    // 直接用会显示 [object Object]（刷新后由 GET 渲染成字符串才对得上）。
    const mergedGroup = Object.assign({}, newGroup, savedGroup);
    if (mergedGroup.summary && typeof mergedGroup.summary === 'object') mergedGroup.summary = summary;
    current.groups.push(mergedGroup);
    viewState.addForm = { platformId: selectedPlatform.id, name: '', values: {} };
    viewState.modelCatalog = { mode: 'auto', models: [], probe: { loading: false, error: '' } };
    viewState.addForm.submitting = false;
    toast('已添加群聊：' + selectedPlatform.name + ' · ' + groupName);
    store.render();
    switchView('list');
  }).catch(function (error) {
    // 失败路径：提示原因、保留表单、不插入、不跳转（标志必须复位，否则一次失败后再也提交不了）
    viewState.addForm.submitting = false;
    const reason = error && error.message ? error.message : '未知错误';
    toast('添加失败：' + reason);
    store.render();
  });
}

// 导出：把配置存成 .json 文件
function exportDatabase() {
  api.exportConfig().then(function (config) {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const blobUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = blobUrl;
    downloadLink.download = 'model-team-export.json';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, REVOKE_URL_DELAY_MS);
    toast('已导出 model-team-export.json');
  });
}

// 导入：读本地 JSON 文件 → api.importConfig 校验 → 弹层展示回执
function importDatabase() {
  const filePicker = document.createElement('input');
  filePicker.type = 'file';
  filePicker.accept = '.json,application/json';
  filePicker.id = 'teamImportPicker';
  filePicker.style.display = 'none';
  document.body.appendChild(filePicker);   // 游离节点在部分浏览器不弹文件框

  filePicker.addEventListener('change', function () {
    const selectedFile = filePicker.files && filePicker.files[0];
    if (!selectedFile) return;
    const fileReader = new FileReader();
    fileReader.onload = function () {
      let parsedConfig = null;
      try {
        parsedConfig = JSON.parse(String(fileReader.result));
      } catch (error) {
        showModal('导入失败', `<p class="modal-p">JSON 解析失败：${escapeHtml(error.message)}</p>`);
        filePicker.remove();
        return;
      }
      api.importConfig(parsedConfig).then(function (importResult) {
        const rowHtml = importResult.accepted.map(function (group) {
          return `<tr><td>${escapeHtml(group.id)}</td><td>${escapeHtml(group.name)}</td>`
            + `<td>${escapeHtml(group.driverId)}</td><td>${escapeHtml(group.credentialRef || '—')}</td></tr>`;
        }).join('');
        showModal('导入解析结果', `
          <p class="modal-p">文件名：<b>${escapeHtml(selectedFile.name)}</b> · 大小 ${selectedFile.size} 字节</p>
          <p class="modal-p">可导入 <b>${importResult.accepted.length}</b> 个平台账号，结构不合法 ${importResult.rejected.length} 条；阶段 1 只展示结果，不写入存储。</p>
          <table class="modal-table">
            <thead><tr><th>id</th><th>name</th><th>driverId</th><th>credentialRef</th></tr></thead>
            <tbody>${rowHtml || '<tr><td colspan="4">（无 groups 数据）</td></tr>'}</tbody>
          </table>`);
        filePicker.remove();
      });
    };
    fileReader.readAsText(selectedFile);
  });
  filePicker.click();
}
