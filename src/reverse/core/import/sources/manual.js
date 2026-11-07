// 导入源：手动 JSON（用户直接给一段 JSON 字符串/对象）。
//
// 这是"没有宿主服务、也不想跑登录流程"时的兜底来源。字段缺失一律明确报错并列出缺哪些，
// 绝不"尽量拼一个能跑的凭据"——缺 machine 三件套的请求会被服务端静默降级。

const REQUIRED_FIELDS = Object.freeze(['accessToken', 'machineId', 'machineToken', 'machineType']);
const FIELD_ALIASES = Object.freeze({
  accessToken: ['accessToken', 'access_token'],
  refreshToken: ['refreshToken', 'refresh_token'],
  userId: ['userId', 'user_id'],
  nickname: ['nickname', 'name'],
  machineId: ['machineId', 'machine_id'],
  machineToken: ['machineToken', 'machine_token'],
  machineType: ['machineType', 'machine_type'],
});

function readField(payload, fieldName) {
  for (const alias of FIELD_ALIASES[fieldName]) {
    const value = payload?.[alias];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

export const source = {
  id: 'manual',
  name: '手动 JSON',
  platforms: [],

  async isAvailable() {
    return true;
  },

  async resolve({ ref } = {}) {
    let payload = ref;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        const parseError = new Error('manual 源需要 JSON 字符串或对象（解析失败）');
        parseError.code = 'reverse-import-invalid-credential';
        throw parseError;
      }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const shapeError = new Error('manual 源需要对象形式的凭据 JSON');
      shapeError.code = 'reverse-import-invalid-credential';
      throw shapeError;
    }

    const credential = {};
    for (const fieldName of Object.keys(FIELD_ALIASES)) {
      const value = readField(payload, fieldName);
      if (value !== null) credential[fieldName] = value;
    }

    const missingFields = REQUIRED_FIELDS.filter((fieldName) => typeof credential[fieldName] !== 'string');
    if (missingFields.length > 0) {
      const missingError = new Error(`凭据缺少必填字段：${missingFields.join('、')}`);
      missingError.code = 'reverse-import-invalid-credential';
      missingError.missingFields = missingFields;
      throw missingError;
    }
    return credential;
  },
};
