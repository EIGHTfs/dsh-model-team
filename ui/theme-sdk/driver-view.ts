// driver-view.ts —— 驱动元数据展示口径的**转调层**（实现住在宿主 ui/js/format/driver-view.js）。
//
// 主题不该认识认证字段名或认证类型字面量：那些是内部命名，写进主题就等于把内部结构变成契约。
// 这里只提供"问结果"的三个函数，exports 名保持稳定。

export interface DriverCredentialField {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  required?: unknown;
  placeholder?: unknown;
  options?: unknown;
}

export interface DriverMetaLike {
  id?: unknown;
  name?: unknown;
  authKind?: unknown;
  platformId?: unknown;
  authSchema?: unknown;
}

interface HostDriverView {
  isAccountAuthDriver(driver: DriverMetaLike | null): boolean;
  credentialFieldsOf(driver: DriverMetaLike | null): DriverCredentialField[];
  driverDisplayName(driver: DriverMetaLike | null): string;
}

const hostDriverView = (): HostDriverView => {
  const host = (globalThis as { dshHostDriverView?: HostDriverView }).dshHostDriverView;
  if (!host) throw new Error('宿主驱动展示口径未加载：ui/js/format/driver-view.js 必须先于主题执行');
  return host;
};

/** 账号型驱动（凭据是账号引用）→ true；配置型（API Key 字段）→ false */
export const isAccountAuthDriver = (driver: DriverMetaLike | null): boolean => hostDriverView().isAccountAuthDriver(driver);

/** 需要渲染的凭证字段（已按可渲染类型过滤） */
export const credentialFieldsOf = (driver: DriverMetaLike | null): DriverCredentialField[] => hostDriverView().credentialFieldsOf(driver);

/** 驱动展示名（给用户看的名字，不是内部 id） */
export const driverDisplayName = (driver: DriverMetaLike | null): string => hostDriverView().driverDisplayName(driver);
