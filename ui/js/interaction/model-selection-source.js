// model-selection-source.js —— 「宿主当前会话选中了哪个模型」的**唯一取值入口**（适配层）。
//
// 为什么要有这一层：宿主换版本时投影通道的名字/形状会变（实测 0.2.2 里
// `session.projections.faceOf(...)` 已经不存在，而重构前的老路径又能取到值），
// 取值细节一旦散落在桥里，每次升级都要改判定逻辑。这里只做「探测哪条通道可用」，
// 上层（session-bridge）只拿到统一的 { getSnapshot, subscribe } 或 null。
//
// 返回形状（拿不到就是 null，调用方按"判不了"处理，**不猜**）：
//   { channel: '<通道名>', getSnapshot(): value, subscribe(cb): unsubscribe }
//
// 通道优先级（命中即用，并打一次性日志 [dock-source] channel=<name>，便于以后版本诊断）：
//   1 useProjection-face   props.useProjection('modelSelection') → face（有 getSnapshot/subscribe）
//   2 session-face         props.session.projections.faceOf('modelSelection') → face
//   3 props-value          props.modelSelection 直接是值（无订阅）
//   4 session-snapshot     props.session.getSnapshot().modelSelection（值裹在 session 快照里）
//   5 都没有               → null + 一次性 warn（不抛）

var MODEL_SELECTION_KEY = "modelSelection";

// 一次性日志：同一通道只在首次命中时打一行，避免每帧刷屏
var reportedModelSelectionChannel = null;

function reportModelSelectionChannel(channel) {
  if (channel === reportedModelSelectionChannel) return;
  reportedModelSelectionChannel = channel;
  try {
    console.info("[dock-source] channel=" + channel);
  } catch (logError) { /* 没有 console 的环境不影响取值 */ }
}

// face 判定：必须同时有取值与订阅才算"可订阅面"，否则退化成"值通道"
function isProjectionFace(candidate) {
  return Boolean(candidate)
    && typeof candidate.getSnapshot === "function"
    && typeof candidate.subscribe === "function";
}

// 值通道：只给一次快照，订阅是 noop（宿主不通知，只能靠下次渲染再取）
function createValueSource(channel, value) {
  return {
    channel: channel,
    getSnapshot: function () { return value; },
    subscribe: function () { return function () {}; },
  };
}

function createFaceSource(channel, face) {
  return {
    channel: channel,
    getSnapshot: function () {
      try {
        return face.getSnapshot();
      } catch (snapshotError) {
        return undefined;
      }
    },
    subscribe: function (listener) {
      try {
        var unsubscribe = face.subscribe(listener);
        return typeof unsubscribe === "function" ? unsubscribe : function () {};
      } catch (subscribeError) {
        return function () {};
      }
    },
  };
}

// 安全取 session：props.session 可能是对象、也可能是 getter
function readSession(props) {
  try {
    return props && props.session ? props.session : null;
  } catch (sessionError) {
    return null;
  }
}

/**
 * 探测本次挂载能用的模型选择通道。
 * @param {object} props 宿主槽位传下来的 props（不修改它）
 * @returns {{channel: string, getSnapshot: Function, subscribe: Function}|null}
 */
function resolveModelSelectionSource(props) {
  var sourceProps = props || {};

  // ① props.useProjection：老宿主给的是 hook，新宿主可能给 face 或直接给值
  if (typeof sourceProps.useProjection === "function") {
    var projected;
    try {
      projected = sourceProps.useProjection(MODEL_SELECTION_KEY);
    } catch (projectionError) {
      projected = undefined;
    }
    if (isProjectionFace(projected)) {
      reportModelSelectionChannel("useProjection-face");
      return createFaceSource("useProjection-face", projected);
    }
    // hook 存在但只给了值（或还没值）：仍然算"通道可用"，值可能稍后才到
    if (projected !== undefined) {
      reportModelSelectionChannel("useProjection-value");
      return createValueSource("useProjection-value", projected);
    }
  }

  // ② 老宿主：session.projections.faceOf(key)（0.2.2-rc.1 实测已无此结构）
  var session = readSession(sourceProps);
  var projections = session && session.projections;
  if (projections && typeof projections.faceOf === "function") {
    var face;
    try {
      face = projections.faceOf(MODEL_SELECTION_KEY);
    } catch (faceError) {
      face = null;
    }
    if (isProjectionFace(face)) {
      reportModelSelectionChannel("session-face");
      return createFaceSource("session-face", face);
    }
  }

  // ③ 直接传值：props.modelSelection
  if (sourceProps.modelSelection !== undefined) {
    reportModelSelectionChannel("props-value");
    return createValueSource("props-value", sourceProps.modelSelection);
  }

  // ④ 值裹在会话快照里：session.getSnapshot().modelSelection
  if (session && typeof session.getSnapshot === "function") {
    var snapshot;
    try {
      snapshot = session.getSnapshot();
    } catch (snapshotReadError) {
      snapshot = null;
    }
    if (snapshot && snapshot.modelSelection !== undefined) {
      reportModelSelectionChannel("session-snapshot");
      return createValueSource("session-snapshot", snapshot.modelSelection);
    }
  }

  // ⑤ 一条都不通：不抛、不定判定，交给上层按 degraded 处理
  if (reportedModelSelectionChannel !== "none") {
    reportedModelSelectionChannel = "none";
    try {
      console.warn("[dock-source] channel=none（宿主未提供任何可用的模型选择通道）");
    } catch (logError) { /* 忽略 */ }
  }
  return null;
}
