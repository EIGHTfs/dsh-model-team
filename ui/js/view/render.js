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

// 球内标记 / 窗口格式化这类跨视图口径搬到 ui-format.js（render.js 保持只做本视图的骨架）。

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

// 视图一：群列表（= 平台账号列表）：顶部搜索 + 加群入口，每项右侧 lastUpdated 本地化时间。
// options.loadError：群接口最近一次失败原因。空列表 + 有失败原因 → 显示"加载失败 + 重试"，
// 不能渲染成「0 个群」——那会把"加载失败"伪装成"确实没有数据"，用户没法判断该重试还是该加群。
function renderGroupList(groups, currentGroupId, filterText, options) {
  const loadError = options && options.loadError ? String(options.loadError) : '';
  const itemsHtml = groups.map(function (group) {
    const timeText = formatGroupTime(group.lastUpdated);
    return `<li class="group-item${group.id === currentGroupId ? ' active' : ''}" data-group-id="${escapeHtml(group.id)}" tabindex="0">
      <span class="avatar">${renderAvatar(group.avatar, group.name)}</span>
      <div class="group-main">
        <div class="group-line"><span class="group-name">${escapeHtml(group.name)}</span></div>
        ${renderGroupSummaryLine(group.summary)}
      </div>
      <div class="group-right">
        ${timeText ? `<span class="group-time">${escapeHtml(timeText)}</span>` : ''}
        <span class="group-driver">${escapeHtml(group.driver)}</span>
      </div>
    </li>`;
  }).join('');

  const isLoadFailure = groups.length === 0 && loadError !== '';
  const countHtml = isLoadFailure
    ? '<span class="list-count list-count-error">加载失败</span>'
    : `<span class="list-count">${groups.length} 个群 · 每个群 = 一个平台账号</span>`;
  const listHtml = isLoadFailure
    ? `<div class="list-error" role="alert">
         <div class="list-error-title">群列表加载失败</div>
         <div class="list-error-detail">${escapeHtml(loadError)}</div>
         <button class="btn-retry" id="btnReloadGroups" type="button">点此重试</button>
       </div>`
    : `<ul class="group-list" id="groupList">${itemsHtml}</ul>`;

  return `<section class="view view-list">
    <div class="list-head">
      <h2>消息</h2>
      <input class="group-search" id="groupSearch" type="search" autocomplete="off"
             placeholder="🔍 搜索群聊 (账号)" value="${escapeHtml(filterText || '')}">
      ${countHtml}
      <button class="btn-add" id="btnAddGroup" type="button">＋ 加群</button>
    </div>
    ${listHtml}
  </section>`;
}

// 视图二：群聊（sys 系统提示 / row 请求记录 / mine 我发出的 @）
// platform：当前群对应的平台信息，用于把请求行标成「[W] WorkBuddy(model)」
// modelsStatus：该群模型清单的加载状态（'loading' | 'loaded' | 'error'）。
// 为什么必须传进来：models 缺省是 []，"还没拉到"与"确实 0 个群友"取值一样，
// 只按长度渲染就会把"未知"显示成 0（G-13 同类问题）。缺省按 loaded 处理，兼容既有调用方。
function renderChat(group, models, messages, platform, modelsStatus) {
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
      <span class="group-tag">[群友: ${formatMemberCount(models, modelsStatus)}]</span>
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

// 只吃「好友分组 + 平台群」两份数据：成员行原来还要 drivers，是为了按驱动取头像，
// 而 platformId 指的是群——留着这个参数等于鼓励下一个人再按驱动查一次，所以直接去掉。
function renderAddressBook(friendGroups, groups) {
  // 成员的 platformId 存的是**群 id**（契约 §3.5 的 agnes 就是群 id），不是驱动 id：
  // 头像与"来自谁"都必须按群取，拿它去查 driverById 永远查不到（旧实现就这么渲染出 [?]）。
  const groupById = {};
  groups.forEach(function (group) { groupById[group.id] = group; });

  const itemsHtml = friendGroups.map(function (friendGroup) {
    const isFallback = friendGroup.strategy === 'fallback';
    const membersHtml = friendGroup.members.map(function (member, memberIndex) {
      const memberGroup = groupById[member.platformId];
      // 平台显示名取群名；群被删掉时回落成 platformId，让人看得出这个成员指向哪儿
      const platformName = memberGroup && memberGroup.name ? memberGroup.name : member.platformId;
      const branch = memberIndex === friendGroup.members.length - 1 ? '└─' : '├─';
      // fallback 组按数组顺序标主/备：第一个是主，其余是备
      let roleTag = '';
      if (isFallback) roleTag = memberIndex === 0 ? '<span class="contact-role contact-role-main">[主]</span>' : '<span class="contact-role">[备]</span>';
      return `<div class="contact-member">
        <span class="contact-branch">${branch}</span>
        <span class="avatar">${renderAvatar(memberGroup && memberGroup.avatar, platformName)}</span>
        <span class="contact-member-model">${escapeHtml(member.modelId)}</span>
        <span class="contact-member-from">(来自 ${escapeHtml(platformName)})</span>
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

// 选择值有两种形态，先归一成 { kind, id }：driver:<id> 走通用入口，preset:<id> 走平台预置；
// 没写前缀的历史值按 preset 处理（旧数据回落规则，不能因为多一层解析就变）。
function parsePlatformSelectionValue(selectedValue) {
  const rawValue = typeof selectedValue === 'string' ? selectedValue : '';
  if (rawValue.indexOf('driver:') === 0) {
    return { kind: 'driver', id: rawValue.slice('driver:'.length) };
  }
  if (rawValue.indexOf('preset:') === 0) {
    return { kind: 'preset', id: rawValue.slice('preset:'.length) };
  }
  return { kind: 'preset', id: rawValue };
}

// 候选两项都走同一个查找：按 id 命中优先，命中不了回落清单第一项（保证表单永远有可提交对象）
function findListEntry(items, id) {
  return (items || []).filter(function (item) { return item.id === id; })[0] || null;
}

function pickFirstEntry(items) {
  return (items && items[0]) || null;
}

// 预置平台 → 它的驱动：平台缺 driverId 或驱动清单里没有时回落第一个驱动
function pickDriverForPlatform(drivers, platform) {
  if (!platform) return pickFirstEntry(drivers);
  return findListEntry(drivers, platform.driverId) || pickFirstEntry(drivers);
}

// 解析平台选择值：preset:<id> → 预置对象；driver:<id> → 驱动对象（无预置）
function resolvePlatformSelection(platforms, drivers, selectedValue) {
  const selection = parsePlatformSelectionValue(selectedValue);
  // 通用入口：只有驱动，没有平台预置；找不到驱动就是 null（这里刻意不回落到第一个驱动，
  // 否则"选了不存在的驱动"会静默变成"用第一个驱动"，写配置时才发现用错驱动）
  if (selection.kind === 'driver') {
    return { platform: null, driver: findListEntry(drivers, selection.id), driverId: selection.id };
  }

  const platform = findListEntry(platforms, selection.id) || pickFirstEntry(platforms);
  const driver = pickDriverForPlatform(drivers, platform);
  return { platform: platform, driver: driver, driverId: platform ? platform.driverId : (driver ? driver.id : '') };
}

// 模型目录（第三段）：行内 id/name 两个输入 + 删除；mode=auto 时提交走 models.endpoint
function renderModelCatalog(catalog) {
  const models = (catalog && catalog.models) || [];
  const probeState = (catalog && catalog.probe) || {};
  const mode = catalog && catalog.mode === 'manual' ? 'manual' : 'auto';

  const rows = models.map(function (model, index) {
    return `<div class="model-row" data-model-index="${index}">
      <input type="text" data-model-id="${index}" value="${escapeHtml(model.id || '')}" placeholder="例如 model-id">
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
function renderAddGroup(platforms, drivers, platformId, savedValues, savedName, catalog, reversePanel) {
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
  // 默认群名：平台预置优先，其次驱动名（反代平台没有预置，就用 Qoder 这类显示名）；
  // 用户手改过时由调用方把内容放进 savedName，这里只做兜底
  // 反代平台没有平台预置：默认群名用驱动显示名（Qoder），别落回"第一个平台"的名字
  const isReverseDriver = Boolean(currentDriver && currentDriver.authKind === 'reverse-account');
  const effectiveName = savedName || (isReverseDriver ? currentDriver.name : (currentPlatform ? currentPlatform.name : (currentDriver ? currentDriver.name : '')));
  // 提示行只给用户看得懂的信息：平台名（有摘要模板就带上）。内部驱动 id / 术语一律不出现。
  const driverHint = currentPlatform
    ? currentPlatform.name + (currentPlatform.summaryTemplate ? ' · ' + currentPlatform.summaryTemplate : '')
    : (currentDriver ? currentDriver.name : '暂无可用平台');

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
        <div class="field">
          <label class="field-label">群名称 (自定义)</label>
          <input class="group-name-input" id="groupNameInput" type="text" placeholder="例如：我的账号" value="${escapeHtml(effectiveName)}">
        </div>
        ${isReverseDriver ? renderReverseAccountPanel(currentDriver, reversePanel) : ''}
      </div>
      ${isReverseDriver ? '' : `<div class="form-step">
        <div class="form-step-title"><span class="step-no">2</span>接入信息</div>
        ${renderAuthFields(currentDriver, prefilledValues)}
      </div>`}
      ${renderModelCatalog(catalog)}
    </div>
    <div class="form-footer">
      <button class="btn-primary" id="btnSubmitGroup" type="button"${reverseSubmitDisabledAttr(currentDriver, reversePanel)}>校验并添加群</button>
      <div class="form-note" data-reverse-note>${currentDriver && currentDriver.authKind === 'reverse-account' ? renderReverseSubmitNote(currentDriver, reversePanel) : 'API Key 由服务端落盘保存，配置文件里只留引用。'}</div>
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
        <div class="conn-meta conn-meta-compact">${escapeHtml(group.driver)}</div>
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
