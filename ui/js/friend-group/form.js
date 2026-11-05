// friend-group-form.js —— 好友分组表单的规则层：id 派生 / 校验 / 提交前归一化。
//
// 这一层全是纯函数（同输入 → 同输出）：不碰 document、不发请求、不读全局 state，
// 所以这些规则可以直接被 node 拿去跑用例，不用起浏览器。
//
// 校验条目与后端 src/gateway/friend-groups.js 的 normalizeFriendGroup 一一对应：
// 前端只是把同一套判据提前显示出来，绝不比后端更严——
// 否则会出现「界面不让存、接口其实能收」这种自相矛盾的体验。

// 分组 id 会进 URL 与会话目标，只允许安全字符并以字母/数字开头。
// 与后端 FRIEND_GROUP_ID_PATTERN 是同一条正则，改一处必须改另一处（有测试守着）。
const FRIEND_GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// 与后端 MAX_FRIEND_GROUP_ID_LENGTH 一致
const FRIEND_GROUP_ID_MAX_LENGTH = 64;

// 分组名是纯中文或纯符号时派生不出任何字母数字，用这个词兜底（后端要求 id 非空）
const FRIEND_GROUP_ID_FALLBACK = 'group';

// 撞名时最多试到 -99。再多说明命名已经失控，此时交给校验层报「id 已被占用」让人改名，
// 绝不返回一个已存在的 id —— 那会让 POST 的 upsert 语义静默覆盖掉别人的分组。
const FRIEND_GROUP_ID_MAX_SUFFIX = 99;

// 两种调度策略（与后端 STRATEGIES 同值）
const FRIEND_GROUP_STRATEGIES = ['round-robin', 'fallback'];

// 名字 → id 片段：小写 → 非字母数字转连字符 → 合并连续连字符 → 去首尾连字符。
// 派生规则只在这个函数里实现一遍，将来换成拼音或哈希只需要改这里。
function slugifyFriendGroupName(groupName) {
  return String(groupName == null ? '' : groupName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 派生一个不与已有 id 撞名的分组 id。
// 截断放在加后缀之前，是为了「超长名字 + 撞名」时依旧不超后端的长度上限。
function deriveFriendGroupId(groupName, existingIds) {
  const takenIds = new Set((existingIds || []).map(function (existingId) { return String(existingId); }));
  const slug = slugifyFriendGroupName(groupName).slice(0, FRIEND_GROUP_ID_MAX_LENGTH);
  const baseId = slug || FRIEND_GROUP_ID_FALLBACK;

  if (!takenIds.has(baseId)) return baseId;

  for (let suffix = 2; suffix <= FRIEND_GROUP_ID_MAX_SUFFIX; suffix += 1) {
    const suffixText = '-' + suffix;
    const head = baseId.slice(0, FRIEND_GROUP_ID_MAX_LENGTH - suffixText.length);
    const candidateId = head + suffixText;
    if (!takenIds.has(candidateId)) return candidateId;
  }

  return baseId;
}

// 成员唯一键：与后端去重口径一致（平台 + 模型，与顺序无关）
function friendGroupMemberKey(member) {
  const platformId = member && typeof member.platformId === 'string' ? member.platformId.trim() : '';
  const modelId = member && typeof member.modelId === 'string' ? member.modelId.trim() : '';
  return platformId + '::' + modelId;
}

// 分组 id 单独判一次：派生出来的 id 与手改过的 id 用同一套规则描述错误
function describeFriendGroupIdError(groupId, existingIds, mode) {
  const normalizedId = typeof groupId === 'string' ? groupId.trim() : '';
  if (!normalizedId) return '分组 id 不能为空';
  if (normalizedId.length > FRIEND_GROUP_ID_MAX_LENGTH) {
    return '分组 id 最长 ' + FRIEND_GROUP_ID_MAX_LENGTH + ' 个字符';
  }
  if (!FRIEND_GROUP_ID_PATTERN.test(normalizedId)) {
    return '分组 id 只能包含字母、数字、点、下划线、连字符，且以字母或数字开头';
  }
  // 编辑态用的是分组自己的原 id，不算冲突；只有新建才需要查占用
  const takenIds = (existingIds || []).map(function (existingId) { return String(existingId); });
  if (mode !== 'edit' && takenIds.indexOf(normalizedId) >= 0) {
    return '分组 id 已被占用：' + normalizedId;
  }
  return '';
}

// 表单校验：只报后端会拒绝的项，不新增规则。
// 返回 { ok, errors }，errors 的键就是出错字段名（name / id / strategy / members），
// 视图层按字段名把文案摆到对应输入框下面。
function validateFriendGroupForm(draft, options) {
  const settings = options || {};
  const mode = settings.mode === 'edit' ? 'edit' : 'create';
  const formDraft = draft || {};
  const errors = {};

  const name = typeof formDraft.name === 'string' ? formDraft.name.trim() : '';
  if (!name) errors.name = '分组名不能为空';

  const idError = describeFriendGroupIdError(formDraft.id, settings.existingIds, mode);
  if (idError) errors.id = idError;

  if (FRIEND_GROUP_STRATEGIES.indexOf(formDraft.strategy) < 0) {
    errors.strategy = '策略只能是轮询（round-robin）或故障转移（fallback）';
  }

  const members = Array.isArray(formDraft.members) ? formDraft.members : [];
  if (members.length === 0) {
    errors.members = '至少要有一个成员';
  } else {
    const brokenMemberIndex = members.findIndex(function (member) {
      return !(member && member.platformId && member.modelId);
    });
    if (brokenMemberIndex >= 0) {
      errors.members = '第 ' + (brokenMemberIndex + 1) + ' 个成员缺少平台或模型';
    }
  }

  return { ok: Object.keys(errors).length === 0, errors: errors };
}

// 提交前的归一化：去空白、成员按「平台::模型」去重且保留顺序（后端也这么去重）。
// 去重在这里做，是因为「同一成员配两遍」没有语义，留着只会让故障转移顺序看起来像有两条备份。
function normalizeFriendGroupDraft(draft) {
  const formDraft = draft || {};
  const seenMemberKeys = new Set();
  const members = [];

  (Array.isArray(formDraft.members) ? formDraft.members : []).forEach(function (member) {
    const platformId = member && typeof member.platformId === 'string' ? member.platformId.trim() : '';
    const modelId = member && typeof member.modelId === 'string' ? member.modelId.trim() : '';
    if (!platformId || !modelId) return;
    const memberKey = platformId + '::' + modelId;
    if (seenMemberKeys.has(memberKey)) return;
    seenMemberKeys.add(memberKey);
    members.push({ platformId: platformId, modelId: modelId });
  });

  return {
    id: typeof formDraft.id === 'string' ? formDraft.id.trim() : '',
    name: typeof formDraft.name === 'string' ? formDraft.name.trim() : '',
    strategy: formDraft.strategy,
    members: members,
  };
}

// 两个下拉框当前该选中谁：平台找不到就回落第一个群，模型找不到就回落第一个模型。
// 回落而不是留空，是为了「打开弹窗直接点添加」这条最短路径不会先报一次「没选模型」。
function resolveFriendGroupPicks(platformGroups, pickedPlatformId, pickedModelId, modelsByGroupId) {
  const groups = platformGroups || [];
  const platformGroup = groups.filter(function (group) {
    return group.id === pickedPlatformId;
  })[0] || groups[0] || null;
  const models = (platformGroup && modelsByGroupId && modelsByGroupId[platformGroup.id]) || [];
  const pickedModel = models.filter(function (model) {
    return model.id === pickedModelId;
  })[0] || models[0] || null;

  return {
    platformId: platformGroup ? platformGroup.id : '',
    modelId: pickedModel ? pickedModel.id : '',
    models: models,
  };
}
