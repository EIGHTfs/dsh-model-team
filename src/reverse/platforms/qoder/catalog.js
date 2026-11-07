// Qoder 模型目录：目录 key ↔ 展示名（纯数据 + 纯函数，M1 不联网）。
//
// 事实（docs/16 §二.6）：厂商目录里有两个 key —— `qfmodel` / `dmodel`；
// 公开的 `/model/v1/chat/completions` 只认通用模型名，直接发目录 key 会 `Unsupported model`。
//
// 「未知不编造」（铁律 9）：厂商没有公开这两个 key 的展示名，所以 displayName 字段**留空**，
// 展示时回落到 key 本身；等实测到真实展示名再回填，不要在代码里猜一个好听的名字。

// 目录项：key 必填；displayName 未实测到就留 null
export const CATALOG_ENTRIES = Object.freeze([
  { key: 'qfmodel', displayName: null, note: '目录 key；厂商未公开展示名' },
  { key: 'dmodel', displayName: null, note: '目录 key；厂商未公开展示名' },
]);

const CATALOG_KEYS = Object.freeze(CATALOG_ENTRIES.map((entry) => entry.key));

export function listCatalogKeys() {
  return [...CATALOG_KEYS];
}

export function isKnownCatalogKey(catalogKey) {
  return CATALOG_KEYS.includes(catalogKey);
}

// 展示名：实测到就用实测值，否则回落 key（禁止编造）
export function displayNameFor(catalogKey) {
  const matched = CATALOG_ENTRIES.find((entry) => entry.key === catalogKey);
  if (!matched) return null;
  return matched.displayName ?? matched.key;
}

// 目录 key → 公开接口可用的模型名映射（M1 只提供"显式登记"的入口；未登记返回 null，由调用方报错）
const PUBLIC_MODEL_NAME_BY_CATALOG_KEY = new Map();

export function registerPublicModelName(catalogKey, publicModelName) {
  if (!isKnownCatalogKey(catalogKey)) throw new TypeError(`未知目录 key：${catalogKey}`);
  if (typeof publicModelName !== 'string' || publicModelName.trim().length === 0) {
    throw new TypeError('publicModelName 必须是非空字符串');
  }
  PUBLIC_MODEL_NAME_BY_CATALOG_KEY.set(catalogKey, publicModelName.trim());
}

export function publicModelNameFor(catalogKey) {
  return PUBLIC_MODEL_NAME_BY_CATALOG_KEY.get(catalogKey) ?? null;
}
