# Spec: `code-dog` README Documentation Design

This spec outlines the structure, content, and layout for the new `README.md` (Chinese, default) and `README_EN.md` (English) files for the **code-dog** project.

---

## 1. Project Identity & Theme

- **Project Name**: `code-dog`
- **Logo**: Located at `docs/assets/code_dog_logo.png` (a cyberpunk, pixel-art hacker dog guarding a coding terminal).
- **Tagline (CN)**: 基于 ESP32-S3 触摸屏的多平台 AI 编程助手（Claude Code, Gemini, Antigravity, Codex, OpenCode）物理安全看门狗与电子宠物系统。支持从 Petdex 与 Codex-pets 平台一键导入宠物资产进行打包展示。
- **Tagline (EN)**: A physical security gateway & desktop mascot on ESP32-S3 for Claude Code, Gemini, Antigravity, Codex, and OpenCode. Supports direct importing and packaging of pet assets from Petdex & Codex-pets.

---

## 2. Document Structure (`README.md` - Chinese)

### 2.1 Logo & Switched Language Links
- Embed `./docs/assets/code_dog_logo.png` centered.
- Switch link: `[English](README_EN.md) | 简体中文`

### 2.2 Feature Highlights (核心特性)
- **物理安全审批网关（严格守护模式）**：AI 命令行自动拦截，必须硬件触摸屏点击 `Approve` 才能运行。
- **动态开发伴侣（电子宠物模式）**：宠物随 AI 状态（空闲、思考、执行、成功、失败）展示丰富动画。
- **多平台深度支持**：兼容 Claude Code, Gemini, Antigravity, Codex, OpenCode 等主流 AI 终端。
- **宠物商店与打包切片**：支持 Petdex 和 Codex-pets 资源直导打包，自动生成 RGB565 二进制包 `pet_assets.bin`。

### 2.3 System Architecture (系统架构)
A Mermaid sequence/flow chart showing:
`AI Coding Agent (Hook) <--> Local Daemon (Node.js/Express) <--(MQTT)--> ESP32-S3 Device`

### 2.4 Quick Start Guide (极速上手)

#### 准备工作
- 软硬件环境要求：Node.js v18+, Python 3 (用于 PlatformIO Core CLI), ESP32-S3 开发板 + 1.54寸 240x240 ST7789 触摸屏。

#### 第一步：部署本地守护进程 (Local Daemon)
- **方式 A：Node.js 本地直接运行**
  ```bash
  cd local-daemon
  npm install
  npm start
  ```
- **方式 B：Docker Compose 一键部署**
  ```bash
  docker-compose up -d
  ```
- **关键动作**：浏览器打开 `http://localhost:4000`，获取并在网页顶部复制自动生成的 **Client ID**。

#### 第二步：配置并烧录 ESP32-S3 固件 (CLI 傻瓜步骤)
- **Linux 串口授权（解决权限报错问题）**
  ```bash
  sudo usermod -aG dialout $USER
  # 或者临时授权所有串口：
  sudo chmod 666 /dev/ttyACM*
  ```
- **环境变量配置（推荐，无需修改源码）**
  在终端中设置以下环境变量（或在项目根目录创建 `.env` 文件），PlatformIO 编译时会自动注入：
  ```bash
  export WIFI_SSID="您的WIFI账号"
  export WIFI_PASS="您的WIFI密码"
  export CLIENT_ID="刚才在网页端复制的Client ID"
  ```
- **一键编译与上传固件**
  - 使用 PlatformIO 命令行（通过项目自带的 `.venv`）一键编译并烧录：
    ```bash
    WIFI_SSID=$WIFI_SSID WIFI_PASS=$WIFI_PASS CLIENT_ID=$CLIENT_ID .venv/bin/pio run -t upload
    # 或者如果已经 export 了变量，直接执行：
    .venv/bin/pio run -t upload
    ```
  - *如果未建立虚拟环境，提供全新安装 PlatformIO CLI 并执行 `pip install platformio` 后的烧录步骤*。

#### 第三步：激活 AI 拦截 Hook
- 在 `http://localhost:4000` 的 **Hook 控制面板** 中，将目标 AI 助手切换为 `strict`（物理审批模式）或 `companion`（伴侣动画模式）。

### 2.5 FAQ & 紧急救援 (Troubleshooting & Emergency Rescue)
- **紧急救援命令**：如果在严格拦截模式下关闭了后端，导致终端完全死锁、无法执行任何 Bash 命令，复制执行以下命令立刻解开：
  ```bash
  curl -X POST http://localhost:4000/api/hooks/toggle -H "Content-Type: application/json" -d '{"platform":"claude-code","enabled":false}'
  ```
- **串口问题**：烧录提示 `udev` 规则错误或端口无法打开，运行 `sudo chmod 666 /dev/ttyACM*`。
- **MQTT 离线/宠物加载失败**：确保电脑与 ESP32 在同一 WiFi 局域网内，或所用 MQTT Broker 地址在 `server.js` 和 `main.cpp` 中保持一致（默认为 `broker-cn.emqx.io`）。

---

## 3. Document Structure (`README_EN.md` - English)
Mirroring the Chinese structure, fully translated, referencing the same assets and file links.
