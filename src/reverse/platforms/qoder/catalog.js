// Qoder 模型目录：**运行时从上游拉取**（不再有任何写死的模型名）。
//
// 事实（已核对参考实现 qoder_proxy.py:336 / 3099-3116 / 3122-3138）：
//   · 路径 `/algo/api/v2/model/list?Encode=1`，主机同 endpoints.inferBase（CN 为 gateway.qoder.com.cn）；
//   · 方法 **GET，但必须带 body**：裸 GET 会 403。body 与"签名 body"是同一串：qoderEncode('{}')；
//   · 头族走 COSY（与推理同一套：authorization / machine 三件 / cosy-date / cosy-key 等签名）；
//   · accept 是 application/json（`sse=False` 语义：不要 text/event-stream，也不要 cache-control: no-cache）；
//   · 响应是明文 JSON，模型在 `payload.chat[]`：`key` 是标识、`display_name` 是展示名，其它字段原样保留。
//
// 缓存：进程内 TTL（默认 10 分钟）+ 可选落盘 `<dataRoot>/reverse/<platformId>/catalog.json`（0600，带 fetchedAt）。
// 缓存是"运行期数据"，不是静态清单：过期即重拉；拉取失败**不回落静态表**（不猜测、不编造）。

import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { buildCosyHeaders, qoderEncode, createCosySession, COSY_VERSION } from './crypto/native.js';
import { buildCosyHeaders as buildBasicCosyHeaders, REQUEST_KINDS } from './headers.js';

export const CATALOG_PATH = '/algo/api/v2/model/list?Encode=1';
export const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
export const CATALOG_CACHE_FILE_NAME = 'catalog.json';
export const CATALOG_CACHE_FILE_MODE = 0o600;
export const CATALOG_REQUEST_TIMEOUT_MS = 15_000;
// 版本闸门（参考实测）：client_type=5 时 cosy-version >= 1.1.70 才能拿到全部
export const CATALOG_MIN_COSY_VERSION = '1.1.70';
// 空请求体的明文：签名与发送必须是同一串
const CATALOG_REQUEST_BODY_PLAIN = '{}';

export const CATALOG_ERROR_CODES = Object.freeze({
  // 响应不是明文 JSON（可能是加密体）：不猜、不回落
  UNDECRYPTABLE: 'REVERSE_CATALOG_UNDECRYPTABLE',
  // 上游 HTTP 非 2xx（403 等）：带状态码的明确错误
  UPSTREAM_FAILED: 'REVERSE_CATALOG_UPSTREAM_FAILED',
  // 网络层失败/超时
  REQUEST_FAILED: 'REVERSE_CATALOG_REQUEST_FAILED',
  // 响应结构不对（没有 payload.chat）
  SHAPE_INVALID: 'REVERSE_CATALOG_SHAPE_INVALID',
});

function catalogError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

// 版本比较只要"至少 x.y.z"这一种语义，够用即可
export function isCosyVersionAtLeast(currentVersion, requiredVersion) {
  const parse = (versionText) => String(versionText ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const currentParts = parse(currentVersion);
  const requiredParts = parse(requiredVersion);
  for (let index = 0; index < Math.max(currentParts.length, requiredParts.length); index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const requiredPart = requiredParts[index] ?? 0;
    if (currentPart > requiredPart) return true;
    if (currentPart < requiredPart) return false;
  }
  return true;
}

export function catalogCacheFilePath({ dataRoot, platformId }) {
  return path.join(dataRoot, 'reverse', platformId, CATALOG_CACHE_FILE_NAME);
}

// 默认传输：Node 的 http(s) 原生请求——**fetch 不允许 GET 带 body**（undici 直接抛错），
// 而上游偏偏要求 GET + body，所以这里不能用 fetch。
export function sendCatalogRequest({ url, headers, bodyText, timeoutMs = CATALOG_REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    const transport = requestUrl.protocol === 'http:' ? http : https;
    const request = transport.request({
      protocol: requestUrl.protocol,
      hostname: requestUrl.hostname,
      port: requestUrl.port || undefined,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method: 'GET',
      headers: { ...headers, 'content-length': Buffer.byteLength(bodyText) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, bodyText: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', (responseError) => reject(catalogError(CATALOG_ERROR_CODES.REQUEST_FAILED, `读取上游响应失败：${responseError?.message ?? responseError}`)));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(catalogError(CATALOG_ERROR_CODES.REQUEST_FAILED, `模型目录请求超时（${timeoutMs}ms）`));
    });
    request.on('error', (networkError) => {
      reject(networkError?.code ? networkError : catalogError(CATALOG_ERROR_CODES.REQUEST_FAILED, `模型目录请求失败：${networkError?.message ?? networkError}`));
    });
    // GET 带 body：这是上游协议要求，不写进去会 403
    request.write(bodyText);
    request.end();
  });
}

// 构造一次"模型目录"请求：body 与签名共用同一串，头族与推理同一套（去掉 sse 相关的两个头）
export function buildCatalogRequest({ credential, inferBase, now = Date.now, rng, requestId } = {}) {
  const bodyText = qoderEncode(Buffer.from(CATALOG_REQUEST_BODY_PLAIN, 'utf8'));
  const url = `${String(inferBase).replace(/\/$/, '')}${CATALOG_PATH}`;
  const session = createCosySession({ credential, rng });
  const resolvedRequestId = typeof requestId === 'string' && requestId.length > 0 ? requestId : session?.requestId ?? undefined;
  const signedHeaders = buildCosyHeaders({
    credential,
    bodyText,
    rawUrl: url,
    requestId: resolvedRequestId,
    nowMs: now(),
    session,
  });
  const headers = { ...signedHeaders, accept: 'application/json' };
  // sse=False 语义：不带 cache-control: no-cache（那是给流式响应用的）
  delete headers['cache-control'];
  delete headers['accept-encoding'];
  return { url, headers, bodyText };
}

// 解析上游响应：明文 JSON → 模型项；非 JSON（可能是加密体）→ 明确错误，绝不猜
export function parseCatalogPayload(bodyText) {
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw catalogError(CATALOG_ERROR_CODES.UNDECRYPTABLE, '模型目录响应不是明文 JSON（可能是加密体），无法解析');
  }
  const chatEntries = payload?.chat ?? payload?.data?.chat ?? null;
  if (!Array.isArray(chatEntries)) {
    throw catalogError(CATALOG_ERROR_CODES.SHAPE_INVALID, '模型目录响应缺少 chat 数组');
  }
  const models = [];
  for (const entry of chatEntries) {
    const modelKey = typeof entry?.key === 'string' && entry.key.trim().length > 0 ? entry.key.trim() : null;
    if (!modelKey) continue;
    // 其它字段（price_factor / is_free / enabled / minimal_version …）原样保留，只补 id/name 兼容键
    models.push({
      ...entry,
      id: modelKey,
      name: typeof entry.display_name === 'string' && entry.display_name.length > 0 ? entry.display_name : modelKey,
    });
  }
  return models;
}

// 进程内缓存：key = platformId|accountId（不同账号拿到的目录可能不同）
const memoryCache = new Map();

export function resetCatalogCacheForTest() {
  memoryCache.clear();
}

async function readDiskCache({ dataRoot, platformId, nowMs }) {
  if (!dataRoot) return null;
  try {
    const rawText = await fs.readFile(catalogCacheFilePath({ dataRoot, platformId }), 'utf8');
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed?.models) || typeof parsed?.fetchedAtMs !== 'number') return null;
    if (nowMs - parsed.fetchedAtMs > CATALOG_CACHE_TTL_MS) return null;
    return { models: parsed.models, fetchedAtMs: parsed.fetchedAtMs };
  } catch {
    return null;
  }
}

async function writeDiskCache({ dataRoot, platformId, models, fetchedAtMs }) {
  if (!dataRoot) return;
  const filePath = catalogCacheFilePath({ dataRoot, platformId });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify({ fetchedAtMs, models }, null, 2)}\n`, { encoding: 'utf8', mode: CATALOG_CACHE_FILE_MODE });
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, CATALOG_CACHE_FILE_MODE);
  } catch {
    // 落盘可失败（只读挂载 / 权限）：缓存是增强，内存里仍有效，不影响本次结果
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

/**
 * 拉取远端模型目录（带缓存）。
 * @returns {Promise<{models: Array<object>, fetchedAtMs: number, fromCache: boolean}>}
 */
export async function fetchRemoteCatalog({
  platformId = 'qoder',
  credential,
  endpoints,
  dataRoot,
  logger,
  fetchImpl,
  // 显式声明"这是测试注入的桩"：只有它为 true，或传入的 fetch 不是全局 fetch 时，才走 fetch 分支
  allowFetchImplForCatalog = false,
  now = Date.now,
  ttlMs = CATALOG_CACHE_TTL_MS,
  forceRefresh = false,
} = {}) {
  const nowMs = now();
  const cacheKey = `${platformId}|${credential?.accountId ?? credential?.userId ?? ''}`;

  if (!forceRefresh) {
    const memoryEntry = memoryCache.get(cacheKey);
    if (memoryEntry && nowMs - memoryEntry.fetchedAtMs <= ttlMs) {
      return { models: memoryEntry.models, fetchedAtMs: memoryEntry.fetchedAtMs, fromCache: true };
    }
    const diskEntry = await readDiskCache({ dataRoot, platformId, nowMs });
    if (diskEntry) {
      memoryCache.set(cacheKey, diskEntry);
      return { models: diskEntry.models, fetchedAtMs: diskEntry.fetchedAtMs, fromCache: true };
    }
  }

  if (!isCosyVersionAtLeast(COSY_VERSION, CATALOG_MIN_COSY_VERSION)) {
    logger?.warn?.(`模型目录可能不全：cosy-version ${COSY_VERSION} 低于上游闸门 ${CATALOG_MIN_COSY_VERSION}`);
  }

  const { url, headers, bodyText } = buildCatalogRequest({ credential, inferBase: endpoints.inferBase, now });
  // 为什么不能"有 fetchImpl 就用"：Node 的 fetch（undici）**拒绝 GET 带 body**，
  // 而本接口的协议恰恰要求 GET + body → 会直接抛 TypeError:
  // Request with GET/HEAD method cannot have body → 端点 502。
  // 判据只认**显式开关**：只有测试/排查明确声明"这是桩"（allowFetchImplForCatalog === true）才走 fetch。
  // 不要再用 `fetchImpl !== globalThis.fetch` 这种 identity 判据——被上层包一层的 fetch
  // （例如上下文窗口探测的 createProbeFetch 加超时包装）不是测试桩，却会被误判成桩，
  // 于是把 GET+body 丢给 undici，两个实例都会在启动期刷这个错。
  const useInjectedFetch = typeof fetchImpl === 'function' && allowFetchImplForCatalog === true;
  const response = useInjectedFetch
    ? await fetchImpl(url, { method: 'GET', headers, body: bodyText }).then(async (rawResponse) => ({
      status: rawResponse.status,
      bodyText: await rawResponse.text(),
    }))
    : await sendCatalogRequest({ url, headers, bodyText });

  if (response.status < 200 || response.status >= 300) {
    throw catalogError(
      CATALOG_ERROR_CODES.UPSTREAM_FAILED,
      `模型目录返回 HTTP ${response.status}（GET 不带 body 会被拒绝，这里是带 body 的请求）`,
      { status: response.status },
    );
  }

  const models = parseCatalogPayload(response.bodyText);
  const fetchedAtMs = now();
  memoryCache.set(cacheKey, { models, fetchedAtMs });
  await writeDiskCache({ dataRoot, platformId, models, fetchedAtMs });
  logger?.info?.(`模型目录已刷新：${models.length} 个模型（platform ${platformId}）`);
  return { models, fetchedAtMs, fromCache: false };
}

// 兼容旧调用点：只要清单（不带缓存元数据）
export async function listCatalogModels(options = {}) {
  const { models } = await fetchRemoteCatalog(options);
  return models;
}

// 目录里是否认识某个模型 key（现在按**运行时缓存**判断；未拉取过返回 false，由调用方决定是否先拉）
export function isKnownCatalogKey(catalogKey) {
  if (typeof catalogKey !== 'string' || catalogKey.length === 0) return false;
  for (const entry of memoryCache.values()) {
    if (entry.models.some((model) => model.id === catalogKey)) return true;
  }
  return false;
}

// 展示名：缓存里实测到就用实测值，否则回落 key（禁止编造）
export function displayNameFor(catalogKey) {
  for (const entry of memoryCache.values()) {
    const matched = entry.models.find((model) => model.id === catalogKey);
    if (matched) return matched.name ?? matched.id;
  }
  return null;
}

// 供"探测/列模型"使用的基本头（不含签名）：保留旧导出，避免破坏既有调用方
export function buildCatalogBasicHeaders({ credential } = {}) {
  return buildBasicCosyHeaders({ credential, requestKind: REQUEST_KINDS.chat });
}
