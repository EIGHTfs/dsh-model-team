// 首字判据单测（docs/02 §5.1）：流式转发时"哪一片算第一片内容"决定了速率的解码段起点。
// 判错两个方向都有代价：把 role 开场白算成首字 → 首字等待被算进解码段（速率偏低）；
// 迟迟不认内容 → 解码段变短（速率虚高）。所以这里把各种分片形状逐条钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { carriesFirstToken } from '../src/gateway/mapping.js';

// 分片构造器：只组装被测函数关心的形状，避免每条用例重复抄嵌套结构
function chunkWithDelta(delta) {
  return { id: 'chunk-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] };
}

test('只带 role 的开场分片不算首字', () => {
  assert.equal(carriesFirstToken(chunkWithDelta({ role: 'assistant' })), false);
  // 空 delta（上游偶尔会发心跳式空片）同样不算
  assert.equal(carriesFirstToken(chunkWithDelta({})), false);
});

test('内容为空串的占位分片不算首字，非空才算', () => {
  const emptyContent = '';
  const realContent = '你';
  assert.equal(carriesFirstToken(chunkWithDelta({ content: emptyContent })), false);
  assert.equal(carriesFirstToken(chunkWithDelta({ content: realContent })), true);
});

test('推理内容（reasoning_content）也算首字：思考模型先出这一段', () => {
  assert.equal(carriesFirstToken(chunkWithDelta({ reasoning_content: '想' })), true);
  assert.equal(carriesFirstToken(chunkWithDelta({ reasoning_content: '' })), false);
});

test('工具调用分片算首字（数组非空），空数组不算', () => {
  const toolCall = { index: 0, id: 'call-1', function: { name: 'lookup' } };
  assert.equal(carriesFirstToken(chunkWithDelta({ tool_calls: [toolCall] })), true);
  assert.equal(carriesFirstToken(chunkWithDelta({ tool_calls: [] })), false);
});

test('缺少 choices / delta 的载荷一律不算（含结束标记与错误体）', () => {
  assert.equal(carriesFirstToken(null), false);
  assert.equal(carriesFirstToken({}), false);
  assert.equal(carriesFirstToken({ choices: [] }), false);
  assert.equal(carriesFirstToken({ choices: [{ index: 0 }] }), false);
  // 上游的错误体没有 content 字段，不能被误判成"已出字"
  assert.equal(carriesFirstToken({ error: { message: 'upstream failed' } }), false);
});

test('同一条流里多次出现内容分片：函数本身无状态，调用方负责只记第一次', () => {
  const firstPiece = chunkWithDelta({ content: 'A' });
  const secondPiece = chunkWithDelta({ content: 'B' });
  assert.equal(carriesFirstToken(firstPiece), true);
  assert.equal(carriesFirstToken(secondPiece), true, '每片都返回 true，去重是调用方的事');
});
