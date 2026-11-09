// avatar-chain.js —— 头像/图标的四级回退（docs/03 §10.4.1、docs/04 §二点五）。
//
// 输入是**已决议的候选数组**（平台/群声明，服务端已把本地路径转成 data: URI）；
// 本文件只决定"这一格画什么"，不认识任何平台、不猜路径、不内置图标。
//
// 四级：
//   ① http(s):// / data:  → <img>（onerror 换下一个候选，不显示裂图）
//   ② 多个候选依次尝试，先成功先赢（不并行、不等网络超时）
//   ③ 文本（1~2 字符）→ 文本头像
//   ④ 都没有 → 名称首字符大写，再没有 → "?"

var AVATAR_TEXT_MAX_LENGTH = 2;

function isAvatarImageValue(value) {
  var text = String(value == null ? '' : value).trim();
  return /^https?:\/\//i.test(text) || /^data:/i.test(text);
}

function avatarInitial(fallbackName) {
  var initial = String(fallbackName == null ? '' : fallbackName).trim().charAt(0).toUpperCase();
  return initial || '?';
}

function normalizeAvatarCandidates(icons) {
  var list = Array.isArray(icons) ? icons : (icons == null ? [] : [icons]);
  var candidates = [];
  for (var index = 0; index < list.length; index += 1) {
    var candidate = String(list[index] == null ? '' : list[index]).trim();
    if (candidate.length > 0 && candidates.indexOf(candidate) < 0) candidates.push(candidate);
  }
  return candidates;
}

// 从候选链里取"这一格该画什么"：图片 → 文本 → 首字符
function buildAvatarView(icons, fallbackName) {
  var candidates = normalizeAvatarCandidates(icons);
  var fallbackText = avatarInitial(fallbackName);
  for (var index = 0; index < candidates.length; index += 1) {
    var candidate = candidates[index];
    if (isAvatarImageValue(candidate)) {
      return { kind: 'image', src: candidate, rest: candidates.slice(index + 1), fallbackText: fallbackText };
    }
    return { kind: 'text', text: candidate.slice(0, AVATAR_TEXT_MAX_LENGTH), rest: [], fallbackText: fallbackText };
  }
  return { kind: 'text', text: fallbackText, rest: [], fallbackText: fallbackText };
}

// 图片加载失败后取下一格：先挑剩下的图片候选，遇到文本候选就换成文本，都没有就首字符
function nextAvatarView(rest, fallbackText) {
  var candidates = normalizeAvatarCandidates(rest);
  var fallback = String(fallbackText == null ? '' : fallbackText).trim() || '?';
  for (var index = 0; index < candidates.length; index += 1) {
    var candidate = candidates[index];
    if (isAvatarImageValue(candidate)) {
      return { kind: 'image', src: candidate, rest: candidates.slice(index + 1), fallbackText: fallback };
    }
    return { kind: 'text', text: candidate.slice(0, AVATAR_TEXT_MAX_LENGTH), rest: [], fallbackText: fallback };
  }
  return { kind: 'text', text: fallback, rest: [], fallbackText: fallback };
}

// 宿主侧：图片加载失败 → 换下一个候选（捕获阶段监听，覆盖后插入的节点）。
// 为什么不用内联 onerror：内联 handler 会被 CSP 拦；为什么不用逐节点绑定：列表重渲染后要重绑。
function installAvatarErrorFallback() {
  if (typeof document === "undefined" || document.__avatarFallbackInstalled) return;
  document.__avatarFallbackInstalled = true;
  document.addEventListener("error", function (event) {
    var imageNode = event.target;
    if (!imageNode || imageNode.tagName !== "IMG" || !imageNode.hasAttribute("data-avatar-rest")) return;
    var rest = [];
    try { rest = JSON.parse(imageNode.getAttribute("data-avatar-rest") || "[]"); } catch (parseError) { rest = []; }
    var nextView = nextAvatarView(rest, imageNode.getAttribute("data-fallback"));
    if (nextView.kind === "image") {
      imageNode.setAttribute("data-avatar-rest", JSON.stringify(nextView.rest));
      imageNode.src = nextView.src;
      return;
    }
    var textNode = document.createElement("span");
    textNode.className = "avatar-text";
    textNode.textContent = nextView.text || nextView.fallbackText;
    imageNode.replaceWith(textNode);
  }, true);
}

// 主题 SDK 转调入口（主题不复制这套规则）
if (typeof globalThis !== 'undefined') {
  globalThis.dshHostAvatar = {
    isAvatarImageValue: isAvatarImageValue,
    avatarInitial: avatarInitial,
    buildAvatarView: buildAvatarView,
    nextAvatarView: nextAvatarView,
  };
}
