// friend-group-view.js —— 好友分组表单的视图层：只把草稿画成 HTML 字符串。
//
// 与 friend-group-form.js 的分工：那边管「id 怎么派生、哪些字段不合格」，
// 这边只管「把已经算好的结果摆到页面上」。两个职责混在一个文件里会让人
// 改样式时误碰校验规则，所以拆开——不是为压行数。
//
// 全部是纯函数：输入草稿 + 目录数据，输出 HTML 字符串；不碰 document、不绑事件。
// 事件与请求在 friend-group-modal.js。
//
// 复用现有 class 命名（.field / .field-label / .contact-member / .btn-primary …）：
// 通讯录视图长什么样，编辑弹窗里的成员行就长什么样，避免出现第二套视觉语言。

const FRIEND_GROUP_MEMBER_EMPTY_TEXT = '(还没有添加成员)';
const FRIEND_GROUP_MODEL_LOADING_TEXT = '(模型加载中…)';
const FRIEND_GROUP_MODEL_EMPTY_TEXT = '(该群没有可用模型)';

// 平台下拉：数据源是 state.groups（平台账号群），一个群就是一个可选平台。
// 一个群都没有时给出明确指引，而不是渲染一个空下拉让人以为坏了。
function renderFriendGroupPlatformOptions(platformGroups, pickedPlatformId) {
  if (!platformGroups.length) {
    return '<option value="">(还没有平台群，先去「加群」)</option>';
  }
  return platformGroups.map(function (group) {
    const selected = group.id === pickedPlatformId ? ' selected' : '';
    const label = group.name || group.id;
    return '<option value="' + escapeHtml(group.id) + '"' + selected + '>' + escapeHtml(label) + '</option>';
  }).join('');
}

// 模型下拉：loading / 空 / 有数据三种状态分开说。
// 「加载中」与「确实没有模型」长得一样时，人会以为是插件坏了，所以文案必须分开。
function renderFriendGroupModelOptions(models, pickedModelId, modelsStatus) {
  if (modelsStatus === 'loading') {
    return '<option value="">' + FRIEND_GROUP_MODEL_LOADING_TEXT + '</option>';
  }
  if (!models.length) {
    return '<option value="">' + FRIEND_GROUP_MODEL_EMPTY_TEXT + '</option>';
  }
  return models.map(function (model) {
    const selected = model.id === pickedModelId ? ' selected' : '';
    const label = model.name || model.id;
    return '<option value="' + escapeHtml(model.id) + '"' + selected + '>' + escapeHtml(label) + '</option>';
  }).join('');
}

// 单个成员行。故意沿用通讯录的 .contact-member 结构：
//   ├─ 模型名 (来自 平台名) [主]/[备] [ 移除 ]
// fallback 组按数组顺序标主/备——顺序就是故障转移的先后；
// 本轮没有做上移/下移控件，改顺序的办法是移除后重新添加（交付说明里已声明）。
function renderFriendGroupMemberRow(member, memberIndex, memberTotal, platformNameById, isFallback) {
  const isLastMember = memberIndex === memberTotal - 1;
  const branch = isLastMember ? '└─' : '├─';
  const platformName = platformNameById[member.platformId] || member.platformId;

  let roleTag = '';
  if (isFallback) {
    roleTag = memberIndex === 0
      ? '<span class="contact-role contact-role-main">[主]</span>'
      : '<span class="contact-role">[备]</span>';
  }

  return '<div class="contact-member">'
    + '<span class="contact-branch">' + branch + '</span>'
    + '<span class="contact-member-model">' + escapeHtml(member.modelId) + '</span>'
    + '<span class="contact-member-from">(来自 ' + escapeHtml(platformName) + ')</span>'
    + roleTag
    + '<button class="fg-remove" type="button" data-remove-member="' + memberIndex + '">[ 移除 ]</button>'
    + '</div>';
}

function renderFriendGroupMemberRows(members, platformGroups, strategy) {
  if (!members.length) {
    return '<div class="contacts-empty">' + FRIEND_GROUP_MEMBER_EMPTY_TEXT + '</div>';
  }

  const platformNameById = {};
  (platformGroups || []).forEach(function (group) {
    platformNameById[group.id] = group.name || group.id;
  });

  const isFallback = strategy === 'fallback';
  return members.map(function (member, memberIndex) {
    return renderFriendGroupMemberRow(member, memberIndex, members.length, platformNameById, isFallback);
  }).join('');
}

// 字段级错误位：始终渲染这个节点（哪怕是空串），
// 输入时只改它的 textContent 就能清掉红字，不用为了一句提示重画整个表单。
function renderFriendGroupFieldError(errors, fieldName) {
  const message = (errors || {})[fieldName] || '';
  return '<div class="fg-error" data-error-for="' + fieldName + '">' + escapeHtml(message) + '</div>';
}

// 策略下拉：中文名复用 render.js 的 STRATEGY_LABELS（与通讯录视图同一份，不复制第三份）
function renderFriendGroupStrategyOptions(strategy) {
  return FRIEND_GROUP_STRATEGIES.map(function (value) {
    const selected = value === strategy ? ' selected' : '';
    return '<option value="' + value + '"' + selected + '>' + escapeHtml(STRATEGY_LABELS[value] || value) + '</option>';
  }).join('');
}

// 删除按钮：编辑态才有。第一次点只是进入二次确认（行内按钮，不用 window.confirm —
// 原生对话框在无头浏览器里会被自动吞掉，也会把 409 的提示挡在对话框后面）。
function renderFriendGroupDeleteButton(mode, deleteArmed) {
  if (mode !== 'edit') return '';
  if (deleteArmed) {
    return '<button class="btn-danger" id="btnConfirmDeleteFriendGroup" type="button">[ 确认删除 ]</button>';
  }
  return '<button class="btn-ghost" id="btnDeleteFriendGroup" type="button">[ 删除分组 ]</button>';
}

// 三个单行输入/下拉字段：各自一个函数，改某个字段的文案或校验位置时不必读整张表单
function renderFriendGroupNameField(draft, errors) {
  return '<div class="field">'
    + '<label class="field-label" for="friendGroupName">分组名<span class="req-mark">*</span></label>'
    + '<input id="friendGroupName" type="text" placeholder="例如：主力轮询组" value="' + escapeHtml(draft.name || '') + '">'
    + renderFriendGroupFieldError(errors, 'name')
    + '</div>';
}

function renderFriendGroupIdField(draft, errors, mode) {
  const idReadonly = mode === 'edit' ? ' readonly' : '';
  return '<div class="field">'
    + '<label class="field-label" for="friendGroupId">分组 id（自动生成）</label>'
    + '<input id="friendGroupId" type="text" value="' + escapeHtml(draft.id || '') + '"' + idReadonly + '>'
    + renderFriendGroupFieldError(errors, 'id')
    + '</div>';
}

function renderFriendGroupStrategyField(strategy, errors) {
  return '<div class="field">'
    + '<label class="field-label" for="friendGroupStrategy">调度策略</label>'
    + '<select class="field-select" id="friendGroupStrategy">' + renderFriendGroupStrategyOptions(strategy) + '</select>'
    + renderFriendGroupFieldError(errors, 'strategy')
    + '</div>';
}

// 成员选择器：平台下拉 → 模型下拉 → 添加按钮，三者同排
function renderFriendGroupPickerField(platformGroups, picks, pickedModelsStatus, errors) {
  return '<div class="field">'
    + '<label class="field-label">添加成员</label>'
    + '<div class="fg-picker">'
    + '<select class="field-select" id="friendGroupPlatformPick">'
    + renderFriendGroupPlatformOptions(platformGroups, picks.platformId)
    + '</select>'
    + '<select class="field-select" id="friendGroupModelPick">'
    + renderFriendGroupModelOptions(picks.models, picks.modelId, pickedModelsStatus)
    + '</select>'
    + '<button class="btn-ghost" id="btnAddFriendGroupMember" type="button">[ + 添加成员 ]</button>'
    + '</div>'
    + renderFriendGroupFieldError(errors, 'members')
    + '</div>';
}

function renderFriendGroupMembersField(members, platformGroups, strategy) {
  return '<div class="field">'
    + '<label class="field-label">成员（' + members.length + ' 个）</label>'
    + '<div class="contact-members">' + renderFriendGroupMemberRows(members, platformGroups, strategy) + '</div>'
    + '</div>';
}

// 弹窗正文。
// options：mode（create/edit）、groups（平台群）、modelsByGroupId / modelsStatus（模型目录）、
//          draft（名字 / 策略 / 已选成员 / 两个下拉的选择）、errors（前端校验结果）、
//          formError（服务端返回的原文，原样显示不加工）、deleteArmed（是否已进入删除确认）。
function renderFriendGroupForm(options) {
  const settings = options || {};
  const mode = settings.mode === 'edit' ? 'edit' : 'create';
  const platformGroups = settings.groups || [];
  const draft = settings.draft || {};
  const errors = settings.errors || {};
  const members = Array.isArray(draft.members) ? draft.members : [];
  const strategy = FRIEND_GROUP_STRATEGIES.indexOf(draft.strategy) >= 0
    ? draft.strategy
    : FRIEND_GROUP_STRATEGIES[0];

  const picks = resolveFriendGroupPicks(platformGroups, draft.platformPick, draft.modelPick, settings.modelsByGroupId);
  const pickedModelsStatus = settings.modelsStatus ? settings.modelsStatus[picks.platformId] : '';
  const formErrorHtml = settings.formError
    ? '<div class="fg-form-error" data-error-for="form">' + escapeHtml(settings.formError) + '</div>'
    : '';

  return '<form class="friend-group-form" id="friendGroupForm" autocomplete="off">'
    + renderFriendGroupNameField(draft, errors)
    + renderFriendGroupIdField(draft, errors, mode)
    + renderFriendGroupStrategyField(strategy, errors)
    + renderFriendGroupPickerField(platformGroups, picks, pickedModelsStatus, errors)
    + renderFriendGroupMembersField(members, platformGroups, strategy)
    + formErrorHtml
    + '<div class="fg-actions">'
    + '<button class="btn-primary" id="btnSaveFriendGroup" type="button">保存</button>'
    + renderFriendGroupDeleteButton(mode, settings.deleteArmed)
    + '<button class="btn-ghost" id="btnCancelFriendGroup" type="button">取消</button>'
    + '</div>'
    + '</form>';
}
