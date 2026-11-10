// db-view.js —— 数据库页（备份/恢复）的**显示投影**：纯函数，不认识任何请求细节。
//
// 为什么单独一层：备份对象与导入回执是"服务端契约形状"，界面不该直接读它们——
// 一旦主题自己去摸 groups / credentialFiles / rejected 这些字段名，
// 契约改名就会把界面一起改坏（与加群页的值显分离同一条原则）。
// 这里把"原始响应"折叠成"用户能看懂的行"，主题只渲染行。

// 备份对象里没有值时给的中文占位（不要让界面出现 undefined）
var DB_EMPTY_TEXT = '—';

function toCountText(rawValue) {
  return typeof rawValue === 'number' && Number.isFinite(rawValue) ? String(rawValue) : '0';
}

/** 导出后的备份摘要：版本 / 导出时间 / 群数量 / 凭据文件数 / 无法导出的引用数 */
function summarizeBackup(backup) {
  var source = backup && typeof backup === 'object' ? backup : {};
  var exportedAtText = DB_EMPTY_TEXT;
  if (typeof source.exportedAt === 'string' && source.exportedAt.length > 0) {
    // 只显示到秒，且把 T 换空格：这是给人看的摘要，不是给机器解析的时间戳
    exportedAtText = source.exportedAt.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
  }
  return {
    versionText: typeof source.version === 'number' ? 'v' + source.version : DB_EMPTY_TEXT,
    exportedAtText: exportedAtText,
    groupCount: Array.isArray(source.groups) ? source.groups.length : 0,
    credentialFileCount: source.credentialFiles && typeof source.credentialFiles === 'object'
      ? Object.keys(source.credentialFiles).length
      : 0,
    unresolvedRefCount: Array.isArray(source.unresolvedRefs) ? source.unresolvedRefs.length : 0,
  };
}

/** 选好文件后的导入预览：能数出来的都先数出来，让人在提交前就知道会动多少东西 */
function previewImport(parsedBackup, fileName) {
  var source = parsedBackup && typeof parsedBackup === 'object' ? parsedBackup : null;
  var groups = source && Array.isArray(source.groups) ? source.groups : null;
  return {
    fileName: typeof fileName === 'string' ? fileName : '',
    isBackupShaped: groups !== null,
    groupCount: groups ? groups.length : 0,
    credentialFileCount: source && source.credentialFiles && typeof source.credentialFiles === 'object'
      ? Object.keys(source.credentialFiles).length
      : 0,
    invalidCount: groups ? groups.filter(function (groupEntry) {
      return !groupEntry || typeof groupEntry !== 'object' || typeof groupEntry.id !== 'string' || groupEntry.id.length === 0;
    }).length : 0,
  };
}

/** 导入回执：头部一句话 + 数字行 + 拒绝明细 + 跳过明细（全部来自服务端，不自己算） */
function buildImportReceipt(result) {
  var source = result && typeof result === 'object' ? result : {};
  var rejectedRows = (Array.isArray(source.rejected) ? source.rejected : []).map(function (entry, index) {
    return {
      index: typeof entry?.index === 'number' ? entry.index : index,
      reason: typeof entry?.reason === 'string' ? entry.reason : '未给出原因',
    };
  });
  var skippedRows = (Array.isArray(source.skippedRefs) ? source.skippedRefs : []).map(function (entry) {
    return {
      path: typeof entry?.path === 'string' ? entry.path : DB_EMPTY_TEXT,
      reason: typeof entry?.reason === 'string' ? entry.reason : '未给出原因',
    };
  });
  return {
    headline: '导入完成：新增 ' + toCountText(source.imported) + ' 条，更新 ' + toCountText(source.updated)
      + ' 条，拒绝 ' + toCountText(rejectedRows.length) + ' 条',
    rows: [
      { label: '新增', value: toCountText(source.imported) },
      { label: '更新', value: toCountText(source.updated) },
      { label: '拒绝', value: toCountText(rejectedRows.length) },
      { label: '凭据还原', value: toCountText(source.restoredCredentialFiles) },
      { label: '跳过引用', value: toCountText(skippedRows.length) },
    ],
    rejectedRows: rejectedRows,
    skippedRows: skippedRows,
  };
}

/**
 * 失败归一：服务端 message/hint 原文照搬（不自己编），只补"是否需要二次确认"这一个判断。
 * `needsConfirm` 的判据只有一条：错误码是 `confirmation-required`（服务端 409 的码，见 errors.js）。
 */
function describeDbFailure(error) {
  var source = error && typeof error === 'object' ? error : {};
  var code = typeof source.code === 'string' ? source.code : '';
  var message = typeof source.message === 'string' && source.message.length > 0 ? source.message : '操作失败';
  var hint = typeof source.hint === 'string' ? source.hint : '';
  return {
    code: code,
    title: message,
    detail: hint,
    needsConfirm: code === 'confirmation-required',
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.dshHostDbView = {
    summarizeBackup: summarizeBackup,
    previewImport: previewImport,
    buildImportReceipt: buildImportReceipt,
    describeDbFailure: describeDbFailure,
  };
}
