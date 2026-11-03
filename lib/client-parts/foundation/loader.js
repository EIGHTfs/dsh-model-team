// loader.js —— 客户端模块注册头：__ModuleLoader__.load 包装；工厂体内装配后续分片。
// 本文件只是开头，结尾（apply 与 module.exports）在 lib/client-parts/apply.js。
window.__ModuleLoader__.load({
  id: "dsh-model-team",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
