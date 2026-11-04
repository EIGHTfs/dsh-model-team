// image-prefetch.js —— 图片预取：异步把消息里的图片引用变成可直接拼进请求体的 data URL。
//
// 为什么必须"先异步取、再同步拼"：toOpenAiMessages 是纯同步函数（大量既有断言依赖它是同步的），
// 为了图片把整条链改成 async 会波及所有调用方；所以在这里先把图取好放进 Map，序列化时只查表。
//
// 三条实现约束（照官方适配器 llm-pi-ai 的做法，不要自创）：
//   ① 先取"请求版本"（附件服务会按目标尺寸/字节重新编码），拿不到才读原图 —— 大图直接读原图会撑爆请求体
//   ② 单张失败只记 error，不抛错 —— 一张坏图不该让整轮对话失败
//   ③ **空 Map 也要保留**：图片存在但全部读取失败时，空 Map 仍会让序列化产出占位文本；
//      若在这里退化成 undefined，模型会以为"这条消息本来就没有图"，问题更隐蔽

/** 请求版本的目标策略：与官方默认一致（4M 像素 / 1MB 编码字节） */
export const DEFAULT_IMAGE_POLICY = Object.freeze({ maxPixels: 4194304, maxBytes: 1048576 });

/** 从消息里收集图片引用（同一附件多次出现只取一次） */
export function collectImageRefs(messages) {
  const refs = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = message && message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'image') continue;
      if (block.offloaded === true) continue;
      const attachment = block.attachment;
      if (!attachment || typeof attachment.attachmentId !== 'string') continue;
      refs.set(attachment.attachmentId, attachment);
    }
  }
  return refs;
}

/** 是否有图片块（能力门禁要先判断，再决定要不要取图） */
export function messagesHaveImage(messages) {
  return collectImageRefs(messages).size > 0;
}

/** 按 maxPixels 等比缩放目标；源比目标小时保持原尺寸（官方 requestImageDimensions 的语义） */
export function requestImageTarget(ref, policy = DEFAULT_IMAGE_POLICY) {
  const sourceWidth = Number(ref && ref.width) || 0;
  const sourceHeight = Number(ref && ref.height) || 0;
  const maxPixels = Number(policy && policy.maxPixels) || DEFAULT_IMAGE_POLICY.maxPixels;
  const scale = sourceWidth > 0 && sourceHeight > 0
    ? Math.min(1, Math.sqrt(maxPixels / (sourceWidth * sourceHeight)))
    : 1;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    maxBytes: Number(policy && policy.maxBytes) || DEFAULT_IMAGE_POLICY.maxBytes,
  };
}

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  // 理论上只在无 Node 的环境走到；保持可用而不是抛错
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 逐张读取图片，返回 Map<attachmentId, { url } | { error }>。
 * 永远返回 Map（哪怕是空的）；单张失败只写 error，不影响其它张。
 */
export async function resolveImageUrls(messages, options = {}) {
  const attachments = options.attachments;
  const logger = options.logger;
  const signal = options.signal;
  const policy = options.policy || DEFAULT_IMAGE_POLICY;
  const urls = new Map();
  const refs = collectImageRefs(messages);

  for (const [attachmentId, ref] of refs) {
    let version = null;
    try {
      // ① 请求版本（服务端缩放/重编码，能压到目标字节内）
      if (typeof attachments.readImageRequest === 'function') {
        version = await attachments.readImageRequest(ref, requestImageTarget(ref, policy), signal);
      }
    } catch (requestError) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`图片请求版本生成失败，尝试原图：${attachmentId}（${requestError && requestError.message ? requestError.message : requestError}）`);
      }
    }

    if (!version || !version.data) {
      try {
        // ② 原图兜底：服务没有请求版本能力、或该图不需要缩放时走这条
        if (typeof attachments.readImage === 'function') {
          const stored = await attachments.readImage(ref, signal);
          if (stored && stored.data) version = { data: stored.data, mediaType: ref.mediaType, bytes: stored.data.length };
        }
      } catch (readError) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`图片读取失败，已按占位文本发送：${attachmentId}（${readError && readError.message ? readError.message : readError}）`);
        }
      }
    }

    if (!version || !version.data) {
      urls.set(attachmentId, { error: '读取失败' });
      continue;
    }

    const encodedBytes = typeof version.bytes === 'number' ? version.bytes : version.data.length;
    if (encodedBytes > policy.maxBytes) {
      // 不静默丢：写进 Map 让序列化产出占位，模型能看出"这里本来有图"
      urls.set(attachmentId, { error: `图片过大（${encodedBytes} 字节 > ${policy.maxBytes}）` });
      continue;
    }

    const mediaType = version.mediaType || ref.mediaType || 'image/png';
    urls.set(attachmentId, { url: `data:${mediaType};base64,${toBase64(version.data)}` });
  }

  return urls;
}
