// 反代账号模式：平台契约常量与形状校验（纯数据，无 IO、无网络）。
//
// 为什么单独成文件：平台注册表、驱动薄壳、文档示例都要引用同一份"一个平台必须提供什么"，
// 各自抄一遍必然漂移（文档说五项、代码只查三项，漏的那项在运行期才炸）。

// 对外注册名的命名空间前缀：驱动 id 一律 `reverse-<平台id>`。
// **两个空间**：平台内部 id（`qoder`）与宿主驱动 id（`reverse-qoder`）；换算只在 reverse/index.js 一处做。
export const REVERSE_DRIVER_PREFIX = 'reverse-';

// 一个平台对象必须带的字段（自描述注册：元数据全在平台目录的 index.js 里，框架按注册表驱动）
export const requiredPlatformFields = Object.freeze([
  'id',
  'driverId',
  'endpoints',
  'capabilities',
  'createPlatform',
]);

// 身份判据（铁律 4）：判重键只能是服务端下发的稳定字段。
//
// 明确**不参与判重**的三类值：
//   · machine_id / machine_type —— 客户端随机生成的设备指纹，只用于 Cosy-* 设备身份头族；
//   · access_token —— 每次续期都会轮换；
//   · device_mid 等其它客户端随机值。
// 它们参与判重会把"同一个账号换了台设备"当成新账号，进而重复入库、重复领取额度。
export const IDENTITY_POLICY = Object.freeze({
  identityField: 'user_id',
  identitySource: 'GET /api/v1/userinfo 的 user_id（服务端下发）',
  notIdentityFields: Object.freeze(['machine_id', 'machine_type', 'access_token', 'device_mid']),
});

function fail(message) {
  throw new TypeError(message);
}

// 形状校验：一次只报第一个问题，但每个问题都有独立文案（便于单测逐条钉）。
// 校验顺序刻意"根因优先"：先 id / driverId 前缀（裸 id 撞名是最难查的一类错），
// 再报其它字段缺失——否则一个裸 id 的夹具会先报"缺 endpoints"，把真正的病因盖住。
export function assertPlatformShape(platform) {
  if (typeof platform !== 'object' || platform === null || Array.isArray(platform)) {
    fail('平台注册项必须是对象');
  }
  if (typeof platform.id !== 'string' || platform.id.length === 0) {
    fail('平台的 id 必须是非空字符串');
  }
  if (typeof platform.driverId !== 'string' || platform.driverId.length === 0) {
    fail(`平台 ${platform.id} 缺 driverId`);
  }
  if (!platform.driverId.startsWith(REVERSE_DRIVER_PREFIX)) {
    fail(`平台 ${platform.id} 的 driverId 必须以 ${REVERSE_DRIVER_PREFIX} 开头（实际：${platform.driverId}）`);
  }
  if (platform.driverId !== `${REVERSE_DRIVER_PREFIX}${platform.id}`) {
    fail(`平台 ${platform.id} 的 driverId 与 id 不匹配（期望 ${REVERSE_DRIVER_PREFIX}${platform.id}，实际 ${platform.driverId}）`);
  }
  if (typeof platform.createPlatform !== 'function') {
    fail(`平台 ${platform.id} 缺 createPlatform`);
  }
  if (typeof platform.endpoints !== 'object' || platform.endpoints === null) {
    fail(`平台 ${platform.id} 的 endpoints 必须是对象`);
  }
  if (typeof platform.capabilities !== 'object' || platform.capabilities === null) {
    fail(`平台 ${platform.id} 的 capabilities 必须是对象`);
  }
  // 其余必填字段（endpoints/capabilities/createPlatform 已单独校验，这里只补漏）
  for (const fieldName of requiredPlatformFields) {
    if (platform[fieldName] === undefined || platform[fieldName] === null) {
      fail(`平台 ${platform.id} 缺字段：${fieldName}`);
    }
  }
  return platform;
}
