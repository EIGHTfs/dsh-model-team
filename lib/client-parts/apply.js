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
    // 拿不到槽位就拿不到 session 作用域，也就判不了 INV-14。
    // 按契约：判不了就隐藏（「宁可少显示，也不把不属于本插件的入口摆给用户」）。
    // 历史：这里一度「降级为显示」，理由是"不比现状差"——那与契约冲突，
    //      表现为任何模型下都挂着一个球，属于虚假入口。
    applyDockVisibility(false);
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
    applyDockVisibility(false);   // 槽位注册失败 = 判不了 INV-14 → 隐藏（契约口径，不是降级显示）
    fetchSessionOnce();
  }
}

exports.apply = apply;
exports.inject = ["slots"];
return module.exports;
  }
});
