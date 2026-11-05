// store-persist.js —— 持久化端口：悬浮球锚点与最近会话标识的读回/写入（契约 docs/13 §七）。
// 依赖全部从参数进来（storage / state / reportError），模块内不引用任何全局状态，
// 这样"去抖 150ms + 退出 flush + loadedOnce 凭证"三条语义可以单独测。

function createPersistencePort(options) {
  var storage = options.storage || { read: function () { return null; }, write: function () {} };
  var state = options.state;
  var reportError = options.reportError;

  var loadedOnce = false;       // 写入凭证：读失败过也不能写空覆盖
  var pendingWrites = {};
  var writeTimer = null;

  function readRaw(key) {
    try { return storage.read(key); }
    catch (error) { reportError('read:' + key, error); return null; }
  }

  function loadPersisted() {
    var anchorRaw = readRaw(ANCHOR_STORAGE_KEY);
    if (anchorRaw) {
      try {
        var parsedAnchor = JSON.parse(anchorRaw);
        if (parsedAnchor && typeof parsedAnchor.left === 'number' && typeof parsedAnchor.top === 'number') {
          state.anchor = { left: parsedAnchor.left, top: parsedAnchor.top };
        }
      } catch (error) {
        // 脏数据：回落默认（不加锚点），不删键、不影响其它键
        reportError('anchor-json', error);
      }
    }
    state.lastSessionId = readRaw(SESSION_STORAGE_KEY) || null;
    // 读不成功也算"读过"：写入凭证防的是"读失败后写空覆盖"，不是"永远不写"
    loadedOnce = true;
  }

  function persist(key, value) {
    if (!loadedOnce) return;                              // 写入凭证
    pendingWrites[key] = value;
    if (writeTimer) return;
    writeTimer = setTimeout(flushWrites, STORAGE_WRITE_DEBOUNCE_MS);
  }

  function flushWrites() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    Object.keys(pendingWrites).forEach(function (key) {
      var value = pendingWrites[key];
      delete pendingWrites[key];
      try { storage.write(key, value); }
      catch (error) { reportError('write:' + key, error); }
    });
  }

  function handlePageExit() { flushWrites(); }

  return {
    readRaw: readRaw,
    loadPersisted: loadPersisted,
    persist: persist,
    flushWrites: flushWrites,
    handlePageExit: handlePageExit
  };
}
