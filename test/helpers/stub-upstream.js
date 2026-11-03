// 本地假上游：用 node:http 起真实 HTTP 服务，让驱动走真实 fetch 打真实端口。
// 目的：鉴权头、字段改写、usage 解析、非 2xx 分支都能在不碰外网、不用真实 Key 的前提下断言。

import http from 'node:http';

// 路由键形如 'GET /v1/models'；未命中时回落 '*' 处理器（用于"任何请求都返回 500"这类用例）
export async function startStubUpstream({ routes = {} } = {}) {
  const requests = [];

  const server = http.createServer((incomingRequest, outgoingResponse) => {
    const bodyChunks = [];
    incomingRequest.on('data', (chunk) => {
      bodyChunks.push(chunk);
    });
    incomingRequest.on('end', () => {
      const bodyText = Buffer.concat(bodyChunks).toString('utf8');
      const pathname = (incomingRequest.url ?? '').split('?')[0];
      requests.push({
        method: incomingRequest.method,
        url: incomingRequest.url,
        pathname,
        headers: incomingRequest.headers,
        bodyText,
      });

      const routeHandler = routes[`${incomingRequest.method} ${pathname}`] ?? routes['*'];
      if (!routeHandler) {
        writeJson(outgoingResponse, 404, { error: { message: '未配置的 stub 路由' } });
        return;
      }
      routeHandler({ incomingRequest, outgoingResponse, bodyText, requests });
    });
  });

  await new Promise((resolveListener, rejectListener) => {
    server.once('error', rejectListener);
    server.listen(0, '127.0.0.1', resolveListener);
  });

  const listeningPort = server.address().port;
  return {
    origin: `http://127.0.0.1:${listeningPort}`,
    baseURL: `http://127.0.0.1:${listeningPort}/v1`,
    requests,
    close() {
      // 主动断开残留连接：有的用例故意让上游"不回响应"，只 server.close() 会一直等这些 socket
      server.closeAllConnections?.();
      return new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

// 统一写 JSON 响应，避免每个用例重复三行
export function writeJson(outgoingResponse, statusCode, payload, extraHeaders = {}) {
  const serializedPayload = JSON.stringify(payload);
  outgoingResponse.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(serializedPayload),
    ...extraHeaders,
  });
  outgoingResponse.end(serializedPayload);
}
