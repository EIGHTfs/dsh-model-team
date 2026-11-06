#!/usr/bin/env node
// 反代账号登录 CLI（给用户自己实测用，零依赖）。
//
// 用法：
//   node scripts/reverse-login.mjs --platform qoder
//   node scripts/reverse-login.mjs --platform qoder --data-root <路径>   # 指定数据根（默认 getDataRoot()）
//   node scripts/reverse-login.mjs --platform qoder --no-open             # 不尝试自动打开浏览器
//
// 设计要点：
//   · 授权参数全在 URL 里（PKCE challenge / nonce / machine_id / client_id），**不需要用户手输任何码**；
//   · 先打印 URL 一行，再尝试自动打开（NAS/SSH 常常没有 opener，用户可以把 URL 复制到手机/Windows 上打开）；
//   · 打开失败不报错（只是打不开浏览器，URL 已经在屏幕上）；
//   · 全程**不打印 token**：只打印 userId / nickname 与落盘路径。

import { execFile } from 'node:child_process';
import path from 'node:path';

import { getDataRoot } from '../src/gateway/config/paths.js';
import { createAccountStore } from '../src/gateway/reverse/account-store.js';
import { createLoginSessionManager, LOGIN_STATUS } from '../src/gateway/reverse/login-session.js';
import { getPlatform } from '../src/gateway/reverse/index.js';

const OPEN_COMMANDS = [
  { command: 'xdg-open', args: (url) => [url] },        // Linux / NAS
  { command: 'open', args: (url) => [url] },            // macOS
  { command: 'cmd', args: (url) => ['/c', 'start', '', url] }, // Windows
];

function parseArgs(argv) {
  const options = { platform: null, dataRoot: null, open: true };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--platform') { options.platform = argv[index + 1]; index += 1; }
    else if (token === '--data-root') { options.dataRoot = argv[index + 1]; index += 1; }
    else if (token === '--no-open') options.open = false;
  }
  return options;
}

// 依次尝试打开器；任一成功即返回 true。失败不抛（NAS 上常常没有 xdg-open）
function tryOpenBrowser(url) {
  return new Promise((resolve) => {
    const attempt = (commandIndex) => {
      if (commandIndex >= OPEN_COMMANDS.length) { resolve(false); return; }
      const { command, args } = OPEN_COMMANDS[commandIndex];
      try {
        execFile(command, args(url), { timeout: 5000 }, (error) => {
          if (error) attempt(commandIndex + 1);
          else resolve(true);
        });
      } catch {
        attempt(commandIndex + 1);
      }
    };
    attempt(0);
  });
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function describeError(error) {
  if (!error) return '未知错误';
  if (error.code === 'REVERSE_LOGIN_POLL_FAILED') return `登录服务异常：${error.message}`;
  if (error.code === 'REVERSE_LOGIN_USERINFO_FAILED') return `取用户信息失败：${error.message}`;
  return error.message ?? String(error);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.platform) {
    console.error('用法：node scripts/reverse-login.mjs --platform qoder [--data-root <路径>] [--no-open]');
    return 2;
  }
  const platform = getPlatform(options.platform);
  if (!platform) {
    console.error(`未知平台：${options.platform}（可用：qoder）`);
    return 2;
  }

  const dataRoot = options.dataRoot ? path.resolve(options.dataRoot) : getDataRoot();
  const accountStore = createAccountStore({ dataRoot });
  const platformImpl = platform.createPlatform({});

  const sessionManager = createLoginSessionManager({
    startLogin: () => platformImpl.startDeviceLogin({}),
    pollLogin: (pollContext) => platformImpl.pollDeviceLogin({ pollContext, fetchImpl: globalThis.fetch }),
    timeoutMs: platform.login.timeoutMs,
  });

  const started = await sessionManager.start();

  // 顺序很重要：先给 URL（用户随时可复制），再尝试打开，再进入等待
  console.log(`授权链接：${started.loginUrl}`);
  if (options.open) {
    const opened = await tryOpenBrowser(started.loginUrl);
    console.log(opened ? '已尝试用默认浏览器打开（若没弹出，请复制上面的链接手动打开）' : '没有可用的浏览器打开器，请复制上面的链接自行打开');
  }
  console.log(`正在等待你在浏览器里完成授权…（最长 ${Math.round((platform.login.timeoutMs ?? 0) / 1000)} 秒，每 ${started.intervalMs / 1000} 秒检查一次，Ctrl+C 可取消）`);

  for (;;) {
    let pollResult;
    try {
      pollResult = await sessionManager.poll(started.sessionId);
    } catch (error) {
      console.error(`❌ 登录失败：${describeError(error)}`);
      return 1;
    }

    if (pollResult.status === LOGIN_STATUS.GRANTED) {
      let saved;
      try {
        saved = await accountStore.upsertByUserId(platform.id, pollResult.credential);
      } catch (error) {
        console.error(`❌ 凭据保存失败：${error?.message ?? error}`);
        return 1;
      }
      const nickname = pollResult.credential.nickname ? `（${pollResult.credential.nickname}）` : '';
      const accountLabel = pollResult.credential.userId ?? '(无 userId，已按新账号保存)';
      console.log(`✅ 已保存账号 ${accountLabel}${nickname}`);
      console.log(`   落盘：${saved.filePath}`);
      console.log(`   账号 id：${saved.accountId}（${saved.merged ? '更新已有账号' : '新增账号'}）`);
      return 0;
    }
    if (pollResult.status === LOGIN_STATUS.EXPIRED) {
      console.error('❌ 登录等待已超时，请重新发起登录');
      return 1;
    }
    if (pollResult.status === LOGIN_STATUS.CANCELLED) {
      console.error('❌ 登录已取消');
      return 1;
    }
    await sleep(started.intervalMs);
  }
}

// Ctrl+C：等价于取消（会话状态留在进程内，退出即可）
process.on('SIGINT', () => {
  console.error('\n❌ 已取消登录');
  process.exit(130);
});

process.exit(await main());
