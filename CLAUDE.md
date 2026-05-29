# code-dog 项目规范

## 关键操作规范

### 关闭后端前必须清除 Claude Code Hook
后端运行时会通过 ESP32-S3 硬件审批钩子拦截所有 Bash 命令。**关闭后端之前，必须先禁用钩子**，否则 Claude Code 会完全无法执行任何命令：

```bash
# 1. 先禁用 hook（在后端运行时通过 API 操作）
curl -X POST http://localhost:4000/api/hooks/toggle -H "Content-Type: application/json" -d '{"platform":"claude-code","enabled":false}'

# 2. 然后才能关闭后端
kill $(pgrep -f "node server.js")
```

### 串口权限
ESP32-S3 串口需要 dialout 组权限：
```bash
sudo usermod -aG dialout zyx  # 需重新登录生效
# 或临时：sudo chmod 666 /dev/ttyACM1
```

### 固件编译上传
```bash
cd /home/zyx/code-project/ai-execution-reminder
.venv/bin/pio run -t upload
```

### 宠物资源格式
- PETD v2 格式：小端序 RGB565 + 品红色键 (0xF81F) 透明
- v1 格式（大端序）已被固件拒绝，需重新生成

## 架构概览

- `src/main.cpp` — ESP32-S3 固件（ST7789 240x240 LCD）
- `local-daemon/server.js` — Node.js 后端（Express + MQTT）
- `local-daemon/pet-manager.js` — 宠物精灵处理与二进制打包
- `bin/claude-hook.sh` — Claude Code PreToolUse 钩子脚本

## MQTT 通信

- Broker: `broker.hivemq.com`（公网）
- 宠物变更消息 **不要使用 retain**，否则 ESP32 每次重连都会重复下载
