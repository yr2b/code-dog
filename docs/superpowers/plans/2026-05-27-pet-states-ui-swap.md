# 宠物状态扩展与物理屏幕 UI 按钮对调开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现硬件端按钮对调以及 Claude Code / Antigravity 宠物状态的高级同步（非阻塞，只做状态静默传递）。

**Architecture:** 前端和终端钩子本地读取共享文件判断模式，非严格模式下直接退出，并后台（异步）发送工具事件到 `/api/hook/event` 和 `/api/result`，再通过 MQTT 传递给设备状态。

**Tech Stack:** C++ (Arduino/PlatformIO) / Node.js (Express) / Shell Script

---

### Task 1: 硬件固件修改与对调按键

**Files:**
- Modify: `src/main.cpp`

- [ ] **Step 1: 修改 drawApprovalScreen() 按钮渲染逻辑**
  在 `src/main.cpp` 中定位 `drawApprovalScreen()`，替换底部的绿色/红色按钮绘制部分。
  - 将左侧设为红色 `COLOR_RED`，写 `REJECT`；
  - 将右侧设为绿色 `COLOR_GREEN`，写 `APPROVE`。

- [ ] **Step 2: 修改 checkTouch() 审批状态点击判定**
  在 `src/main.cpp` 中定位 `checkTouch()` 里的 `else if (currentState == STATE_APPROVAL)`，将左侧点击热区（`tx >= 10 && tx <= 115`）改为执行 **Reject**，将右侧点击热区（`tx >= 125 && tx <= 230`）改为执行 **Approve**。

- [ ] **Step 3: 运行 PlatformIO 编译**
  运行 `pio run` 验证代码无语法错并编译出 binary。

---

### Task 2: 后端与终端 Wrapper 逻辑修改

**Files:**
- Modify: `bin/claude-hook.sh`
- Modify: `local-daemon/hooks-manager.js`
- Modify: `local-daemon/server.js`

- [ ] **Step 1: 升级 bin/claude-hook.sh 解析与异步发送逻辑**
  重构 `bin/claude-hook.sh`：
  - 本地解析 `/tmp/aegis_pet_config.json` 获取 `MODE`；
  - 若 `MODE` 不为 `strict`，后台发送 `curl ... /api/hook/event &` 并直接 `exit 0`；
  - 若 `MODE` 为 `strict`，前台同步阻塞发送 `curl ... /api/approve`。

- [ ] **Step 2: 修改 hooks-manager.js 中的 Wrapper 模板以处理状态及结果上报**
  修改 `local-daemon/hooks-manager.js` 中的 `bashContent` 变量：
  - 在非严格模式下直接执行命令并在后台发送状态包；
  - 捕获退出码 `$?` 并在后台向 `/api/result` 上报结果。

- [ ] **Step 3: server.js 新增配置文件写入及结果/事件接口**
  - 在 `server.js` 启动和 `saveConfig()` 处向 `/tmp/aegis_pet_config.json` 写入配置；
  - 新增 `POST /api/hook/event` 异步接口，快速返回并于后台向设备发送对应状态（只读工具为 `review`，其他为 `run`）；
  - 新增 `POST /api/result` 异步接口，接收终端退出码并向设备发送 `jump`/`failed` 状态。
