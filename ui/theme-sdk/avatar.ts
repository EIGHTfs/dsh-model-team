// avatar.ts —— 头像四级回退的**转调层**（实现住在宿主 ui/js/format/avatar-chain.js）。
//
// 主题不复制这套规则：候选链由服务端决议，回退顺序（图片→文本→首字符）属于契约，
// 两套主题必须一致，所以只保留一处实现。

export interface AvatarView {
  kind: 'image' | 'text';
  src?: string;
  text?: string;
  rest: string[];
  fallbackText: string;
}

interface HostAvatar {
  isAvatarImageValue(value: unknown): boolean;
  avatarInitial(fallbackName: unknown): string;
  buildAvatarView(icons: unknown, fallbackName: unknown): AvatarView;
  nextAvatarView(rest: unknown, fallbackText: unknown): AvatarView;
}

const hostAvatar = (): HostAvatar => {
  const host = (globalThis as { dshHostAvatar?: HostAvatar }).dshHostAvatar;
  if (!host) throw new Error('宿主头像回退实现未加载：ui/js/format/avatar-chain.js 必须先于主题执行');
  return host;
};

/** 这一格该画什么（图片 / 文本 / 首字符） */
export const buildAvatarView = (icons: unknown, fallbackName: unknown): AvatarView => hostAvatar().buildAvatarView(icons, fallbackName);

/** 图片加载失败后取下一格 */
export const nextAvatarView = (rest: unknown, fallbackText: unknown): AvatarView => hostAvatar().nextAvatarView(rest, fallbackText);

/** 名称首字符（大写，没有则 "?"） */
export const avatarInitial = (fallbackName: unknown): string => hostAvatar().avatarInitial(fallbackName);
