// 加群页反代登录交互（规范 docs/17）：一次点击 → 立刻开窗 → 轮询；轮询只更新账号容器。
//
// 四条硬约束（违反即返工）：
//   1. 轮询期间**不许**整页重建（只重绘 [data-reverse-accounts] 内层）；
//   2. 不让用户点第二次：拿到 loginUrl 就在同一段异步续体里 window.open；
//   3. 六种清理路径：granted / expired / cancelled / 窗口被关 / 切平台 / 离开页面；
//   4. 页面其余输入的值与焦点不受影响。

var REVERSE_POLL_INTERVAL_MS = 1000;
var REVERSE_LOGIN_MAX_WAIT_MS = 3 * 60 * 1000;   // 与设备码有效期一致

var reversePollTimer = null;
// 纯 UI 态：accounts 是服务端脱敏列表；login 是进行中的一次登录（五态机见 docs/17 §二）
var reversePanel = { platformId: '', accounts: [], accountsLoaded: false, selectedAccountId: '', login: null };

function reversePanelState() { return reversePanel; }

function resetReversePanel() {
  reversePanel = { platformId: '', accounts: [], accountsLoaded: false, selectedAccountId: '', login: null };
}

function currentReverseDriver() {
  var current = ensureState();
  var selection = resolvePlatformSelection(current.platforms || [], current.drivers || [], viewState.addForm.platformId);
  return selection.driver;
}

// 只重绘账号容器内层：容器外的输入框/焦点不受影响
function updateReverseAccountsDom() {
  var container = document.querySelector('[data-reverse-accounts]');
  if (!container) return false;
  container.innerHTML = renderReverseAccountsInner(currentReverseDriver(), reversePanelState());
  var submitButton = document.querySelector('#btnSubmitGroup');
  if (submitButton) {
    submitButton.disabled = reversePanelState().accounts.length === 0;
  }
  // footer 说明也要跟着走：登录成功后不能还挂着「尚未登录…」
  var noteNode = document.querySelector('[data-reverse-note]');
  if (noteNode) noteNode.textContent = renderReverseSubmitNote(currentReverseDriver(), reversePanelState());
  return true;
}

function stopReversePoll() {
  if (reversePollTimer !== null) {
    clearTimeout(reversePollTimer);
    reversePollTimer = null;
  }
}

function failReverseLogin(reasonText) {
  stopReversePoll();
  reversePanelState().login = { state: 'failed', errorText: reasonText };
  updateReverseAccountsDom();
}

function refreshReverseAccounts(platformId, options) {
  var panel = reversePanelState();
  panel.platformId = platformId;
  return api.getReverseAccounts(platformId).then(function (accounts) {
    panel.accountsLoaded = true;
    panel.accounts = accounts || [];
    if (options && options.selectAccountId) panel.selectedAccountId = options.selectAccountId;
    else if (!panel.selectedAccountId && panel.accounts.length > 0) panel.selectedAccountId = panel.accounts[0].accountId;
    updateReverseAccountsDom();
    return panel.accounts;
  }, function () {
    updateReverseAccountsDom();
    return [];
  });
}

function loadReverseAccountsForAddForm() {
  var driver = currentReverseDriver();
  if (!driver || driver.authKind !== 'reverse-account') return;
  var panel = reversePanelState();
  if (panel.platformId === driver.platformId && panel.accountsLoaded) return;
  refreshReverseAccounts(driver.platformId);
}

function scheduleReversePoll() {
  stopReversePoll();
  var panel = reversePanelState();
  if (!panel.login || panel.login.state !== 'waiting') return;
  reversePollTimer = setTimeout(pollReverseLoginOnce, REVERSE_POLL_INTERVAL_MS);
}

// 把一次状态查询的返回翻译成"界面能说清楚的话"（docs/20 §九：错误与过期必须分离）
function describeReverseStatusFailure(result) {
  if (result && result.status === 404) return '登录会话已失效，请重新登录';
  if (result && result.status >= 500) return '登录服务异常（HTTP ' + result.status + '）';
  if (result && result.status === 0) return '登录服务异常（网络错误）';
  if (result && result.ok) return '登录服务异常（回执缺少状态）';
  return '登录服务异常（HTTP ' + (result && result.status ? result.status : '未知') + '）';
}

function pollReverseLoginOnce() {
  reversePollTimer = null;
  var panel = reversePanelState();
  var login = panel.login;
  if (!login || login.state !== 'waiting') return;
  // 清理路径：离开加群页（容器没了）
  if (!document.querySelector('[data-reverse-accounts]')) { stopReversePoll(); return; }
  // 清理路径：用户把授权页关了
  if (login.windowRef && login.windowRef.closed === true) { failReverseLogin('授权页已关闭'); return; }
  // 清理路径：超时
  if (login.startedAtMs && Date.now() - login.startedAtMs > REVERSE_LOGIN_MAX_WAIT_MS) {
    failReverseLogin('授权已超时，请重新登录');
    return;
  }

  // 按平台轮询：任何一次授权（哪怕用户点了两次、开了两个授权页）都会被这里捞到
  api.getReverseLoginStatusRaw(login.platformId).then(function (result) {
    var body = result && result.body ? result.body : null;
    if (result && result.ok && body && body.status === 'pending') { scheduleReversePoll(); return; }
    if (result && result.ok && body && body.status === 'granted') {
      stopReversePoll();   // 清理路径：成功
      var savedAccount = body.account || {};
      login.state = 'granted';
      login.accountLabel = savedAccount.nickname || savedAccount.userId || '账号已保存';
      refreshReverseAccounts(login.platformId, { selectAccountId: savedAccount.accountId || '' }).then(updateReverseAccountsDom);
      return;
    }
    if (result && result.ok && body && body.status === 'expired') { failReverseLogin('授权已超时，请重新登录'); return; }
    if (result && result.ok && body && body.status === 'cancelled') { failReverseLogin('已取消登录'); return; }
    // 其它情况（404 / 5xx / 网络 / 回执没有 status）：是"服务或会话出问题"，不是"超时"
    failReverseLogin(describeReverseStatusFailure(result));
  }, function () {
    // axios 级异常（理论上 getReverseLoginStatusRaw 已 catch，这里兜底）：下一拍继续
    scheduleReversePoll();
  });
}

function startReverseLogin() {
  var driver = currentReverseDriver();
  if (!driver || driver.authKind !== 'reverse-account') return;
  var panel = reversePanelState();
  // 等待期间再点：**不新建会话、不停轮询**，只是把同一个授权页再打开一次（用户可能关掉了它）
  if (panel.login && panel.login.state === 'waiting' && panel.login.loginUrl) {
    try { window.open(panel.login.loginUrl, '_blank', 'width=800,height=620'); } catch (openError) { /* 打不开就保持原状 */ }
    return;
  }
  if (panel.login && panel.login.state === 'starting') return;   // 防连点：请求在途

  stopReversePoll();
  // ① 同帧：按钮禁用 + 文案变化（不等网络）
  panel.login = { state: 'starting', platformId: driver.platformId };
  updateReverseAccountsDom();

  // ② 立刻发起
  api.startReverseLogin(driver.platformId).then(function (started) {
    if (!started || !started.loginUrl) { failReverseLogin('无法发起登录：服务端没有返回授权地址'); return; }
    // ③ 同一段异步续体里开窗（离用户手势还近，浏览器允许）
    var loginWindow = null;
    try {
      loginWindow = window.open(started.loginUrl, '_blank', 'width=800,height=620');
    } catch (openError) {
      loginWindow = null;
    }
    var blocked = !loginWindow || loginWindow.closed === true;
    panel.login = {
      state: 'waiting',
      platformId: driver.platformId,
      sessionId: started.sessionId,
      loginUrl: started.loginUrl,
      windowRef: loginWindow,
      blocked: blocked,
      startedAtMs: Date.now(),
    };
    updateReverseAccountsDom();
    scheduleReversePoll();
  }, function (error) {
    failReverseLogin('无法发起登录：' + (error && error.message ? error.message : '未知原因'));
  });
}

// 整页渲染兜底：抓取加群表单的输入值与焦点，渲染后恢复（docs/17 §三.3「不许丢输入」）。
// 正常路径不该整页重建；这道防线是为了任何意外渲染都不丢用户已经敲的字。
function captureAddFormSnapshot() {
  var form = document.querySelector('.view-add');
  if (!form) return null;
  var values = {};
  Array.prototype.slice.call(form.querySelectorAll('input,textarea,select')).forEach(function (node, index) {
    values[node.id || node.dataset.authKey || ('idx-' + index)] = node.value;
  });
  var active = document.activeElement;
  return {
    values: values,
    activeId: active && active.id ? active.id : '',
    selectionStart: active && typeof active.selectionStart === 'number' ? active.selectionStart : null,
  };
}

function restoreAddFormSnapshot(snapshot) {
  if (!snapshot) return;
  var form = document.querySelector('.view-add');
  if (!form) return;
  Array.prototype.slice.call(form.querySelectorAll('input,textarea,select')).forEach(function (node, index) {
    var key = node.id || node.dataset.authKey || ('idx-' + index);
    if (Object.prototype.hasOwnProperty.call(snapshot.values, key) && node.value !== snapshot.values[key]) node.value = snapshot.values[key];
  });
  if (!snapshot.activeId) return;
  var focusTarget = document.getElementById(snapshot.activeId);
  if (!focusTarget || typeof focusTarget.focus !== 'function') return;
  focusTarget.focus();
  if (snapshot.selectionStart !== null && typeof focusTarget.setSelectionRange === 'function') {
    try { focusTarget.setSelectionRange(snapshot.selectionStart, snapshot.selectionStart); } catch (error) { /* 非文本控件忽略 */ }
  }
}
