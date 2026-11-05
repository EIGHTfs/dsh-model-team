// 查询参数解析：groupId（聊天流按群隔离）与 limit（历史条数上限）。
// 抽出来是因为两个端点共用同一套"空值按不传处理"的口径，放在路由文件里会让它超长。

// groupId：去空白后为空按"不传"处理；兼容别名 group
export function parseGroupId(incomingRequest) {
  const requestUrl = new URL(incomingRequest.url ?? '/', 'http://localhost');
  const rawGroupId = requestUrl.searchParams.get('groupId') ?? requestUrl.searchParams.get('group');
  const trimmedGroupId = rawGroupId === null ? '' : rawGroupId.trim();
  return trimmedGroupId.length > 0 ? trimmedGroupId : null;
}

// limit：只接受非负整数，其它按"不限制"处理
export function parseLimit(incomingRequest) {
  const requestUrl = new URL(incomingRequest.url ?? '/', 'http://localhost');
  const rawLimit = requestUrl.searchParams.get('limit');
  if (rawLimit === null) {
    return null;
  }
  const parsedLimit = Number(rawLimit);
  return Number.isInteger(parsedLimit) && parsedLimit >= 0 ? parsedLimit : null;
}
