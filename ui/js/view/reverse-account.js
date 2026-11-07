// 加群页「账号」区渲染（反代平台专用；规范见 docs/17，文案照 §五 文案表，不自编）。
//
// 五态：idle / starting / waiting / granted / failed。
// 关键约束：整页渲染时调 renderReverseAccountPanel 一次；轮询期间只重绘 [data-reverse-accounts] 内层，
// 绝不整页重建（否则输入框与焦点会被销毁——用户实测"表单一直刷新重建"就是这么来的）。

function renderReverseAccountsInner(driver, reversePanel) {
  var panel = reversePanel || { accounts: [], selectedAccountId: '', login: null };
  var accounts = Array.isArray(panel.accounts) ? panel.accounts : [];
  var login = panel.login || null;
  var state = login && login.state ? login.state : 'idle';
  var platformName = driver && driver.name ? driver.name : '该平台';

  var accountOptions = accounts.map(function (account) {
    var originLabel = account.origin === 'login' ? '自己登录' : '导入';
    var label = (account.nickname || account.userId || account.accountId) + ' · ' + originLabel;
    var selected = account.accountId === panel.selectedAccountId ? ' selected' : '';
    return '<option value="' + escapeHtml(account.accountId) + '"' + selected + '>' + escapeHtml(label) + '</option>';
  }).join('');
  var optionsHtml = accountOptions || '<option value="">（尚无账号）</option>';

  var isBusy = state === 'starting' || state === 'waiting';
  var loginLabel = state === 'starting' ? '正在打开授权页…' : ('登录 ' + platformName);

  // 兜底链接（小字）：只在等待时出现；被拦时换成规范里那一句
  var fallbackRow = '';
  if (state === 'waiting' && login && login.loginUrl) {
    var hintText = login.blocked ? '浏览器拦截了弹窗，点这里打开授权页' : '没看到授权页？点这里打开';
    fallbackRow = '<div class="form-note" id="reverseLoginFallback"><a id="reverseLoginLink" href="'
      + escapeHtml(login.loginUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(hintText) + '</a></div>';
  }

  var statusText = state === 'starting' ? '正在打开授权页…'
    : state === 'waiting' ? '等待授权…（浏览器里完成登录后会自动刷新）'
    : state === 'granted' ? ('已登录：' + (login.accountLabel || '账号已保存'))
    : state === 'failed' ? (login.errorText || '登录失败，请重新登录')
    : '';

  return '<label class="field-label">账号<span class="req-mark">*</span></label>'
    + '<select class="field-select" id="reverseAccountSelect" data-reverse-account>' + optionsHtml + '</select>'
    + '<div class="reverse-login-row">'
    + '<button class="btn-primary" id="btnReverseLogin" type="button"' + (isBusy ? ' disabled' : '') + '>' + escapeHtml(loginLabel) + '</button>'
    + '</div>'
    + fallbackRow
    + (statusText ? '<div class="form-note" id="reverseLoginStatus">' + escapeHtml(statusText) + '</div>' : '');
}

function renderReverseAccountPanel(driver, reversePanel) {
  return '<div class="field" id="reverseAccountField" data-reverse-accounts data-platform-id="'
    + escapeHtml(driver && driver.platformId ? driver.platformId : '')
    + '">' + renderReverseAccountsInner(driver, reversePanel) + '</div>';
}

// 提交按钮：无账号时禁用（返回属性片段，直接拼进模板）
function reverseSubmitDisabledAttr(driver, reversePanel) {
  var isReverse = Boolean(driver && driver.authKind === 'reverse-account');
  var accounts = reversePanel && Array.isArray(reversePanel.accounts) ? reversePanel.accounts : [];
  return isReverse && accounts.length === 0 ? ' disabled' : '';
}

// 提交按钮下方说明：有账号说清凭据在哪；没账号直接给规范文案
function renderReverseSubmitNote(driver, reversePanel) {
  var accounts = reversePanel && Array.isArray(reversePanel.accounts) ? reversePanel.accounts : [];
  var platformName = driver && driver.name ? driver.name : '该平台';
  if (accounts.length > 0) return '反代账号的凭据存在账号存储里，群配置只留 account 引用。';
  return '尚未登录 ' + platformName + '，请先点「登录 ' + platformName + '」';
}
