// Qoder WASM 的 wasm-bindgen ABI 桥（低层：实例化 + 内存/字符串/对象堆 + 调用约定）。
//
// 桥接实现改编自 dsh-providers-hub（MIT, Copyright (c) 2026 Jet）的 qoder-wasm.js——
// 它的头注释把三类会静默炸掉的坑记全了，这里保留结论、删掉与本项目无关的解密/搜索部分：
//   1. 两个 `getRandomValues` import 的签名**方向相反**：一个写 wasm 内存、一个调 JS 对象；
//      写反会得到 Rust panic `unreachable`。
//   2. 返回值布局有**两套**：字符串类是 `ptr/len/valIdx/isErr`，
//      `qodercontext_new` / `prepareInferRequest` 是 `ptr/errIdx/isErr`；混用会 `null pointer passed to rust`。
//   3. `requestresult_url(栈指针, ptr)` 参数顺序与直觉相反（栈指针在前）。
// 另一条硬约束：wasm 对象**必须配对释放**（`__wbg_*_free` 与返回串的 `__wbindgen_export4(ptr,len,1)`），
// 否则进程级 wasm 堆只增不减，长会话最终 trap 成一句裸 `unreachable`。

import fs from 'node:fs';

export const IMPORT_MODULE = './qoder_auth_wasm_bg.js';
// 与客户端一致的版本号：服务端会看这个字段
export const COSY_VERSION = '1.1.49';

// 进程级单例：按 wasm 文件路径缓存（WASM 实例无状态，可复用；重新实例化很贵）
const glueByPath = new Map();

// V8 对 wasm `unreachable` 的裸报文不含任何上下文，这里改写成可排查的说法
export function describeWasmFailure(error) {
  if (!(error instanceof Error) || error.name !== 'RuntimeError') return error;
  if (error.message.trim() !== 'unreachable') return error;
  const wrapped = new Error('Qoder WASM 内部 trap（unreachable）：多为 wasm 堆耗尽或参数布局不匹配；请重试，持续出现则重启宿主');
  wrapped.cause = error;
  return wrapped;
}

// 内存访问器：heap/view 都按当前 exports.memory 惰性重建（wasm 增长后旧视图会失效）
function createMemoryAccessors(readExports) {
  let cachedHeap = null;
  let cachedView = null;
  const heap = () => {
    if (cachedHeap === null || cachedHeap.byteLength === 0) cachedHeap = new Uint8Array(readExports().memory.buffer);
    return cachedHeap;
  };
  const view = () => {
    if (cachedView === null || cachedView.buffer !== readExports().memory.buffer) cachedView = new DataView(readExports().memory.buffer);
    return cachedView;
  };
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
  const encoder = new TextEncoder();
  const readString = (ptr, len) => decoder.decode(heap().subarray(ptr >>> 0, (ptr >>> 0) + len));
  let lastLength = 0;
  const writeString = (text) => {
    const encoded = encoder.encode(text);
    const ptr = readExports().__wbindgen_export2(encoded.length, 1) >>> 0;
    heap().subarray(ptr, ptr + encoded.length).set(encoded);
    lastLength = encoded.length;
    return ptr;
  };
  return { heap, view, readString, writeString, lastLength: () => lastLength };
}

// 对象堆：与官方一致（1024 个 undefined + 四个哨兵 undefined/null/true/false）
function createObjectHeap() {
  const objects = new Array(1024).fill(undefined);
  objects.push(undefined, null, true, false);
  let firstFreeIndex = objects.length;
  const heapObject = (index) => objects[index];
  const pushObject = (objectValue) => {
    if (firstFreeIndex === objects.length) objects.push(objects.length + 1);
    const index = firstFreeIndex;
    firstFreeIndex = objects[index];
    objects[index] = objectValue;
    return index;
  };
  const takeObject = (index) => {
    const objectValue = heapObject(index);
    // 索引 < 1028 是哨兵，不可回收
    if (index >= 1028) {
      objects[index] = firstFreeIndex;
      firstFreeIndex = index;
    }
    return objectValue;
  };
  return { heapObject, pushObject, takeObject };
}

// 调用约定：字符串类返回值 ptr/len/valIdx/isErr；对象类 ptr/errIdx/isErr
function createAbiCalls({ readExports, memory, takeObject }) {
  const callString = (invoke) => {
    let outPtr = 0;
    let outLen = 0;
    const wasmExports = readExports();
    const stack = wasmExports.__wbindgen_add_to_stack_pointer(-16);
    try {
      invoke(stack);
      const dataView = memory.view();
      outPtr = dataView.getInt32(stack + 0, true);
      outLen = dataView.getInt32(stack + 4, true);
      const isError = dataView.getInt32(stack + 12, true);
      if (isError) throw takeObject(dataView.getInt32(stack + 8, true));
      return memory.readString(outPtr, outLen);
    } catch (error) {
      throw describeWasmFailure(error);
    } finally {
      wasmExports.__wbindgen_add_to_stack_pointer(16);
      if (outPtr) wasmExports.__wbindgen_export4(outPtr, outLen, 1);
    }
  };

  const callPointer = (invoke) => {
    const wasmExports = readExports();
    const stack = wasmExports.__wbindgen_add_to_stack_pointer(-16);
    try {
      invoke(stack);
      const dataView = memory.view();
      const ptr = dataView.getInt32(stack + 0, true);
      const isError = dataView.getInt32(stack + 8, true);
      if (isError) throw takeObject(dataView.getInt32(stack + 4, true));
      return ptr;
    } catch (error) {
      throw describeWasmFailure(error);
    } finally {
      wasmExports.__wbindgen_add_to_stack_pointer(16);
    }
  };

  // 释放 Rust 对象：arity 2（ptr, 0）；指针 0 表示"无对象"
  const freePointer = (exportName, ptr) => {
    if (ptr === 0) return;
    try {
      readExports()[exportName](ptr, 0);
    } catch (error) {
      throw describeWasmFailure(error);
    }
  };

  // 释放 wasm-bindgen 返回的字符串：arity 3（ptr, len, 1）——与 freePointer 是两套 ABI
  const freeString = (ptr, len) => {
    if (ptr === 0) return;
    try {
      readExports().__wbindgen_export4(ptr, len, 1);
    } catch (error) {
      throw describeWasmFailure(error);
    }
  };

  return { callString, callPointer, freePointer, freeString };
}

// wasm 期望的 JS 侧 import：Crypto/process/对象堆/类型判定等
function createImports({ readExports, memory, objectHeap, wasmModule }) {
  const { heapObject, pushObject, takeObject } = objectHeap;
  const guard = (invoke, args) => {
    try {
      invoke(...args);
    } catch (error) {
      readExports().__wbindgen_export(pushObject(error));
    }
  };
  return {
    __wbindgen_object_drop_ref: (index) => takeObject(index),
    __wbindgen_object_clone_ref: (index) => pushObject(heapObject(index)),
    __wbindgen_cast_0000000000000001: (ptr, len) => pushObject(memory.heap().subarray(ptr >>> 0, (ptr >>> 0) + len)),
    __wbindgen_cast_0000000000000002: (ptr, len) => pushObject(memory.readString(ptr, len)),
    __wbg_set_08463b1df38a7e29: (target, key, value) => pushObject(heapObject(target).set(heapObject(key), heapObject(value))),
    // ⚠️ 两个 getRandomValues 签名方向相反：一个写 wasm 内存，一个调 JS 对象；写反会 Rust panic
    __wbg_getRandomValues_d49329ff89a07af1: (...args) => guard((ptr, len) => {
      globalThis.crypto.getRandomValues(memory.heap().subarray(ptr >>> 0, (ptr >>> 0) + len));
    }, args),
    __wbg_getRandomValues_c44a50d8cfdaebeb: (...args) => guard((target, viewIndex) => {
      heapObject(target).getRandomValues(heapObject(viewIndex));
    }, args),
    __wbg_crypto_38df2bab126b63dc: (index) => pushObject(heapObject(index).crypto),
    __wbg_process_44c7a14e11e9f69e: (index) => pushObject(heapObject(index).process),
    __wbg_versions_276b2795b1c6a219: (index) => pushObject(heapObject(index).versions),
    __wbg_node_84ea875411254db1: (index) => pushObject(heapObject(index).node),
    __wbg_require_b4edbdcf3e2a1ef0: (...args) => guard(() => pushObject(wasmModule), args),
    __wbg_msCrypto_bd5a034af96bcba6: (index) => pushObject(heapObject(index).msCrypto),
    __wbg_randomFillSync_6c25eac9869eb53c: (...args) => guard((target, argsIndex) => {
      heapObject(target).randomFillSync(takeObject(argsIndex));
    }, args),
    __wbg_call_d578befcc3145dee: (...args) => guard((functionIndex, selfIndex, argIndex) => {
      pushObject(heapObject(functionIndex).call(heapObject(selfIndex), heapObject(argIndex)));
    }, args),
    __wbg_new_with_length_9cedd08484b73942: (length) => pushObject(new Uint8Array(length >>> 0)),
    __wbg_length_0c32cb8543c8e4c8: (index) => heapObject(index).length,
    __wbg_prototypesetcall_3e05eb9545565046: (ptr, len, sourceIndex) => {
      Uint8Array.prototype.set.call(memory.heap().subarray(ptr >>> 0, (ptr >>> 0) + len), heapObject(sourceIndex));
    },
    __wbg_subarray_0f98d3fb634508ad: (index, start, end) => pushObject(heapObject(index).subarray(start >>> 0, end >>> 0)),
    __wbg_new_99cabae501c0a8a0: () => pushObject(new Map()),
    __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
    __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => pushObject(globalThis),
    __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => pushObject(globalThis),
    __wbg_static_accessor_SELF_24f78b6d23f286ea: () => (globalThis.self === undefined ? 0 : pushObject(globalThis.self)),
    __wbg_static_accessor_WINDOW_59fd959c540fe405: () => (globalThis.window === undefined ? 0 : pushObject(globalThis.window)),
    __wbg___wbindgen_throw_81fc77679af83bc6: (ptr, len) => {
      throw new Error(memory.readString(ptr, len));
    },
    __wbg_Error_2e59b1b37a9a34c3: (ptr, len) => pushObject(new Error(memory.readString(ptr, len))),
    __wbg___wbindgen_is_object_40c5a80572e8f9d3: (index) => {
      const objectValue = heapObject(index);
      return typeof objectValue === 'object' && objectValue !== null;
    },
    __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (index) => typeof heapObject(index) === 'string',
    __wbg___wbindgen_is_function_49868bde5eb1e745: (index) => typeof heapObject(index) === 'function',
    __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (index) => heapObject(index) === undefined,
  };
}

async function createGlue(wasmPath) {
  const wasmModule = await WebAssembly.compile(fs.readFileSync(wasmPath));
  let wasmExports = {};
  const readExports = () => wasmExports;
  const memory = createMemoryAccessors(readExports);
  const objectHeap = createObjectHeap();
  const imports = createImports({ readExports, memory, objectHeap, wasmModule });
  const instance = await WebAssembly.instantiate(wasmModule, { [IMPORT_MODULE]: imports });
  wasmExports = instance.exports;
  const calls = createAbiCalls({ readExports, memory, takeObject: objectHeap.takeObject });

  return {
    exports: wasmExports,
    heap: memory.heap,
    view: memory.view,
    readString: memory.readString,
    writeString: memory.writeString,
    lastLength: memory.lastLength,
    heapObject: objectHeap.heapObject,
    pushObject: objectHeap.pushObject,
    takeObject: objectHeap.takeObject,
    ...calls,
  };
}

// 按路径取（或建立）进程级单例
export function loadGlue(wasmPath) {
  const cached = glueByPath.get(wasmPath);
  if (cached) return cached;
  const pending = createGlue(wasmPath).catch((error) => {
    // 失败不缓存：文件可能随后被补上（用户自备 wasm 的典型路径）
    glueByPath.delete(wasmPath);
    throw describeWasmFailure(error);
  });
  glueByPath.set(wasmPath, pending);
  return pending;
}
