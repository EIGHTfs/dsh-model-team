// download.js —— "把一段文本存成文件"的**端口**（浏览器能力，可注入、可测）。
//
// 为什么单独一层并作为注入端口：
//   ① 主题只该渲染与调动作，不该碰 Blob / a.click()（那是浏览器副作用，不是显示）；
//   ② store 层的动作要可单测——测试里注入一个记录调用的桩，就不会真的触发下载；
//   ③ 下载实现只有一处，将来换实现（如改文件名规则）不用动 store 与主题。
//
// 约定：调用方给"文件名 + 文本"，本函数只负责落盘，返回 { fileName, bytes } 供界面显示。

function downloadTextFile(fileName, text) {
  var safeName = typeof fileName === 'string' && fileName.length > 0 ? fileName : 'download.json';
  var safeText = typeof text === 'string' ? text : String(text == null ? '' : text);
  var bytes = safeText.length;
  // 非浏览器环境（单测/SSR）：不抛错，直接把结果交回，调用方据此断言
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    return { fileName: safeName, bytes: bytes };
  }
  var blob = new Blob([safeText], { type: 'application/json' });
  var objectUrl = URL.createObjectURL(blob);
  var anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = safeName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻释放会让部分浏览器拿不到内容，推迟到本轮事件循环之后
  setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 0);
  return { fileName: safeName, bytes: bytes };
}

if (typeof globalThis !== 'undefined') {
  globalThis.dshHostDownload = { downloadTextFile: downloadTextFile };
}
