// db.js —— 数据库页（备份/恢复）的**值**：整个过程的中间态只在这里。
//
// 为什么不塞进 forms.js：forms.js 的既有约定是"只调接口、不写 state"（store/index.js 的注释），
// 而备份/恢复需要过程态（导出中 / 导入中 / 待确认 / 完成 / 失败）与"上一次回执"，
// 那属于状态机，必须有一个明确的持有者。
//
// 分层：本文件的动作 → 调接口（原始响应）→ 交给 format/db-view.js 折叠成文案 → 写 state.db → 广播。
// 主题只读 useDbState() 的投影，不认识 groups / credentialFiles / mode / confirm 这些字段名。

/** 初始状态：phase 是**单值**，不允许"导出中 + 导入中"这类非法组合同时成立 */
function createDbState() {
  return {
    phase: 'idle',            // idle | exporting | importing | need-confirm | done | error
    error: null,              // { code, title, detail, needsConfirm } —— 文案来自 db-view 的归一
    backupSummary: null,      // 导出成功后：{ versionText, exportedAtText, groupCount, credentialFileCount, unresolvedRefCount }
    preview: null,            // 选好文件、提交前：{ fileName, isBackupShaped, groupCount, credentialFileCount, invalidCount }
    pendingImport: null,      // 409 之后暂存待确认的导入：{ text, fileName }
    lastExport: null,         // { fileName, bytes, at }
    lastImport: null,         // { headline, rows, rejectedRows, skippedRows, at }
  };
}

// 导入请求码：服务端的"需要二次确认"（errors.js 的 CONFIRMATION_REQUIRED，HTTP 409）
var DB_CONFIRM_REQUIRED_CODE = 'confirmation-required';
// 导出文件名前缀：带时间戳便于区分多次导出（本地时间，只用于文件名）
var DB_EXPORT_FILE_PREFIX = 'model-team-backup-';

function createDbActions(deps) {
  var api = deps.api;
  var state = deps.state;
  var broadcast = deps.broadcast;
  var download = deps.download || function (fileName, text) {
    // 没有注入端口时退化为"只回结果不落盘"（单测/无 DOM 环境不炸）
    return { fileName: fileName, bytes: String(text || '').length };
  };

  function ensureDb() {
    if (!state.db) state.db = createDbState();
    return state.db;
  }

  function emit() {
    broadcast('db:changed', { db: ensureDb() });
  }

  function setPhase(phase) {
    var db = ensureDb();
    db.phase = phase;
    if (phase !== 'error') db.error = null;
    emit();
    return db;
  }

  function failWith(error) {
    var db = ensureDb();
    db.error = describeDbFailure(error);
    db.phase = db.error.needsConfirm ? 'need-confirm' : 'error';
    emit();
    return db;
  }

  function stampFileName() {
    var now = new Date();
    var pad = function (value) { return String(value).padStart(2, '0'); };
    return DB_EXPORT_FILE_PREFIX + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
      + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '.json';
  }

  /**
   * 导入请求（原样把备份当请求体，只追加 mode/confirm）：
   * 为什么原样：备份里的 credentialFiles 是服务端还原凭据的唯一来源，挑字段会把凭据漏掉，
   * 造成"群导入成功但凭证缺失"的中间态（routes/config.js 的注释就是为这个顺序写的）。
   * 为什么用 apiPostRaw：apiJson 把非 2xx 吞成 null（api.js），409 的 code/hint 会全丢。
   */
  function postImport(parsedBackup, requestOptions) {
    var options = requestOptions || {};
    var payload = Object.assign({}, parsedBackup);
    if (options.mode) payload.mode = options.mode;
    if (options.confirm === true) payload.confirm = true;
    return apiPostRaw('/import', payload).then(function (body) {
      if (body && body.error) {
        throw apiServerError(body, '导入失败', 'IMPORT_FAILED');
      }
      return body;
    });
  }

  /** 导出备份：接口 → 摘要 → 落盘 → 记录 { fileName, bytes } */
  function exportDbBackup() {
    setPhase('exporting');
    return Promise.resolve(api.exportConfig()).then(function (backup) {
      if (!backup || typeof backup !== 'object') {
        return failWith({ code: 'export-empty', message: '导出失败：服务端没有返回内容' });
      }
      var db = ensureDb();
      db.backupSummary = summarizeBackup(backup);
      var fileName = stampFileName();
      var saved = download(fileName, JSON.stringify(backup, null, 2));
      db.lastExport = {
        fileName: saved && saved.fileName ? saved.fileName : fileName,
        bytes: saved && typeof saved.bytes === 'number' ? saved.bytes : 0,
        at: new Date().toISOString(),
      };
      setPhase('done');
      return backup;
    }).catch(function (error) {
      return failWith(error);
    });
  }

  /** 选好文件后先做预览（纯本地解析，不上行、不落盘） */
  function previewDbImport(input) {
    var source = input || {};
    var db = ensureDb();
    var parsed = null;
    try {
      parsed = JSON.parse(typeof source.text === 'string' ? source.text : '');
    } catch {
      db.preview = null;
      return failWith({ code: 'parse-failed', message: '内容不是合法 JSON' });
    }
    db.preview = previewImport(parsed, source.fileName);
    if (!db.preview.isBackupShaped) {
      return failWith({ code: 'shape-invalid', message: '这不是一份备份文件：缺少群列表' });
    }
    setPhase('idle');
    return db.preview;
  }

  /**
   * 导入：merge 直接执行；replace 首次**不带 confirm**（服务端会回 409），
   * 收到 409 后进 need-confirm 态并把请求体暂存，等用户点"确认替换"再带 confirm 重发。
   */
  function importDbBackup(input) {
    var source = input || {};
    var mode = source.mode === 'replace' ? 'replace' : 'merge';
    // 只有"确认后重发"这一条路径会传 confirm：首次一律不带，让服务端先回 409
    var confirmed = source.confirm === true;
    var db = ensureDb();
    var text = typeof source.text === 'string' ? source.text : '';
    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return Promise.resolve(failWith({ code: 'parse-failed', message: '内容不是合法 JSON' }));
    }
    db.preview = previewImport(parsed, source.fileName);
    setPhase('importing');
    return postImport(parsed, { mode: mode, confirm: confirmed }).then(function (result) {
      db.pendingImport = null;
      db.lastImport = Object.assign(buildImportReceipt(result), { at: new Date().toISOString() });
      setPhase('done');
      return result;
    }).catch(function (error) {
      var dbAfter = failWith(error);
      if (dbAfter.phase === 'need-confirm') {
        // 只有"需要确认"这一个失败要继续走下去：暂存请求体，供 confirmDbReplace 重发
        dbAfter.pendingImport = { text: text, fileName: typeof source.fileName === 'string' ? source.fileName : '' };
        emit();
      }
      return dbAfter;
    });
  }

  /** 二次确认后重发（带 confirm:true） */
  function confirmDbReplace() {
    var db = ensureDb();
    var pending = db.pendingImport;
    if (!pending) return Promise.resolve(failWith({ code: 'no-pending-import', message: '没有待确认的导入' }));
    return importDbBackup({ text: pending.text, fileName: pending.fileName, mode: 'replace', confirm: true });
  }

  /** 清空本页状态（含 pendingImport）：离开 db 页与"重新开始"都调它 */
  function resetDbPage() {
    state.db = createDbState();
    emit();
    return state.db;
  }

  return {
    exportDbBackup: exportDbBackup,
    previewDbImport: previewDbImport,
    importDbBackup: importDbBackup,
    confirmDbReplace: confirmDbReplace,
    resetDbPage: resetDbPage,
  };
}
