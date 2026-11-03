// render.js —— 纯渲染层：把数据变成 DOM 字符串，不读写全局状态、不绑事件。
// 所有插值过 escapeHtml()，防止数据里的尖括号破坏结构；请求行的 title 直接用后端给的 row.title。

const STATUS_OK_MIN = 200;          // 2xx 视为成功
const STATUS_OK_MAX = 299;
const STATUS_RATE_LIMITED = 429;    // 限流，单独用一种颜色

// HTML 转义，属性值与文本节点共用
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 状态码 → 颜色语义
function statusClass(status) {
  if (status >= STATUS_OK_MIN && status <= STATUS_OK_MAX) return 'st-ok';
  if (status === STATUS_RATE_LIMITED) return 'st-warn';
  return 'st-err';
}

// 单条请求记录气泡：折叠时单行摘要，展开时补明细（account 只出现在 title 里）
// platform：本次真正接活的平台 { avatar, name }（分组轮换时必须能看出是谁响应的）
function requestRow(row, index, isExpanded, platform) {
  const platformAvatar = platform ? platform.avatar : '[G]';
  const platformName = platform ? platform.name : '';
  const modelName = String(row.model || '').replace(/^global:/, '');
  const detailHtml = isExpanded
    ? `<div class="req-detail">
         <span class="k">状态</span><span class="v">${escapeHtml(row.status)} ${escapeHtml(row.statusText)}</span>
         <span class="k">模型</span><span class="v">${escapeHtml(row.model)}</span>
         <span class="k">来源 IP</span><span class="v">${escapeHtml(row.ip)}</span>
         <span class="k">User-Agent</span><span class="v">${escapeHtml(row.ua)}</span>
         <span class="k">耗时</span><span class="v">${escapeHtml(row.latency)}</span>
         <span class="k">token</span><span class="v">${escapeHtml(row.tokens)}</span>
         <span class="k">credit</span><span class="v">${escapeHtml(row.credit)}</span>
         <span class="k">命中率</span><span class="v">${escapeHtml(row.cacheHit)}</span>
         <span class="k">req-id</span><span class="v">${escapeHtml(row.requestId)}</span>
       </div>`
    : '';

  return `<div class="msg msg-left">
    <span class="avatar" data-mention="${escapeHtml(modelName)}" title="点击插入 @${escapeHtml(modelName)}">${renderAvatar(platformAvatar, platformName || modelName)}</span>
    <div class="bubble req-bubble${isExpanded ? ' expanded' : ''}" data-row-index="${index}"
         tabindex="0" role="button" aria-expanded="${isExpanded ? 'true' : 'false'}"
         title="${escapeHtml(row.title)}">
      <div class="req-head">
        <span class="req-model">${escapeHtml(modelName)}</span>
        ${renderTargetSourceBadge(row.targetSource)}
        <span class="req-time">${escapeHtml(row.time)}</span>
        <span class="req-caret" aria-hidden="true"></span>
      </div>
      <div class="req-meta">
        <span class="st ${statusClass(row.status)}">${escapeHtml(row.status)} ${escapeHtml(row.statusText)}</span>
        <span>${escapeHtml(row.latency)}</span><span class="sep">·</span>
        <span>${escapeHtml(row.tokens)} tok</span><span class="sep">·</span>
        <span>${escapeHtml(row.credit)} credit</span><span class="sep">·</span>
        <span>命中 ${escapeHtml(row.cacheHit)}</span>
      </div>
      ${platformName ? `<div class="req-served">本次请求由 ${escapeHtml(platformAvatar)} ${escapeHtml(platformName)}(${escapeHtml(modelName)}) 响应</div>` : ''}
      ${detailHtml}
    </div>
  </div>`;
}

// 球内目标标记（G6）：有 URL 头像就只显示图、不显示任何文字；没有头像就用平台首字母圆牌。
// 为什么不另写一套首字母规则：renderAvatar 已经封装了「URL 判定 + 首字母 + 转义」，
// 复制一份必然在"空名/小写/非 URL"这些边界上漂移。
function renderFloatTargetMarkup(platform) {
  const avatarText = platform && platform.avatar;
  const platformName = platform && platform.name;
  const renderedAvatar = renderAvatar(avatarText, platformName);
  if (renderedAvatar.indexOf('<img') === 0) return renderedAvatar;
  return '<span class="fb-initial">' + renderedAvatar + '</span>';
}

// 群列表时间：当天 HH:mm、昨天显示「昨天」、更早 MM-DD；lastUpdated 缺失/非法 → 空
function formatGroupTime(isoText) {
  if (!isoText) return '';
  const when = new Date(isoText);
  if (isNaN(when.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const stamp = when.getTime();
  if (stamp >= startOfToday) {
    const hours = String(when.getHours()).padStart(2, '0');
    const minutes = String(when.getMinutes()).padStart(2, '0');
    return hours + ':' + minutes;
  }
  if (stamp >= startOfYesterday) return '昨天';
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return month + '-' + day;
}

// 头像渲染：http(s) / data: URL 用 <img>，其余按文本占位（空则用名称首字母）。
// 图片 404 等加载失败由 app.js 的全局 error 捕获降级为文本，不会留下破图。
function renderAvatar(avatarText, fallbackName) {
  const rawValue = String(avatarText == null ? '' : avatarText).trim();
  const isImageUrl = /^https?:\/\//i.test(rawValue) || /^data:/i.test(rawValue);
  const initial = String(fallbackName == null ? '' : fallbackName).trim().charAt(0).toUpperCase() || '?';
  if (isImageUrl) {
    return `<img class="avatar-img" src="${escapeHtml(rawValue)}" alt="" loading="lazy" data-fallback="${escapeHtml(initial)}">`;
  }
  return escapeHtml(rawValue || initial);
}

// 视图一：群列表（= 平台账号列表）：顶部搜索 +「我」入口，每项右侧 lastUpdated 本地化时间
function renderGroupList(groups, currentGroupId, filterText) {
  const itemsHtml = groups.map(function (group) {
    const timeText = formatGroupTime(group.lastUpdated);
    return `<li class="group-item${group.id === currentGroupId ? ' active' : ''}" data-group-id="${escapeHtml(group.id)}" tabindex="0">
      <span class="avatar">${renderAvatar(group.avatar, group.name)}</span>
      <div class="group-main">
        <div class="group-line"><span class="group-name">${escapeHtml(group.name)}</span></div>
        <div class="group-summary">${escapeHtml(group.summary)}</div>
      </div>
      <div class="group-right">
        ${timeText ? `<span class="group-time">${escapeHtml(timeText)}</span>` : ''}
        <span class="group-driver">${escapeHtml(group.driverId)}</span>
      </div>
    </li>`;
  }).join('');

  return `<section class="view view-list">
    <div class="list-head">
      <h2>消息</h2>
      <input class="group-search" id="groupSearch" type="search" autocomplete="off"
             placeholder="🔍 搜索群聊 (账号)" value="${escapeHtml(filterText || '')}">
      <span class="list-count">${groups.length} 个群 · 每个群 = 一个平台账号</span>
      <button class="btn-add" id="btnAddGroup" type="button">＋ 加群</button>
    </div>
    <ul class="group-list" id="groupList">${itemsHtml}</ul>
  </section>`;
}

// 视图二：群聊（sys 系统提示 / row 请求记录 / mine 我发出的 @）
// platform：当前群对应的平台信息，用于把请求行标成「[W] WorkBuddy(model)」
function renderChat(group, models, messages, platform) {
  const streamHtml = messages.map(function (message) {
    const timeHtml = message.time ? `<span class="msg-time">${escapeHtml(message.time)}</span>` : '';
    if (message.type === 'sys') {
      return `<div class="msg msg-sys"><span class="sys-tip">[系统] ${escapeHtml(message.text)}</span>${timeHtml}</div>`;
    }
    if (message.type === 'row') return requestRow(message.row, message.rowIndex, Boolean(message.expanded), platform);
    const bodyHtml = escapeHtml(message.text).replace(/(@[^\s<]+)/g, '<span class="mention-inline">$1</span>');
    return `<div class="msg msg-right">
      <span class="avatar round">[我]</span>
      <div class="bubble">${bodyHtml}${timeHtml}</div>
    </div>`;
  }).join('');

  return `<section class="view view-chat">
    <header class="view-head chat-head">
      <button class="btn-back" id="btnChatBack" type="button">&lt; 返回</button>
      <span class="head-title">${escapeHtml(group.name)}</span>
      <span class="group-tag">[群友: ${models.length}]</span>
      <span class="head-sub">群友 = 模型 · 消息 = 请求记录</span>
    </header>
    <div class="chat-stream" id="chatStream">${streamHtml}</div>
    <footer class="chat-input">
      <button class="btn-at" id="btnAt" type="button" title="选择群友或分组">@</button>
      <textarea id="msgInput" rows="1" autocomplete="off"
                placeholder="@ 选择群友或分组…"></textarea>
      <button class="btn-send" id="btnSend" type="button">发送</button>
      <div class="at-pop hidden" id="atPop">
        <div class="at-pop-title">选择群友（单模型）或好友分组（轮换组）—— 发送后切换当前目标</div>
        <div id="atList"></div>
      </div>
    </footer>
  </section>`;
}

// 选择器分组标题（本群群友 / 我的好友分组）
function renderAtSection(title) {
  return `<div class="at-section">${escapeHtml(title)}</div>`;
}

// 上下文窗口的展示口径：未知一律 —（契约 02 §3.7：缺失不填，不许编造）
function formatContextLength(contextLength) {
  const numericValue = typeof contextLength === 'number' ? contextLength : Number(contextLength);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return '—';
  if (numericValue >= 1000000) return (numericValue / 1000000).toFixed(numericValue % 1000000 === 0 ? 0 : 1) + 'M';
  if (numericValue >= 1000) return Math.round(numericValue / 1000) + 'K';
  return String(numericValue);
}

// @ 选择器：单个模型项（本群群友）；display 带来源平台，label 是纯模型名
// 窗口来自 models.static[].contextLength 或探测结果（docs/07 §二点六），未知显示 — 而不是省略
function renderAtModelItem(item, index) {
  return `<div class="at-item" data-at-type="model" data-at-id="${escapeHtml(item.id)}" data-index="${index}">
    <span class="avatar at-avatar">${escapeHtml(item.avatar || '[M]')}</span>
    <span class="at-model">${escapeHtml(item.display || item.label)}</span>
    <span class="at-tag">窗口 ${escapeHtml(formatContextLength(item.contextLength))}</span>
  </div>`;
}

// @ 选择器：单个分组项（跨平台轮换组）
function renderAtGroupItem(item, index) {
  return `<div class="at-item" data-at-type="group" data-at-id="${escapeHtml(item.id)}" data-index="${index}">
    <span class="avatar at-avatar at-avatar-group">👥</span>
    <span class="at-model">${escapeHtml(item.label)}</span>
    <span class="at-tag">(${item.memberCount}个平台成员)</span>
  </div>`;
}

// 视图五：通讯录（好友分组管理）
const STRATEGY_LABELS = { 'round-robin': '轮询', fallback: '故障转移' };

function renderAddressBook(friendGroups, groups, drivers) {
  const groupNameById = {};
  groups.forEach(function (group) { groupNameById[group.id] = group.name; });
  const driverById = {};
  (drivers || []).forEach(function (driver) { driverById[driver.id] = driver; });

  const itemsHtml = friendGroups.map(function (friendGroup) {
    const isFallback = friendGroup.strategy === 'fallback';
    const membersHtml = friendGroup.members.map(function (member, memberIndex) {
      const driver = driverById[member.platformId];
      // 平台显示名取短名（CodeArts (华为云) → CodeArts），与界面稿的 "(来自 CodeArts)" 对齐
      const driverName = driver ? String(driver.name).split(' (')[0] : (groupNameById[member.platformId] || member.platformId);
      const driverAvatar = member.platformAvatar || (driver ? driver.avatar : '[?]');
      const branch = memberIndex === friendGroup.members.length - 1 ? '└─' : '├─';
      // fallback 组按数组顺序标主/备：第一个是主，其余是备
      let roleTag = '';
      if (isFallback) roleTag = memberIndex === 0 ? '<span class="contact-role contact-role-main">[主]</span>' : '<span class="contact-role">[备]</span>';
      return `<div class="contact-member">
        <span class="contact-branch">${branch}</span>
        <span class="avatar">${escapeHtml(driverAvatar)}</span>
        <span class="contact-member-model">${escapeHtml(member.modelId)}</span>
        <span class="contact-member-from">(来自 ${escapeHtml(driverName)})</span>
        ${roleTag}
      </div>`;
    }).join('');
    return `<div class="contact-row">
      <div class="contact-head">
        <span class="avatar at-avatar-group">👥</span>
        <span class="contact-name">${escapeHtml(friendGroup.name)}</span>
        <span class="contact-strategy">(${escapeHtml(STRATEGY_LABELS[friendGroup.strategy] || friendGroup.strategy)})</span>
        <button class="contact-edit" type="button" data-edit-group="${escapeHtml(friendGroup.id)}">[ 编辑 ]</button>
      </div>
      <div class="contact-members">${membersHtml}</div>
    </div>`;
  }).join('');

  return `<section class="view view-contacts">
    <header class="view-head">
      <button class="btn-back" id="btnContactsBack" type="button">&lt; 返回</button>
      <span class="head-title">通讯录 - 好友分组管理</span>
    </header>
    <div class="contacts-body">
      <div class="contacts-label">我的分组：</div>
      <div class="contact-list">${itemsHtml || '<div class="contacts-empty">还没有分组</div>'}</div>
    </div>
    <div class="contacts-foot">
      <button class="btn-primary" id="btnCreateGroup" type="button">[ + 新建分组 ]</button>
    </div>
  </section>`;
}

// 条件显示：字段声明里的 showWhen 指到某个依赖字段的取值，取到才出现（如 manual 才显示手填模型）
function isFieldVisible(field, savedValues) {
  if (!field.showWhen) return true;
  return savedValues && savedValues[field.showWhen.key] === field.showWhen.value;
}

// 单个控件：text / password / textarea / select 四种形态
function renderFieldControl(field, savedValue) {
  if (field.type === 'textarea') {
    return `<textarea data-auth-key="${escapeHtml(field.key)}" placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(savedValue)}</textarea>`;
  }
  if (field.type === 'select') {
    const optionsHtml = (field.options || []).map(function (option) {
      const selected = option.value === savedValue ? ' selected' : '';
      return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
    }).join('');
    return `<select class="field-select" data-auth-key="${escapeHtml(field.key)}">${optionsHtml}</select>`;
  }
  return `<input type="${field.type === 'password' ? 'password' : 'text'}" data-auth-key="${escapeHtml(field.key)}"
            placeholder="${escapeHtml(field.placeholder || '')}" value="${escapeHtml(savedValue)}">`;
}

// 第二步表单字段：完全由 driver.authSchema 驱动，未满足 showWhen 的字段不渲染
function renderAuthFields(driver, savedValues) {
  if (!driver) return '';
  return driver.authSchema.filter(function (field) {
    return isFieldVisible(field, savedValues);
  }).map(function (field) {
    const savedValue = savedValues && savedValues[field.key]
      ? savedValues[field.key]
      : (field.type === 'select' && field.options && field.options.length ? field.options[0].value : '');
    return `<div class="field">
      <label class="field-label">${escapeHtml(field.label)}${field.required ? '<span class="req-mark">*</span>' : ''}</label>
      ${renderFieldControl(field, savedValue)}
    </div>`;
  }).join('');
}

// 平台下拉：选项来自后端预置的平台列表（显示平台名），前端不写死任何平台
// 平台选择的选项来源有两类：
//   ① 平台预置（config/platforms.json）：value = preset:<id>，带 baseURL/头像/摘要模板
//   ② 未被任何预置覆盖的驱动：value = driver:<driverId>，即"通用入口"（如 OpenAI 兼容（配置型））
// 只列预置会让用户以为"只能选已知平台"，所以两者都要出现。
function renderPlatformOptions(platforms, drivers, selectedValue) {
  const presetOptions = (platforms || []).map(function (platform) {
    const value = 'preset:' + platform.id;
    const selected = value === selectedValue ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(platform.name)}</option>`;
  }).join('');

  // 驱动始终全部列出：预置只是"某平台的一组默认值"，而"通用入口"（不绑平台）必须随时可选，
  // 否则用户只能选已知平台，无法接入别人家的 OpenAI 兼容服务。
  const driverOptions = (drivers || []).map(function (driver) {
    const value = 'driver:' + driver.id;
    const selected = value === selectedValue ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(driver.name)}</option>`;
  }).join('');

  return presetOptions + driverOptions;
}

// 解析平台选择值：preset:<id> → 预置对象；driver:<id> → 驱动对象（无预置）
function resolvePlatformSelection(platforms, drivers, selectedValue) {
  const rawValue = typeof selectedValue === 'string' ? selectedValue : '';
  if (rawValue.indexOf('driver:') === 0) {
    const driverId = rawValue.slice('driver:'.length);
    const driver = (drivers || []).filter(function (item) { return item.id === driverId; })[0] || null;
    return { platform: null, driver: driver, driverId: driverId };
  }
  const presetId = rawValue.indexOf('preset:') === 0 ? rawValue.slice('preset:'.length) : rawValue;
  const platform = (platforms || []).filter(function (item) { return item.id === presetId; })[0]
    || (platforms || [])[0] || null;
  const driver = platform
    ? ((drivers || []).filter(function (item) { return item.id === platform.driverId; })[0] || (drivers || [])[0] || null)
    : ((drivers || [])[0] || null);
  return { platform: platform, driver: driver, driverId: platform ? platform.driverId : (driver ? driver.id : '') };
}

// 模型目录（第三段）：行内 id/name 两个输入 + 删除；mode=auto 时提交走 models.endpoint
function renderModelCatalog(catalog) {
  const models = (catalog && catalog.models) || [];
  const probeState = (catalog && catalog.probe) || {};
  const mode = catalog && catalog.mode === 'manual' ? 'manual' : 'auto';

  const rows = models.map(function (model, index) {
    return `<div class="model-row" data-model-index="${index}">
      <input type="text" data-model-id="${index}" value="${escapeHtml(model.id || '')}" placeholder="例如 agnes-3.0-flash">
      <input type="text" data-model-name="${index}" value="${escapeHtml(model.name || '')}" placeholder="可空，默认用 id">
      <button type="button" class="model-remove" data-model-remove="${index}" title="删除这一行">×</button>
    </div>`;
  }).join('');

  const modeText = mode === 'auto'
    ? '自动拉取（提交时写 models.endpoint = /models，由网关按接口发现）'
    : '手动目录（提交时写 models.static，共 ' + models.length + ' 行，id 为空的行会被忽略）';
  const probeButtonText = probeState.loading ? '探测中…' : '获取可用模型';

  return `<div class="form-step">
    <div class="form-step-title">
      <span class="step-no">3</span>模型目录
      <span class="step-actions">
        <button type="button" class="btn-ghost" id="btnProbeModels"${probeState.loading ? ' disabled' : ''}>${probeButtonText}</button>
        <button type="button" class="btn-ghost" id="btnResetModels">恢复默认模型</button>
      </span>
    </div>
    <div class="model-mode" id="modelMode">${escapeHtml(modeText)}</div>
    <div class="model-table">
      <div class="model-row model-row-head"><span>模型 id（必填）</span><span>显示名（可空=用 id）</span><span>删除</span></div>
      ${rows}
    </div>
    <button type="button" class="btn-ghost" id="btnAddModelRow">＋ 添加模型</button>
    <div class="probe-feedback${probeState.error ? ' probe-error' : ''}" id="probeFeedback">${escapeHtml(probeState.error || '')}</div>
  </div>`;
}

// 视图三：加群（选平台 → 按平台预置预填 → 按 driver.authSchema 填接入信息 → 模型目录）
// 预填规则：用户没填过的字段用平台默认值（群名 / API 地址），填过的原样保留。
function renderAddGroup(platforms, drivers, platformId, savedValues, savedName, catalog) {
  const platformList = platforms || [];
  const driverList = drivers || [];
  const selection = resolvePlatformSelection(platformList, driverList, platformId);
  const currentPlatform = selection.platform;
  const currentDriver = selection.driver;
  const selectedValue = currentPlatform ? ('preset:' + currentPlatform.id) : ('driver:' + selection.driverId);

  const prefilledValues = {};
  Object.keys(savedValues || {}).forEach(function (key) { prefilledValues[key] = savedValues[key]; });
  if (currentPlatform && !prefilledValues.baseURL && currentPlatform.baseURL) {
    prefilledValues.baseURL = currentPlatform.baseURL;
  }
  const effectiveName = savedName || (currentPlatform ? currentPlatform.name : '');
  const driverHint = currentPlatform
    ? currentPlatform.name + ' · 驱动 ' + currentPlatform.driverId
      + (currentPlatform.summaryTemplate ? ' · ' + currentPlatform.summaryTemplate : '')
    : '暂无可用平台';

  return `<form class="view view-add" id="addGroupForm" autocomplete="off">
    <header class="view-head">
      <button class="btn-back" id="btnAddBack" type="button">&lt; 返回</button>
      <span class="head-title">新建群聊（添加账号）</span>
    </header>
    <div class="form-body">
      <div class="form-step">
        <div class="form-step-title"><span class="step-no">1</span>选择平台</div>
        <select class="driver-select" id="platformSelect">${renderPlatformOptions(platformList, driverList, selectedValue)}</select>
        <div class="driver-hint">${escapeHtml(driverHint)}</div>
      </div>
      <div class="form-step">
        <div class="form-step-title"><span class="step-no">2</span>接入信息（根据 authSchema 动态生成）</div>
        <div class="field">
          <label class="field-label">群名称 (自定义)</label>
          <input class="group-name-input" id="groupNameInput" type="text" placeholder="例如：我的账号" value="${escapeHtml(effectiveName)}">
        </div>
        <div id="authFields">${renderAuthFields(currentDriver, prefilledValues)}</div>
      </div>
      ${renderModelCatalog(catalog)}
    </div>
    <div class="form-footer">
      <button class="btn-primary" id="btnSubmitGroup" type="button">校验并添加群</button>
      <div class="form-note">API Key 由服务端落盘保存，配置文件里只留引用。</div>
    </div>
  </form>`;
}

// 视图四：我的数据库（导入 / 导出 + 已连接账号）
function renderProfile(groups) {
  const itemsHtml = groups.map(function (group) {
    return `<div class="conn-item">
      <span class="avatar">${renderAvatar(group.avatar, group.name)}</span>
      <div>
        <div class="conn-name">${escapeHtml(group.name)}</div>
        <div class="conn-meta conn-meta-compact">${escapeHtml(group.driverId)}</div>
      </div>
      <span class="conn-meta">${escapeHtml(group.summary)}</span>
    </div>`;
  }).join('');

  return `<section class="view view-profile">
    <header class="view-head">
      <button class="btn-back" id="btnDatabaseBack" type="button">&lt; 返回</button>
      <span class="head-title">我的模型团队</span>
    </header>
    <div class="profile-body">
      <div class="profile-card">
        <span class="avatar big round">[我]</span>
        <div class="profile-main">
          <div class="profile-name">我的模型团队</div>
          <div class="profile-sub">当前已连接 <b>${groups.length}</b> 个平台账号</div>
        </div>
        <div class="profile-actions">
          <button class="btn-outline" id="btnImport" type="button">导入账号配置 (JSON)</button>
          <button class="btn-outline" id="btnExport" type="button">导出当前配置</button>
        </div>
      </div>
      <div class="conn-title">已连接的平台账号 / 群</div>
      <div class="conn-list">${itemsHtml}</div>
    </div>
  </section>`;
}
