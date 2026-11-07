// 导入源：宿主凭据服务（ctx.credentials.resolve）。
//
// 宿主没有该服务时标记不可用并给出原因——插件照常加载，只是这个来源灰掉。
// 只取 ref 指向的那份值；**日志与回执永不打印值**（只打印 ref 与是否拿到）。

export const source = {
  id: 'host-credentials',
  name: '宿主凭据服务',
  // 空数组 = 通用（任何平台都可以尝试用这个来源取凭据）
  platforms: [],

  async isAvailable({ deps } = {}) {
    const credentials = deps?.credentials;
    return Boolean(credentials) && typeof credentials.resolve === 'function';
  },

  // 列出候选 ref（不含值）：宿主服务支持 list 才有
  async list({ deps } = {}) {
    const credentials = deps?.credentials;
    if (!credentials || typeof credentials.list !== 'function') return [];
    const entries = await credentials.list();
    return Array.isArray(entries) ? entries.map((entry) => ({ ref: String(entry?.ref ?? ''), label: String(entry?.label ?? '') })) : [];
  },

  // 取一份凭据并归一化成本插件的账号字段
  async resolve({ deps, ref } = {}) {
    const credentials = deps?.credentials;
    if (!credentials || typeof credentials.resolve !== 'function') {
      const unavailable = new Error('宿主凭据服务不可用');
      unavailable.code = 'reverse-import-source-unavailable';
      throw unavailable;
    }
    if (typeof ref !== 'string' || ref.length === 0) {
      const missingRef = new Error('宿主凭据源需要 ref（凭据引用名）');
      missingRef.code = 'reverse-import-invalid-credential';
      throw missingRef;
    }

    // 只把 ref 交给宿主；拿回的值不写日志、不回执
    const resolved = await credentials.resolve(ref);
    const value = resolved?.value ?? resolved;
    if (typeof value !== 'string' || value.length === 0) {
      const emptyValue = new Error(`宿主凭据服务没有返回 ${ref} 的值`);
      emptyValue.code = 'reverse-import-invalid-credential';
      throw emptyValue;
    }

    // 值可能是 JSON（含完整账号字段），也可能是单个 token 字符串
    let parsed = null;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object') {
      return {
        accessToken: parsed.accessToken ?? parsed.access_token,
        refreshToken: parsed.refreshToken ?? parsed.refresh_token,
        userId: parsed.userId ?? parsed.user_id,
        nickname: parsed.nickname ?? parsed.name,
        machineId: parsed.machineId ?? parsed.machine_id,
        machineToken: parsed.machineToken ?? parsed.machine_token,
        machineType: parsed.machineType ?? parsed.machine_type,
      };
    }
    // 纯字符串只当 accessToken：其它字段缺失由调用方（账号存储/能力门）明确报错
    return { accessToken: value };
  },
};
