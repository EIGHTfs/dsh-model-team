// chat.js —— 群聊交互：@ 选择器、插入输入框、发送与切换目标（写入一律走 store.dispatch）。
// 消息合并/排序/系统提示都归工厂：这里不再本地插 system 文案，也不直接调 api 改会话。

// 选择器条目：本群群友（带来源平台）在前、好友分组（带成员数）在后，键盘用同一份 items 索引
function buildAtSections() {
  const current = ensureState();
  const activeGroup = currentGroup();
  // 群对象的驱动字段是 driver（契约 §3.1 同名透传）；读 driverId 会恒空 → 选择器里平台名缺失
  const activeDriverId = activeGroup ? (activeGroup.driver || activeGroup.driverId) : '';
  const activeDriver = current && current.drivers ? current.drivers.filter(function (driver) {
    return driver.id === activeDriverId;
  })[0] : null;
  const driverName = activeDriver
    ? String(activeDriver.name).split(/[（(]/)[0].trim()
    : (activeDriverId || '');

  const modelItems = modelsOf(current.currentGroupId).map(function (model) {
    const shortName = String(model.name || model.id).replace(/^global:/, '');
    return {
      type: 'model',
      id: model.id,
      label: shortName,
      display: driverName ? shortName + ' (' + driverName + ')' : shortName,
      avatar: '[' + shortName.charAt(0).toUpperCase() + ']',
      // 窗口随条目带出来：@ 选择器要如实展示（未知显示 —），切换提示也用它比较
      contextLength: model.contextLength
    };
  });
  const groupItems = (current.friendGroups || []).map(function (friendGroup) {
    return {
      type: 'group',
      id: friendGroup.id,
      label: friendGroup.name,
      display: friendGroup.name,
      memberCount: friendGroup.members ? friendGroup.members.length : 0
    };
  });
  return { modelItems: modelItems, groupItems: groupItems, all: modelItems.concat(groupItems) };
}

// 打开 @ 浮层：两块列表 + 记录触发用的 @ 位置
function openAtPop() {
  const atPop = findElement('#atPop');
  if (!atPop) return;
  const sections = buildAtSections();
  if (!sections.all.length) return;
  viewState.atPicker.open = true;
  viewState.atPicker.activeIndex = 0;
  viewState.atPicker.items = sections.all;
  const messageInput = findElement('#msgInput');
  viewState.atPicker.triggerIndex = messageInput ? messageInput.value.lastIndexOf('@') : -1;

  const modelsHtml = sections.modelItems.length
    ? renderAtSection('本群群友（单模型）') + sections.modelItems.map(renderAtModelItem).join('')
    : '';
  const groupsHtml = sections.groupItems.length
    ? renderAtSection('我的好友分组（轮换组）') + sections.groupItems.map(function (item, offset) {
      return renderAtGroupItem(item, sections.modelItems.length + offset);
    }).join('')
    : '';
  findElement('#atList').innerHTML = modelsHtml + groupsHtml;
  atPop.classList.remove('hidden');
  syncAtActive();
}

function closeAtPop() {
  const atPop = findElement('#atPop');
  if (atPop) atPop.classList.add('hidden');
  viewState.atPicker.open = false;
}

// 高亮键盘选中项
function syncAtActive() {
  findElements('#atList .at-item').forEach(function (element, index) {
    element.classList.toggle('active', index === viewState.atPicker.activeIndex);
  });
}

// 把 @条目 写进输入框：替换触发用的那个 @，避免出现 @@
function insertMention(item) {
  const messageInput = findElement('#msgInput');
  if (!messageInput || !item) return;
  const inputValue = messageInput.value;
  const recordedIndex = viewState.atPicker.triggerIndex;
  const triggerIndex = recordedIndex >= 0 && recordedIndex < inputValue.length
    ? recordedIndex
    : inputValue.lastIndexOf('@');
  const beforeMention = (triggerIndex >= 0 ? inputValue.slice(0, triggerIndex) : inputValue).replace(/@+$/, '');
  messageInput.value = beforeMention + '@' + item.label + ' ';
  viewState.atPicker.triggerIndex = -1;
  closeAtPop();
  messageInput.focus();
}

// 输入里最后一个 @ 之后还没有空格，就认为正在选人
function syncAtByInput(inputElement) {
  const inputValue = inputElement.value;
  const atIndex = inputValue.lastIndexOf('@');
  if (atIndex >= 0 && inputValue.slice(atIndex + 1).indexOf(' ') === -1) {
    if (!viewState.atPicker.open) openAtPop();
  } else {
    closeAtPop();
  }
}

// 发送：由工厂乐观插一条我的气泡，随后用后端事件重建；@分组/@模型 再切一次目标。
// 系统提示只在后端定义（契约 §六），这里不本地拼任何 system 文案。
function sendMessage() {
  const messageInput = findElement('#msgInput');
  if (!messageInput) return;
  const messageText = messageInput.value.trim().replace(/@+/g, '@');
  if (!messageText) { toast('先输入点什么再发送'); return; }

  messageInput.value = '';
  closeAtPop();
  store.dispatch({ type: 'send-message', text: messageText });

  const mentionMatch = /@([^\s]+)/.exec(messageText);
  if (!mentionMatch) return;
  const mentionText = mentionMatch[1];
  const current = ensureState();

  const matchedGroup = (current.friendGroups || []).filter(function (friendGroup) {
    return friendGroup.name === mentionText || friendGroup.id === mentionText;
  })[0];
  if (matchedGroup) {
    store.dispatch({ type: 'switch-target', target: { type: 'group', id: matchedGroup.id } });
    return;
  }

  const matchedModel = modelsOf(current.currentGroupId).filter(function (model) {
    return String(model.name || model.id).replace(/^global:/, '') === mentionText || model.id === mentionText;
  })[0];
  if (matchedModel) {
    warnOnSmallerWindow(current, matchedModel);
    store.dispatch({
      type: 'switch-target',
      target: { type: 'model', id: matchedModel.id, platformId: current.currentGroupId }
    });
  }
}

// 切到更小窗口的模型时提示一次（不阻断）。为什么要提示：申报给 dsh 的是所有模型窗口的最小值，
// 但真实请求打到的是目标模型；从大窗口切到小窗口后，长上下文请求会被上游拒绝，提前说一声比事后报 400 好。
// 任一侧窗口未知就不提示——宁可不提示，也不要拿兜底值吓人。
function warnOnSmallerWindow(current, nextModel) {
  const previousTarget = current.effectiveTarget || current.target;
  if (!previousTarget || previousTarget.type !== 'model') return;
  const previousModel = modelsOf(current.currentGroupId).filter(function (model) {
    return model.id === previousTarget.id;
  })[0];
  const previousWindow = Number(previousModel && previousModel.contextLength);
  const nextWindow = Number(nextModel.contextLength);
  if (!Number.isFinite(previousWindow) || !Number.isFinite(nextWindow)) return;
  if (nextWindow >= previousWindow) return;
  toast('目标窗口变小：' + formatContextLength(previousWindow) + ' → ' + formatContextLength(nextWindow)
    + '，长上下文请求可能被拒');
}
