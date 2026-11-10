// 加群表单的「值」层（store/add-form.js）与选项投影（format/driver-view.js）。
//
// 为什么单测这两层：它们是"值显分离"的落点——选项只能是 {id,label}，值只能在 addForm；
// 一旦有人把字段塞回选项，主题就会重新耦合（这正是本次返工的原因）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const DRIVER_VIEW_SOURCE = await fs.readFile(new URL('../ui/js/format/driver-view.js', import.meta.url), 'utf8');
const ADD_FORM_SOURCE = await fs.readFile(new URL('../ui/js/store/add-form.js', import.meta.url), 'utf8');

const DRIVERS = [
  { id: 'openai-compatible', name: 'OpenAI 兼容（配置型）', authSchema: [] },
  { id: 'reverse-qoder', name: 'Qoder', authKind: 'reverse-account', platformId: 'qoder', authSchema: [] },
];
const PLATFORMS = [
  { id: 'agnes', name: 'Agnes', driverId: 'openai-compatible', baseURL: 'https://api.agnes-ai.cn/v1', modelsEndpoint: '/models' },
];

function loadDriverView() {
  return new Function(`${DRIVER_VIEW_SOURCE}\n;return { listGroupOptions: listGroupOptions };`)();
}

test('选项投影：只有 id 与 label，不携带任何数据字段', () => {
  const { listGroupOptions } = loadDriverView();
  const options = listGroupOptions(DRIVERS, PLATFORMS);
  assert.deepEqual(options, [
    { id: 'preset:agnes', label: 'Agnes' },
    { id: 'driver:openai-compatible', label: 'OpenAI 兼容（配置型）' },
    { id: 'driver:reverse-qoder', label: 'Qoder' },
  ]);
  for (const option of options) {
    assert.deepEqual(Object.keys(option).sort(), ['id', 'label'], '选项只允许 id/label 两个键');
  }
});

test('选项投影：平台在前、驱动在后（预置是某平台的一组默认值，通用入口始终可选）', () => {
  const { listGroupOptions } = loadDriverView();
  const options = listGroupOptions(DRIVERS, PLATFORMS);
  assert.equal(options[0].id.startsWith('preset:'), true);
  assert.equal(options[1].id.startsWith('driver:'), true);
});

test('选项投影：空输入返回空数组（不抛）', () => {
  const { listGroupOptions } = loadDriverView();
  assert.deepEqual(listGroupOptions(undefined, undefined), []);
  assert.deepEqual(listGroupOptions([], []), []);
});

test('分层契约：选项层没有值字段，值层持有 addForm 与三个动作', () => {
  assert.equal(/initialValues|advancedField/.test(DRIVER_VIEW_SOURCE), false, 'driver-view 不许出现表单值字段');
  for (const actionName of ['selectGroupOption', 'probeAddForm', 'submitAddGroup']) {
    assert.match(ADD_FORM_SOURCE, new RegExp(`function ${actionName}\\(`), `add-form 应实现 ${actionName}`);
  }
  assert.match(ADD_FORM_SOURCE, /createAddFormState/, 'add-form 提供表单初态工厂');
  // 账号型平台不给"手填目录路径"这一项（④ 的落点）
  assert.match(ADD_FORM_SOURCE, /var advancedField = accountDriver \? null :/, '账号型必须置空 advancedField');
});

test('主题不再持有这些字段名（值显分离的硬判据）', async () => {
  const themeSource = await fs.readFile(new URL('../ui/themes/tim.tsx', import.meta.url), 'utf8');
  for (const fieldName of ['baseURL', 'modelsEndpoint', 'driverId']) {
    assert.equal(themeSource.includes(fieldName), false, `主题源码里不许出现 ${fieldName}`);
  }
});
