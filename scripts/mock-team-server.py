#!/usr/bin/env python3
"""本地假后端：给 ui/ 的设计稿与插件客户端提供 /_team/* 的固定假数据。

用途
    - 不启动真实 DSH 网关时，也能打开 ui/index.html 或注入 lib/client.js 看渲染与交互；
    - 假数据的形状与真实接口一致（分组列表 / 群友 / 请求行 / 会话事件 / 全局统计 / 目标），
      前端改字段或改排序逻辑时可以用它做回归自检。

用法
    python3 scripts/mock-team-server.py                # 默认 http://127.0.0.1:8766
    python3 scripts/mock-team-server.py --port 8899    # 换端口
    python3 scripts/mock-team-server.py --host 0.0.0.0 # 允许局域网访问（真机联调）

行为要点
    - GET  /_team/*  返回固定假数据；静态路径按仓库根目录提供（/ 返回一个空白宿主页）；
    - PUT  /_team/session/<id>/target 会往 EXTRA_EVENTS 追加一条 system 事件，
      模拟真实后端"切换目标即落事件"，用于验证前端不在本地拼文案（刷新前后逐字一致）；
    - 零第三方依赖，只用 Python 标准库。
"""
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

# 仓库根目录 = 本脚本的上一级，不写死任何本机绝对路径
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SESSION_ID = "session-00000000-0000-4000-8000-000000000000"

# PUT target 时追加的 system 事件（进程内存态，重启即清空）
EXTRA_EVENTS = []

BASE_EVENTS = [
    {"type": "self-message", "text": "@glm-5.3-flash 帮我看看", "at": "2026-11-01T19:46:00.000Z"},
    {"type": "system", "text": "已切换当前会话模型为 glm-5.3-flash", "at": "2026-11-01T19:46:30.000Z"},
    {"type": "system", "text": "已切换路由至：DeepSeek-高可用组（策略：轮询）", "at": "2026-11-01T19:52:00.000Z"},
]

GROUPS = [
    {
        "id": "agnes",
        "name": "agnes(1a2b3c4d)",
        "avatar": "[A]",
        "summary": "限速 60/min · 余 12 credit",
        "lastUpdated": "2026-11-02T11:20:00.000Z",
    },
    {
        "id": "codearts",
        "name": "codearts(9f8e7d6c)",
        "avatar": "[C]",
        "summary": "5h 12/60 · 余额 $3.2",
        "lastUpdated": "2026-11-01T08:30:00.000Z",
    },
]

MODELS_BY_GROUP = {
    "agnes": [
        {"id": "global:glm-5.3-flash", "name": "glm-5.3-flash"},
        {"id": "global:deepseek-v4.1-flash", "name": "deepseek-v4.1-flash"},
    ],
    "codearts": [{"id": "global:deepseek-v3", "name": "deepseek-v3"}],
}

FRIEND_GROUPS = [
    {
        "id": "ds-high-avail",
        "name": "DeepSeek-高可用组",
        "strategy": "round-robin",
        "cursor": 1,
        "members": [
            {"platformId": "agnes", "modelId": "deepseek-v3"},
            {"platformId": "codearts", "modelId": "deepseek-v3"},
        ],
    },
    {
        "id": "claude-frugal",
        "name": "Claude-省钱组",
        "strategy": "fallback",
        "cursor": 0,
        "members": [
            {"platformId": "agnes", "modelId": "claude-3.7-sonnet"},
            {"platformId": "codearts", "modelId": "claude-3.5-haiku"},
        ],
    },
]

# 平台预置：形状等同 GET /_team/platforms（图标/基址都用示例域名，方便验证 URL 头像）
PLATFORMS = [
    {
        "id": "agnes",
        "name": "Agnes",
        "avatar": "https://cdn.example.com/logo-agnes.svg",
        "baseURL": "https://api.example.com/agnes/v1",
        "modelsEndpoint": "/models",
        "homepage": "https://example.com",
        "summaryTemplate": "官方接入 · {baseURL}",
        "driverId": "agnes",
    },
    {
        "id": "codearts",
        "name": "CodeArts (华为云)",
        "avatar": "[C]",
        "baseURL": "https://api.example.com/codearts/v1",
        "modelsEndpoint": "/models",
        "homepage": "https://example.com",
        "summaryTemplate": "官方接入 · {baseURL}",
        "driverId": "codearts",
    },
]

DRIVERS = [
    {
        "id": "agnes",
        "name": "Agnes",
        "avatar": "[A]",
        "authSchema": [
            {"key": "baseURL", "label": "接口地址", "type": "text"},
            {"key": "apiKey", "label": "API Key", "type": "password"},
        ],
    },
    {
        "id": "codearts",
        "name": "CodeArts (华为云)",
        "avatar": "[C]",
        "authSchema": [{"key": "apiKey", "label": "API Key", "type": "password"}],
    },
]

SESSION_ROWS = [
    {
        "model": "glm-5.3-flash",
        "status": 200,
        "statusText": "成功",
        "time": "03:47:12",
        "latency": "8.42s",
        "tokens": "96.3k",
        "completionTokens": 9,
        "latencySeconds": 4.56,
        "credit": "0.31",
        "cacheHit": "92.4%",
        "ip": "192.0.2.10",
        "ua": "dsh/0.2.1",
        "requestId": "req-1",
        "title": "请求 1",
    },
    {
        "model": "deepseek-v3",
        "status": 200,
        "statusText": "成功",
        "time": "03:50:06",
        "latency": "4.56s",
        "tokens": "40.3k",
        "completionTokens": 9,
        "latencySeconds": 4.56,
        "credit": "0.52",
        "cacheHit": "99.1%",
        "ip": "192.0.2.11",
        "ua": "dsh/0.2.1",
        "requestId": "req-2",
        "title": "请求 2",
    },
]

CURRENT_TARGET = {"type": "model", "id": "global:glm-5.3-flash", "platformId": "agnes"}

# 按会话返回不同目标：用于验证「进群聊默认显示该会话目标所属群」（契约条款 25）
# 新出参（契约 docs/19 §三）：target 是本会话显式绑定的，effectiveTarget 是实际生效的
TARGET_BY_SESSION = {
    "session-two": {
        "target": {"type": "model", "id": "global:deepseek-v3", "platformId": "codearts"},
        "effectiveTarget": {"type": "model", "id": "global:deepseek-v3", "platformId": "codearts"},
        "targetSource": "explicit",
    },
    "session-inherit": {
        "target": None,
        "effectiveTarget": {"type": "model", "id": "global:glm-5.3-flash", "platformId": "agnes"},
        "targetSource": "last-session",
    },
    "session-group": {
        "target": {"type": "group", "id": "ds-high-avail"},
        "effectiveTarget": {"type": "group", "id": "ds-high-avail"},
        "targetSource": "explicit",
    },
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/_team/groups":
            return self._json({"groups": GROUPS})
        if path.startswith("/_team/groups/") and path.endswith("/models"):
            group_id = path[len("/_team/groups/"):-len("/models")]
            return self._json({"models": MODELS_BY_GROUP.get(group_id, [])})
        if path == "/_team/friend-groups":
            return self._json({"groups": FRIEND_GROUPS})
        if path == "/_team/platforms":
            return self._json({"platforms": PLATFORMS})
        if path == "/_team/drivers":
            return self._json({"drivers": DRIVERS})
        if path == "/_team/sessions/current":
            return self._json({"sessionId": SESSION_ID, "activeAt": "2026-11-02T11:01:08.013Z"})
        if path.startswith("/_team/session/") and path.endswith("/target"):
            session_key = path.split("/")[3]
            preset = TARGET_BY_SESSION.get(session_key)
            if preset:
                return self._json(preset)
            return self._json({
                "target": CURRENT_TARGET,
                "effectiveTarget": CURRENT_TARGET,
                "targetSource": "explicit",
            })
        if path == "/_team/session/" + SESSION_ID + "/events":
            return self._json({"events": BASE_EVENTS + EXTRA_EVENTS})
        if path == "/_team/stats/session/" + SESSION_ID:
            return self._json({"rows": SESSION_ROWS})
        if path == "/_team/stats/global":
            return self._json({"totalRows": 12, "totalTokens": 345000, "cacheHitPercent": 96.2})
        if path.startswith("/_team/"):
            return self._json({"ok": True})
        return self._static()

    def do_POST(self):
        return self._json({"ok": True})

    def do_PUT(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = {}
        target_type = body.get("type") or "group"
        target_id = body.get("id") or "ds-high-avail"
        if target_type == "model":
            text = "你 @ 了 %s 并切换了当前会话模型" % str(target_id).replace("global:", "")
        else:
            text = "已切换路由至：%s（策略：轮询）" % target_id
        EXTRA_EVENTS.append({"type": "system", "text": text, "at": "2026-11-02T12:00:00.000Z"})
        return self._json({"target": body})

    def _json(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self):
        path = self.path.split("?")[0]
        if path == "/":
            body = (
                b"<!doctype html><html><head><meta charset=\"utf-8\"><title>model-team harness</title>"
                b"</head><body><h1>model-team harness</h1></body></html>"
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        target = os.path.join(ROOT, path.lstrip("/"))
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            self.send_response(404)
            self.end_headers()
            return
        with open(target, "rb") as handle:
            body = handle.read()
        self.send_response(200)
        if target.endswith(".js"):
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
        elif target.endswith(".css"):
            self.send_header("Content-Type", "text/css; charset=utf-8")
        else:
            self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        return


def main():
    parser = argparse.ArgumentParser(description="模型团队本地假后端")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    parser.add_argument("--port", type=int, default=8766, help="监听端口（默认 8766）")
    args = parser.parse_args()
    print("mock backend: http://%s:%d/  (root=%s)" % (args.host, args.port, ROOT))
    HTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
