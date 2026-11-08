// 建群成功后的收尾行为：**以服务端为唯一真相**，不在本地拼群对象。
//
// 事故背景（实测）：反代群走「驱动通用入口」，没有平台预置 → selectedPlatform 为 null；
// 旧实现成功后读 selectedPlatform.id 直接抛错，而群**已经建成**。
// 结果：界面显示「添加失败」，用户重试，列表里出现重复群（qoder1 / qoder1-2）。
//
// 这类"已成功却显示失败"的问题只有把「成功后的动作」钉死才防得住，所以这里对源码做结构断言：
//   1) 成功回调里不得出现 groups.push(...)（本地乐观插入）
//   2) 不得再依赖 selectedPlatform（平台预置概念，反代路径没有）
//   3) 必须触发一次群列表重取

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

const adminSource = await fsp.readFile(new URL('../ui/js/view/admin.js', import.meta.url), 'utf8');

// 取出 applyCreatedGroup 的函数体（从函数名到下一个顶层注释/函数前的粗粒度切片）
function extractApplyCreatedGroup(source) {
  const start = source.indexOf('function applyCreatedGroup(');
  assert.notEqual(start, -1, 'applyCreatedGroup 必须存在（建群成功后的唯一收尾处）');
  const nextFunction = source.indexOf('\nfunction ', start + 1);
  const sliceEnd = nextFunction === -1 ? source.length : nextFunction;
  return source.slice(start, sliceEnd);
}

test('建群成功后不再在本地插入群对象（以服务端为准）', () => {
  const body = extractApplyCreatedGroup(adminSource);
  assert.equal(/groups\s*\.\s*push\s*\(/.test(body), false, '不得本地 push 群对象：会造成本地草稿与服务端分叉');
});

test('建群成功回调不依赖「平台预置」概念（反代路径没有它）', () => {
  const body = extractApplyCreatedGroup(adminSource);
  assert.equal(/selectedPlatform/.test(body), false, '不得读 selectedPlatform：通用驱动入口下它是 null');
  assert.equal(/newGroup/.test(body), false, '不得再用本地草稿拼结果');
});

test('建群成功后必须重取群列表', () => {
  const body = extractApplyCreatedGroup(adminSource);
  assert.equal(/store\.loadGroups/.test(body), true, '成功回调要重新拉群列表，服务端数据才是唯一真相');
});

test('列表刷新失败不能反过来报「添加失败」', () => {
  const body = extractApplyCreatedGroup(adminSource);
  assert.equal(/群已创建/.test(body), true, '刷新失败要说明「群已创建」，不能误导用户重复提交');
});
