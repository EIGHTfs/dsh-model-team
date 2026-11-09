// driver-view.js —— 驱动元数据的展示口径（纯函数）：主题不该自己认识认证字段名与认证类型字面量。
//
// 为什么要这一层：主题是"别人写的代码"，让它去读 driver.authSchema / 比对 authKind === 'reverse-account'，
// 等于把内部字段名写进界面代码——既容易写错，也会让"改内部命名"变成破坏主题的改动。
// 这里把"一个驱动该怎么展示"收成两个函数，主题只问结果。

var ACCOUNT_AUTH_KIND = 'reverse-account';

// 账号型驱动（凭据是账号引用）还是配置型（凭据是 API Key 字段）
function isAccountAuthDriver(driver) {
  return Boolean(driver && driver.authKind === ACCOUNT_AUTH_KIND);
}

// 需要渲染的凭证字段：只留 text/password/select 三种，其它类型（如隐藏字段）主题不画
function credentialFieldsOf(driver) {
  var declared = driver && Array.isArray(driver.authSchema) ? driver.authSchema : [];
  return declared.filter(function (field) {
    var type = String((field && field.type) || 'text');
    return type === 'text' || type === 'password' || type === 'select' || type === 'textarea';
  });
}

// 驱动展示名：给用户看的是 name，不是 id
function driverDisplayName(driver) {
  if (!driver) return '';
  return String(driver.name || driver.id || '');
}

if (typeof globalThis !== 'undefined') {
  globalThis.dshHostDriverView = {
    isAccountAuthDriver: isAccountAuthDriver,
    credentialFieldsOf: credentialFieldsOf,
    driverDisplayName: driverDisplayName,
  };
}
