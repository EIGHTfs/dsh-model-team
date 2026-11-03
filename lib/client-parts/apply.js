// apply.js —— 入口：ctx.effect 挂载悬浮球；槽位桥把宿主 sessionId 灌进工厂（零轮询，契约 docs/13 §4.3）。
function apply(ctx) {
  ctx.effect(function () {
    try {
      var mounted = mountDock();
      return function () {
        try { mounted.dispose(); } catch (error) { warnOnce("dock dispose", error); }
      };
    } catch (error) {
      warnOnce("dock mount", error);
      return function () {};
    }
  }, "dsh-model-team: dock");

  // 槽位注册必须发生在 client 插件入口（这里能拿到 ctx），纯 DOM 分片拿不到 ctx
  var slotsReady = ctx && ctx.slots && typeof ctx.slots.inject === "function";
  if (!slotsReady) {
    // 没有槽位就拿不到 session 作用域，也就判不了 INV-14：降级为显示（不比现状差）
    applyDockVisibility(true);
    fetchSessionOnce();          // 宿主不提供 slots：一次性兜底，绝不轮询
    return;
  }
  try {
    // 会话作用域槽位：宿主 renderSlot("conversation.input.dock", { session, input }) 带 session；
    // shell.overlay 的 props 是空对象，拿不到 sessionId（真机实测）。
    ctx.slots.inject("conversation.input.dock", function () {
      return ctx.slots.register(
        {
          name: "conversation.input.dock",
          id: "dsh-model-team-session-bridge",
          order: 999          // 排到最后，避免插到宿主自己的 dock 前面
        },
        createSessionBridgeComponent(require("react"))
      );
    });
  } catch (error) {
    warnOnce("session bridge slot", error);
    applyDockVisibility(true);   // 槽位注册失败：降级为显示，避免球永远不出现
    fetchSessionOnce();
  }
}

exports.apply = apply;
exports.inject = ["slots"];
return module.exports;
  }
});
