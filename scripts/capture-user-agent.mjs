#!/usr/bin/env node
// capture-user-agent.mjs —— 抓「我们发往上游的 User-Agent」的取证工具（手动跑，默认不参与门禁）。
//
// 为什么需要：UA 是否真的是我们自设的，靠读代码推不出来——只有让插件真的打一次上游、
// 把收到的头抓下来才算证据（本项目已在此误判过两次：一次怀疑被宿主覆盖，一次漏了 forward 模式）。
//
// 用法（不写死任何端口/路径，全部走参数）：
//   node scripts/capture-user-agent.mjs --port 31999
//   然后把这个地址配到一个群：baseURL = http://127.0.0.1:<port>/v1，模型随便（本工具总回同一份模型列表）
//   抓到的每条请求会以 JSON Lines 打到 stdout（含 method / path / user-agent / 关键头）
//
//   --port <n>        监听端口（必填；0 表示由系统分配，启动后会打印实际端口）
//   --out <file>      把命中记录同时写入该文件（JSON Lines）
//   --once            收到第一条请求后自动退出（适合在脚本里串一次性验证）
//   --timeout <ms>    最长等待时间，到点退出（默认 60000，仅本工具的等待，不是产品行为）
//   --path-prefix <p> 只记录该前缀的请求（默认记录全部）
//
// 判据示例（rewrite 路径应看到我们自己的 UA）：
//   {"method":"POST","path":"/v1/chat/completions","userAgent":"dsh-model-team/0.3.1", ...}

import http from 'node:http';
import fs from 'node:fs';
import process from 'node:process';

const DEFAULT_WAIT_LIMIT_MS = 60_000;

function parseArgs(argv) {
  const args = { port: null, out: '', once: false, timeoutMs: DEFAULT_WAIT_LIMIT_MS, pathPrefix: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--port' && next) { args.port = Number(next); index += 1; }
    else if (flag === '--out' && next) { args.out = next; index += 1; }
    else if (flag === '--once') { args.once = true; }
    else if (flag === '--timeout' && next) { args.timeoutMs = Number(next); index += 1; }
    else if (flag === '--path-prefix' && next) { args.pathPrefix = next; index += 1; }
  }
  return args;
}

// 回一份最小可用模型列表：让插件"获取可用模型/校验"能通过，从而走到真正的推理请求
function writeModelsResponse(response) {
  const payload = JSON.stringify({ object: 'list', data: [{ id: 'echo-model', object: 'model', owned_by: 'echo' }] });
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

// 回一个最小的 SSE 完成流：让流式路径能正常收尾（否则插件会等到超时）
function writeStreamResponse(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const chunk = {
    id: 'echo-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
  };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.port === null || !Number.isFinite(args.port) || args.port < 0) {
    console.error('用法：node scripts/capture-user-agent.mjs --port <端口> [--out <文件>] [--once] [--timeout <ms>]');
    console.error('  提示：--port 0 表示由系统分配，启动后会打印实际端口');
    return 2;
  }

  let hitCount = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (part) => chunks.push(part));
    request.on('end', () => {
      const path = String(request.url || '');
      const matched = !args.pathPrefix || path.startsWith(args.pathPrefix);
      if (matched) {
        hitCount += 1;
        const record = {
          at: new Date().toISOString(),
          method: request.method,
          path,
          userAgent: request.headers['user-agent'] ?? null,
          contentType: request.headers['content-type'] ?? null,
          accept: request.headers.accept ?? null,
          bodyBytes: Buffer.concat(chunks).length,
        };
        const line = JSON.stringify(record);
        console.log(line);
        if (args.out) {
          try { fs.appendFileSync(args.out, `${line}\n`); } catch (writeError) { console.error(`写入 --out 失败：${writeError.message}`); }
        }
        if (args.once) {
          // 先把响应写回去，再退出：否则插件侧会看到连接被掐断
          setTimeout(() => { server.close(); process.exit(0); }, 50);
        }
      }

      // 统一按路径给最小响应，保证插件侧"请求能正常收尾"
      if (path.includes('/models')) writeModelsResponse(response);
      else if (path.includes('/chat/completions')) writeStreamResponse(response);
      else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      }
    });
  });

  server.listen(args.port, '127.0.0.1', () => {
    const address = server.address();
    console.error(`[capture-user-agent] 监听 http://127.0.0.1:${address.port}`);
    console.error('[capture-user-agent] 把它配成一个群的 baseURL：http://127.0.0.1:' + address.port + '/v1');
    console.error(`[capture-user-agent] 最长等待 ${args.timeoutMs}ms，命中 ${hitCount} 条`);
  });

  const stopTimer = setTimeout(() => {
    console.error(`[capture-user-agent] 等待到期限（${args.timeoutMs}ms），共命中 ${hitCount} 条`);
    server.close();
    process.exit(hitCount > 0 ? 0 : 1);
  }, args.timeoutMs);
  stopTimer.unref?.();
}

main();
