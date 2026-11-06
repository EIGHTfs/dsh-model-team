// admin.js —— 管理侧交互：加群提交、数据库导入导出。
// 导出取 api.exportConfig() 的结果触发下载；导入交给 api.importConfig() 校验后展示回执。

const REVOKE_URL_DELAY_MS = 1500;   // 下载触发后延迟回收 blob URL
const GROUP_ID_SUFFIX_LENGTH = 8;   // 新群名后面拼的 id 尾号长度

// 导入回执的表格与说明抽成纯函数：字段名（driver）与文案都被单测钉住，
// 否则这类"看起来能用、其实列恒空"的问题只能等用户导入一次才发现。
// 群对象的驱动字段是 driver（契约 §3.1：写入与读出同名，无映射层）。
function renderImportPreviewTable(acceptedGroups) {
  const rowHtml = (acceptedGroups || []).map(function (group) {
    return `<tr><td>${escapeHtml(group.id)}</td><td>${escapeHtml(group.name)}</td>`
      + `<td>${escapeHtml(group.driver)}</td><td>${escapeHtml(group.credentialRef || '—')}</td></tr>`;
  }).join('');
  return `<table class="modal-table">
            <thead><tr><th>id</th><th>name</th><th>driver</th><th>credentialRef</th></tr></thead>
            <tbody>${rowHtml || '<tr><td colspan="4">（无 groups 数据）</td></tr>'}</tbody>
          </table>`;
}

// 导入说明必须与真实行为一致：api.importConfig 走 merge upsert（会落盘），
// 旧文案「只展示结果、不写入存储」是 mock 时代残留，会让人以为导入不生效。
function buildImportResultNote(acceptedCount, rejectedCount) {
  return '可导入 ' + acceptedCount + ' 个平台账号，结构不合法 ' + rejectedCount
    + ' 条；合并写入（同名 upsert），不会删除已有群。';
}

// —— 加群表单的读取与组装 ——
// 拆成「读 DOM / 校验 / 组装 / 结果处理」几段纯函数，提交主流程只留编排：
// 以前这些都在 submitNewGroup 一个函数里，改任何一条取值优先级都要重读整段。

// 群名以 DOM 为准：预填值只写进了 input.value，不一定同步回 viewState
function readGroupNameFromDom() {
  const nameNode = document.querySelector('#groupNameInput');
  return String((nameNode && nameNode.value) || viewState.addForm.name || '').trim();
}

// 凭证字段按 data-auth-key 扫 DOM：键名由后端 authSchema 决定，前端不写死任何平台字段
function readAuthValuesFromDom() {
  const authValues = {};
  Array.prototype.slice.call(document.querySelectorAll('[data-auth-key]')).forEach(function (node) {
    authValues[node.dataset.authKey] = String(node.value || '').trim();
  });
  return authValues;
}

// 必填项缺失时返回中文标签（直接拼进 toast）；空数组表示可以提交
function findMissingRequiredLabels(selectedDriver, authValues) {
  return (selectedDriver.authSchema || []).filter(function (field) {
    return field.required && !authValues[field.key];
  }).map(function (field) { return field.label; });
}

// 群 id：mock- 前缀 + 时间戳的 36 进制。36 是进制基数（0-9a-z），不是长度/轮询阈值；
// 用 36 进制只为短一些，真正唯一性由后端保存时保证
function buildGroupId() {
  return 'mock-' + Date.now().toString(36);
}

// baseURL 取值优先级：DOM 输入 → viewState 预填 → 平台预置 → 空串（提交时再 trim）
function readBaseURLFromDom(selectedPlatform) {
  const domBaseURL = document.querySelector('[data-auth-key="baseURL"]');
  return String(
    (domBaseURL && domBaseURL.value)
    || viewState.addForm.values.baseURL
    || (selectedPlatform && selectedPlatform.baseURL)
    || ''
  );
}

// 摘要模板来自后端（{baseURL} 占位）；没有模板时用同一份默认串，保证摘要永远可渲染
function resolveSummaryTemplate(selectedPlatform) {
  return (selectedPlatform && selectedPlatform.summaryTemplate) || '已连接 · {baseURL}';
}

// 群草稿：前端概念字段先铺好，后端返回的 savedGroup 随后覆盖（id/credentialRef 以服务端为准）
function buildNewGroupDraft(options) {
  const selectedPlatform = options.selectedPlatform;
  const selectedDriver = options.selectedDriver;
  const groupId = options.groupId;
  return {
    id: groupId,
    name: options.groupName + '(' + groupId.slice(-GROUP_ID_SUFFIX_LENGTH) + ')',
    avatar: (selectedPlatform && selectedPlatform.avatar) || selectedDriver.avatar || '',
    // 不要在这里放 driverId：契约 §3.1 群的驱动字段只有 driver，后端返回的 savedGroup 会覆盖，
    // 留一个没人读的同义字段只会让后来人以为"前端驱动 id 叫 driverId"（F-09 那类错误的温床）。
    platformId: selectedPlatform ? selectedPlatform.id : '',
    credentialRef: 'local://' + (selectedPlatform ? selectedPlatform.id : selectedDriver.id) + '/' + groupId,
    summary: options.summaryTemplate.replace('{baseURL}', options.baseURL),
    lastUpdated: new Date().toISOString()
  };
}

// 模型目录：manual 且有有效行 → models.static；否则走自动拉取 models.endpoint
function buildModelsPayload(selectedPlatform) {
  const staticModels = collectStaticModels();
  if (staticModels.length) return { static: staticModels };
  return { endpoint: (selectedPlatform && selectedPlatform.modelsEndpoint) || '/models' };
}

// 提交载荷按 docs/09「POST /_team/groups 请求体（冻结）」逐字段对齐：
//   driver（不是 driverId）、baseURL 在顶层、summary 是 { template } 对象、auth 只放凭证。
//   读侧（GET /_team/groups）的驱动字段同样叫 driver（契约 §3.1 同名透传，无映射层）。
function buildGroupSubmitPayload(options) {
  const submitPayload = {
    name: options.groupName,
    driver: options.selectedDriver.id,
    baseURL: String(options.baseURL || '').trim(),
    auth: { apiKey: options.authValues.apiKey },
    models: options.modelsPayload,
    avatar: options.newGroup.avatar
  };
  if (options.summaryTemplate) {
    submitPayload.summary = { template: options.summaryTemplate };
  }
  return submitPayload;
}

// 提交成功：以后端返回的群为准；没返回群信息按失败处理（不做乐观插入）
function applyCreatedGroup(created, context) {
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
  const mergedGroup = Object.assign({}, context.newGroup, savedGroup);
  if (mergedGroup.summary && typeof mergedGroup.summary === 'object') mergedGroup.summary = context.newGroup.summary;
  context.currentState.groups.push(mergedGroup);
  viewState.addForm = { platformId: context.selectedPlatform.id, name: '', values: {} };
  viewState.modelCatalog = { mode: 'auto', models: [], probe: { loading: false, error: '' } };
  viewState.addForm.submitting = false;
  toast('已添加群聊：' + context.selectedPlatform.name + ' · ' + context.groupName);
  store.render();
  switchView('list');
}

// 提交失败：提示原因、保留表单、不插入、不跳转（标志必须复位，否则一次失败后再也提交不了）
function handleSubmitFailure(error) {
  viewState.addForm.submitting = false;
  const reason = error && error.message ? error.message : '未知错误';
  toast('添加失败：' + reason);
  store.render();
}

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

  // 名称/凭证/baseURL 都以 DOM 实际值为准（各自的取值优先级见对应读取函数）
  const groupName = readGroupNameFromDom();
  if (!groupName) { toast('请填写群名称'); return; }

  const authValues = readAuthValuesFromDom();
  const missingLabels = findMissingRequiredLabels(selectedDriver, authValues);
  if (missingLabels.length) { toast('请填写必填项：' + missingLabels.join('、')); return; }

  const groupId = buildGroupId();
  const baseURL = readBaseURLFromDom(selectedPlatform);
  // 摘要按平台模板渲染（{baseURL} 占位），模板也来自后端
  const summaryTemplate = resolveSummaryTemplate(selectedPlatform);
  const newGroup = buildNewGroupDraft({
    groupId: groupId,
    groupName: groupName,
    selectedPlatform: selectedPlatform,
    selectedDriver: selectedDriver,
    baseURL: baseURL,
    summaryTemplate: summaryTemplate
  });
  // 提交载荷：平台头像与摘要模板一并带给后端（群配置字段）
  const modelsPayload = buildModelsPayload(selectedPlatform);

  const submitPayload = buildGroupSubmitPayload({
    groupName: groupName,
    selectedDriver: selectedDriver,
    baseURL: baseURL,
    authValues: authValues,
    modelsPayload: modelsPayload,
    newGroup: newGroup,
    summaryTemplate: summaryTemplate
  });

  viewState.addForm.submitting = true;
  const submitButton = document.querySelector('#btnSubmitGroup');
  if (submitButton) submitButton.disabled = true;

  // 提交后**以后端返回的群为准**：失败必须提示且不插入本地对象。
  // 曾经的写法是 .catch(function () { return null; }) 吞掉错误后再无条件 push，
  // 导致「界面显示 7 个群、config.json 里只有 2 个」的幽灵群，且重复点击会堆同名群。
  api.createGroup(submitPayload).then(function (created) {
    applyCreatedGroup(created, {
      currentState: current,
      newGroup: newGroup,
      selectedPlatform: selectedPlatform,
      groupName: groupName
    });
  }).catch(handleSubmitFailure);
}

// 备份文件名带时间戳：两份备份落在同一个下载目录时不会互相覆盖
function buildBackupFileName(now) {
  const datePart = String(now.getFullYear())
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0');
  const timePart = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
  return 'dsh-model-team-' + datePart + '-' + timePart + '.json';
}

// 导出：把完整备份（配置 + 凭据本体）存成 .json 文件
function exportDatabase() {
  api.exportConfig().then(function (backup) {
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const blobUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = blobUrl;
    downloadLink.download = buildBackupFileName(new Date());
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, REVOKE_URL_DELAY_MS);
    // 这句话必须显眼：备份里的凭证是明文，谁拿到文件谁就有 Key
    toast('已导出 ' + downloadLink.download + '（此文件含密钥，请妥善保管）');
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
      // 确认前先报清楚"将恢复多少个群、多少个凭据文件"：写盘动作不可撤销，不能点一下就开始
      const incomingGroupCount = Array.isArray(parsedConfig.groups) ? parsedConfig.groups.length : 0;
      const incomingCredentialCount = parsedConfig.credentialFiles && typeof parsedConfig.credentialFiles === 'object'
        ? Object.keys(parsedConfig.credentialFiles).length
        : 0;
      const confirmModal = showModal('导入备份', `
        <p class="modal-p">文件名：<b>${escapeHtml(selectedFile.name)}</b> · 大小 ${selectedFile.size} 字节</p>
        <p class="modal-p">将恢复 <b>${incomingGroupCount}</b> 个群 + <b>${incomingCredentialCount}</b> 个凭据文件。</p>
        <p class="modal-p">凭据文件以 0600 权限写入数据根；同名文件会先备份为 <code>.bak-&lt;时间戳&gt;</code>。</p>
        <button type="button" class="btn-primary" id="btnConfirmImport">确认导入</button>`);
      const confirmButton = confirmModal.querySelector('#btnConfirmImport');
      confirmButton.addEventListener('click', function () {
        confirmModal.remove();
        api.importConfig(parsedConfig).then(function (importResult) {
          const restoredFiles = Array.isArray(importResult.restoredCredentialFiles) ? importResult.restoredCredentialFiles : [];
          const restoredList = restoredFiles.length
            ? `<p class="modal-p">已写入凭据文件：${restoredFiles.map(function (item) {
              return '<b>' + escapeHtml(item.path) + '</b>';
            }).join('、')}</p>`
            : '';
          const skippedList = Array.isArray(importResult.skippedRefs) && importResult.skippedRefs.length
            ? `<p class="modal-p">跳过：${importResult.skippedRefs.map(function (item) {
              return escapeHtml(item.path) + '（' + escapeHtml(item.reason) + '）';
            }).join('、')}</p>`
            : '';
          showModal('导入结果', `
            <p class="modal-p">${escapeHtml(buildImportResultNote(importResult.accepted.length, importResult.rejected.length))}</p>
            ${restoredList}
            ${skippedList}
            ${renderImportPreviewTable(importResult.accepted)}`);
          filePicker.remove();
        });
      });
    };
    fileReader.readAsText(selectedFile);
  });
  filePicker.click();
}
