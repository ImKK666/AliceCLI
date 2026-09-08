# Alice CLI

[![GitHub Stars](https://img.shields.io/github/stars/ImKK666/AliceCLI?style=flat-square&logo=github&color=yellow)](https://github.com/ImKK666/AliceCLI/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/ImKK666/AliceCLI?style=flat-square&color=orange)](https://github.com/ImKK666/AliceCLI/issues)
[![GitHub License](https://img.shields.io/github/license/ImKK666/AliceCLI?style=flat-square)](https://github.com/ImKK666/AliceCLI/blob/main/LICENSE)
[![Last Commit](https://img.shields.io/github/last-commit/ImKK666/AliceCLI?style=flat-square&color=blue)](https://github.com/ImKK666/AliceCLI/commits/main)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)

> Alice CLI — 终端里的 AI 编程助手，纯 Bun 运行时，支持编译为独立二进制。

Alice CLI 基于 Anthropic Claude Code 逆向工程复原，在此基础上扩展了更多特性，关闭了所有外部管控点。支持多模型供应商（Anthropic / OpenAI / Gemini / Grok），可编译为 macOS / Linux / Windows 独立二进制。

| 特性 | 说明 |
|------|------|
| **独立二进制** | `bun run compile` 编译为 80MB 单文件，无需 Bun/Node.js 运行时 |
| **跨平台编译** | `bun run compile -- --all` 一次编译 5 个平台（macOS arm64/x64, Linux x64/arm64, Windows x64） |
| **多模型供应商** | `/login` 配置 Anthropic / OpenAI / Gemini / Grok 兼容端点 |
| **Remote Control** | Docker 自托管远程控制 Web UI，手机/浏览器操作会话 |
| **Ultracode 工作流** | `/ultracode` 多 Agent 确定性编排 + 监控面板 |
| **ACP 协议** | 接入 Zed、Cursor 等 IDE |
| **Langfuse 监控** | 企业级 Agent 监控 |
| **Web Search** | 内置网页搜索（Bing / Brave） |
| **Voice Mode** | 语音输入，支持豆包语音识别 |
| **Computer Use** | 屏幕截图、键鼠控制 |
| **Chrome Use** | 浏览器自动化 |

## 快速开始

### 方式一：编译二进制（推荐）

```bash
# 克隆 & 安装依赖
git clone https://github.com/ImKK666/AliceCLI.git
cd AliceCLI
bun install

# 编译当前平台二进制
bun run compile

# 安装到系统 PATH
sudo ln -sf $(pwd)/bin/alice /usr/local/bin/alice

# 启动
alice
```

### 方式二：源码开发模式

```bash
bun install
bun run dev    # 开发模式，版本号显示 888
```

### 方式三：npm 安装

```bash
npm i -g alice-cli
alice
```

## 跨平台编译

```bash
# 编译当前平台
bun run compile

# 指定目标平台
bun run compile -- --target=bun-linux-x64

# 编译全部 5 个平台
bun run compile -- --all
```

产物输出到 `bin/` 目录：

| 文件 | 平台 | 大小 |
|------|------|------|
| `bin/alice` | 当前平台 | ~80 MB |
| `bin/alice-darwin-arm64` | macOS Apple Silicon | ~80 MB |
| `bin/alice-darwin-x64` | macOS Intel | ~85 MB |
| `bin/alice-linux-x64` | Linux x64 | ~109 MB |
| `bin/alice-linux-arm64` | Linux ARM64 | ~109 MB |
| `bin/alice-windows-x64.exe` | Windows x64 | ~113 MB |

## 配置

首次运行后输入 `/login`，选择模型供应商：

| 供应商 | 说明 |
|--------|------|
| **Anthropic** | 官方 API，支持 Bedrock / Vertex / Foundry |
| **Anthropic Compatible** | 兼容 API（OpenRouter 等） |
| **OpenAI** | GPT / ChatGPT 协议端点 |
| **Gemini** | Google Gemini API |
| **Grok** | xAI Grok API |

## 构建 & 开发

```bash
bun install              # 安装依赖
bun run dev              # 开发模式
bun run build            # 构建（code splitting → dist/）
bun run compile          # 编译独立二进制（→ bin/）
bun run precheck         # 类型检查 + lint + 测试
bun test                 # 运行测试
```

### Feature Flags

```bash
FEATURE_BUDDY=1 bun run dev         # 启用单个 feature
bun run compile                      # 编译时默认启用 65+ features
```

### VS Code 调试

```bash
bun run dev:inspect    # 启动 inspect 服务
# VS Code → F5 → "Attach to Bun (TUI debug)"
```

## Remote Control Server

```bash
# 启动 RCS（Web UI + API）
RCS_API_KEYS=your-key bun run rcs

# Alice CLI 连接到 RCS
CLAUDE_BRIDGE_BASE_URL=http://localhost:3000 \
CLAUDE_BRIDGE_OAUTH_TOKEN=your-key \
alice remote-control
```

浏览器访问 `http://localhost:3000` 查看 Web 控制面板。

## Star History

<a href="https://www.star-history.com/?repos=ImKK666%2FAliceCLI&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=ImKK666/AliceCLI&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=ImKK666/AliceCLI&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=ImKK666/AliceCLI&type=date&legend=top-left" />
 </picture>
</a>

## 致谢

- [doubaoime-asr](https://github.com/starccy/doubaoime-asr) — 豆包 ASR 语音识别 SDK

## 许可证

本项目仅供学习研究用途。Claude Code 的所有权利归 [Anthropic](https://www.anthropic.com/) 所有。
