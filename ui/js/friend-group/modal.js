// friend-group-modal.js —— 好友分组弹窗的接线层：取数、弹窗、保存/删除、失败呈现。
// 为什么单独一个分片而不是塞进 app.js：app.js 已到 379 代码行（门禁 400），
// 这层是纯副作用代码（DOM + 请求），塞进去必然破门禁；纯规则在 friend-group-form.js。
// 依赖（同作用域、后加载）：showModal / toast / renderApp 来自 app.js，store 是 app.js 的装配实例；
// 这里只在函数体里引用它们，模块加载期不求值，因此拼接顺序不会踩 TDZ。

// 弹窗现状：null = 没开。留着草稿是为了"添加成员/切换下拉/失败重画"都不丢已填内容
var friendGroupModal = null;
// 删除二次确认用行内按钮而不是 window.confirm：原生对话框在无头浏览器里会被自动吞掉，
// 既测不到"确认后真的删了"，也会把 409 的提示挡在对话框后面
var FRIEND_GROUP_MODAL_TITLE = { create: '新建好友分组', edit: '编辑好友分组' };

function friendGroupDeepCopyMembers(members) {
  return (Array.isArray(members) ? members : []).map(function (member) {
    return { platformId: member.platformId, modelId: member.modelId };
  });
}

function friendGroupExistingIds(exceptGroupId) {
  var current = store.getState();
  return current.friendGroups
    .map(function (friendGroup) { return friendGroup.id; })
    .filter(function (groupId) { return groupId !== exceptGroupId; });
}

// 平台群有动作才拉模型：只有"全部平台都还没有模型目录"时才发请求，避免每次开弹窗都打一遍接口
function ensureFriendGroupModels(platformGroups) {
  var missingGroups = platformGroups.filter(function (group) {
    return !friendGroupModal.draft.modelsByGroupId[group.id];
  });
  if (!missingGroups.length) return Promise.resolve();
  missingGroups.forEach(function (group) { friendGroupModal.draft.modelsStatus[group.id] = 'loading'; });
  return Promise.all(missingGroups.map(function (group) {
    return Promise.resolve(api.getGroupModels(group.id)).then(function (models) {
      friendGroupModal.draft.modelsByGroupId[group.id] = models || [];
      friendGroupModal.draft.modelsStatus[group.id] = 'loaded';
    }, function (loadError) {
      // 模型拉不到不该挡住"改名字/改策略"：标成 error 让下拉显示空态，失败原因照常上报
      friendGroupModal.draft.modelsByGroupId[group.id] = [];
      friendGroupModal.draft.modelsStatus[group.id] = 'error';
      reportApiFailure('friend-groups:models:' + group.id, 'load', loadError && loadError.message ? loadError.message : String(loadError));
    });
  }));
}

// 由「编辑中的原分组」造出初始草稿：新建时全都给空/缺省，
// 编辑时预填名字/策略/成员，并把两个下拉先指到第一个成员所在的平台与模型
function buildFriendGroupDraft(editingGroup, platformGroups) {
  var members = friendGroupDeepCopyMembers(editingGroup ? editingGroup.members : []);
  var firstMember = members.length ? members[0] : null;
  var firstPlatformGroup = platformGroups[0] || null;
  return {
    id: editingGroup ? editingGroup.id : '',
    name: editingGroup ? editingGroup.name : '',
    strategy: editingGroup ? editingGroup.strategy : 'round-robin',
    members: members,
    platformPick: firstMember ? firstMember.platformId : (firstPlatformGroup ? firstPlatformGroup.id : ''),
    modelPick: firstMember ? firstMember.modelId : '',
    modelsByGroupId: {},
    modelsStatus: {},
    errors: {},
    formError: ''
  };
}

// 打开弹窗：mode=create 新建 / edit 编辑（group 必须是 state.friendGroups 里的一项）
function openFriendGroupModal(mode, friendGroup) {
  // 先收掉上一份：连点两下「编辑」或上一个弹窗是用 × 关掉的时候，
  // 不先关就会在页面上叠出第二个遮罩，而 × 的处理器只认第一个 #modalClose。
  closeFriendGroupModal();
  var platformGroups = store.getState().groups || [];
  var editingGroup = mode === 'edit' ? friendGroup : null;
  friendGroupModal = {
    mode: editingGroup ? 'edit' : 'create',
    groupId: editingGroup ? editingGroup.id : '',
    platformGroups: platformGroups,
    deleteArmed: false,
    draft: buildFriendGroupDraft(editingGroup, platformGroups),
    mask: null
  };
  friendGroupModal.mask = showModal(FRIEND_GROUP_MODAL_TITLE[friendGroupModal.mode], '<div class="loading">正在准备表单…</div>');
  friendGroupModal.mask.addEventListener('click', onFriendGroupModalClick);
  friendGroupModal.mask.addEventListener('input', onFriendGroupModalInput);
  friendGroupModal.mask.addEventListener('change', onFriendGroupModalChange);
  // × 与点遮罩由 showModal 自己负责摘节点，这里只负责把模块状态一起清掉：
  // 否则下一次打开会以为"上一个弹窗还开着"，草稿与遮罩引用都对不上。
  var closeButton = friendGroupModal.mask.querySelector('.modal-close');
  if (closeButton) {
    closeButton.addEventListener('click', function () { friendGroupModal = null; });
  }
  ensureFriendGroupModels(platformGroups).then(function () { paintFriendGroupModal(); });
}

// 重画弹窗正文：只有它一处改 DOM，草稿与错误都在 friendGroupModal 里
function paintFriendGroupModal() {
  if (!friendGroupModal || !friendGroupModal.mask) return;
  var bodyHost = friendGroupModal.mask.querySelector('.modal-body');
  if (!bodyHost) return;
  var draft = friendGroupModal.draft;
  var strategySelect = bodyHost.querySelector('#friendGroupStrategy');
  // 策略/平台的选中值以草稿为准（重画前用户刚改过的值不能丢）
  if (strategySelect) draft.strategy = strategySelect.value || draft.strategy;
  bodyHost.innerHTML = renderFriendGroupForm({
    mode: friendGroupModal.mode,
    groups: friendGroupModal.platformGroups,
    modelsByGroupId: draft.modelsByGroupId,
    modelsStatus: draft.modelsStatus,
    draft: draft,
    errors: draft.errors,
    formError: draft.formError,
    deleteArmed: friendGroupModal.deleteArmed
  });
}

function closeFriendGroupModal() {
  if (friendGroupModal && friendGroupModal.mask) friendGroupModal.mask.remove();
  friendGroupModal = null;
}

function readFriendGroupDraftFromDom() {
  var bodyHost = friendGroupModal.mask.querySelector('.modal-body');
  var nameInput = bodyHost.querySelector('#friendGroupName');
  var strategySelect = bodyHost.querySelector('#friendGroupStrategy');
  if (nameInput) friendGroupModal.draft.name = nameInput.value;
  if (strategySelect) friendGroupModal.draft.strategy = strategySelect.value;
  return friendGroupModal.draft;
}

// 名字改动时实时刷新派生 id（新建态）：只改那两个输入框，不重画整表，否则输入框会失焦
function syncFriendGroupDerivedId() {
  if (!friendGroupModal || friendGroupModal.mode !== 'create') return;
  var bodyHost = friendGroupModal.mask.querySelector('.modal-body');
  var idInput = bodyHost.querySelector('#friendGroupId');
  var draft = readFriendGroupDraftFromDom();
  draft.id = deriveFriendGroupId(draft.name, friendGroupExistingIds(''));
  if (idInput) idInput.value = draft.id;
  draft.errors.name = '';
  draft.errors.id = '';
  var nameErrorNode = bodyHost.querySelector('[data-error-for="name"]');
  var idErrorNode = bodyHost.querySelector('[data-error-for="id"]');
  if (nameErrorNode) nameErrorNode.textContent = '';
  if (idErrorNode) idErrorNode.textContent = '';
}

function addFriendGroupMember() {
  var draft = friendGroupModal.draft;
  var bodyHost = friendGroupModal.mask.querySelector('.modal-body');
  var platformSelect = bodyHost.querySelector('#friendGroupPlatformPick');
  var modelSelect = bodyHost.querySelector('#friendGroupModelPick');
  var platformId = platformSelect ? platformSelect.value : '';
  var modelId = modelSelect ? modelSelect.value : '';
  if (!platformId || !modelId) {
    draft.errors = { members: '先选好平台与模型再添加（当前下拉没有可用模型）' };
    paintFriendGroupModal();
    return;
  }
  var memberKey = platformId + '::' + modelId;
  var alreadyAdded = draft.members.some(function (member) {
    return member.platformId + '::' + member.modelId === memberKey;
  });
  // 重复添加不报错（后端也是去重保序），只是不再加一遍，避免列表里出现两行一样的成员
  if (!alreadyAdded) draft.members.push({ platformId: platformId, modelId: modelId });
  draft.errors = {};
  draft.formError = '';
  paintFriendGroupModal();
}

function saveFriendGroupDraft() {
  var draft = readFriendGroupDraftFromDom();
  var normalizedDraft = normalizeFriendGroupDraft(draft);
  if (friendGroupModal.mode === 'create') {
    normalizedDraft.id = normalizedDraft.id || deriveFriendGroupId(normalizedDraft.name, friendGroupExistingIds(''));
  }
  var validation = validateFriendGroupForm(normalizedDraft, {
    existingIds: friendGroupExistingIds(friendGroupModal.groupId),
    mode: friendGroupModal.mode
  });
  draft.errors = validation.errors;
  draft.formError = '';
  if (!validation.ok) { paintFriendGroupModal(); return; }
  draft.id = normalizedDraft.id;
  // 保存期间按钮不做禁用态：同 id 覆盖是幂等的，重复点击不会造出第二个分组
  api.createFriendGroup(normalizedDraft).then(function () {
    closeFriendGroupModal();
    toast('分组已保存');
    return store.dispatch({ type: 'load-groups' });
  }).catch(function (saveError) {
    // 服务端 message 原文进弹窗（含「分组 id 不合法」「members 必须是非空数组」这类具体判据）
    draft.formError = '保存失败：' + (saveError && saveError.message ? saveError.message : String(saveError));
    paintFriendGroupModal();
  });
}

function deleteFriendGroupConfirmed() {
  var draft = friendGroupModal.draft;
  api.deleteFriendGroup(friendGroupModal.groupId).then(function () {
    closeFriendGroupModal();
    toast('分组已删除');
    return store.dispatch({ type: 'load-groups' });
  }).catch(function (deleteError) {
    // 409 的「分组 x 正被 N 个会话使用」必须原样显示：这是唯一告诉用户"为什么删不掉"的信息
    friendGroupModal.deleteArmed = false;
    draft.formError = '删除失败：' + (deleteError && deleteError.message ? deleteError.message : String(deleteError));
    paintFriendGroupModal();
  });
}

function onFriendGroupModalClick(event) {
  var clickedButton = event.target.closest('button');
  if (!clickedButton) return;
  var removeMemberButton = event.target.closest('[data-remove-member]');
  if (removeMemberButton) {
    friendGroupModal.draft.members.splice(Number(removeMemberButton.dataset.removeMember), 1);
    friendGroupModal.draft.errors = {};
    paintFriendGroupModal();
    return;
  }
  var buttonId = clickedButton.id;
  if (buttonId === 'btnSaveFriendGroup') saveFriendGroupDraft();
  else if (buttonId === 'btnAddFriendGroupMember') addFriendGroupMember();
  else if (buttonId === 'btnCancelFriendGroup') closeFriendGroupModal();
  else if (buttonId === 'btnDeleteFriendGroup') {
    friendGroupModal.deleteArmed = true;
    friendGroupModal.draft.formError = '';
    paintFriendGroupModal();
  } else if (buttonId === 'btnConfirmDeleteFriendGroup') deleteFriendGroupConfirmed();
}

function onFriendGroupModalInput(event) {
  if (event.target.id !== 'friendGroupName') return;
  syncFriendGroupDerivedId();
}

function onFriendGroupModalChange(event) {
  var target = event.target;
  if (target.id === 'friendGroupPlatformPick') {
    friendGroupModal.draft.platformPick = target.value;
    friendGroupModal.draft.modelPick = '';
    paintFriendGroupModal();
  } else if (target.id === 'friendGroupModelPick') {
    friendGroupModal.draft.modelPick = target.value;
  } else if (target.id === 'friendGroupStrategy') {
    // 策略决定成员行要不要标 [主]/[备]，必须重画一次
    friendGroupModal.draft.strategy = target.value;
    paintFriendGroupModal();
  }
}
