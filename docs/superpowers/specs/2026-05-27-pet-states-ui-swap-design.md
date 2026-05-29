# 宠物状态扩展与物理屏幕 UI 按钮对调设计方案 (Spec)

## 1. 背景与目标
1. **宠物状态同步扩展**：目前小宠物的 5 种动画状态（`idle`, `run`, `review`, `failed`, `jump`）没有完全被利用起来。需要对 Claude Code 与 Antigravity 进行兼容优化。
   - **核心要求**：除了 `strict` 模式需要阻塞确认外，其他非阻塞模式下 Hook 必须做到“直接放过，不做任何操作”，不能因为发起网络 HTTP 请求而阻碍 AI 工具的正常执行速度。
   - **实现机制**：通过本地共享配置文件直接在 Hook 脚本中判定当前模式。若为非严格模式，Hook 立即以 0 状态码退出，并异步（后台 `&`）向新增的状态通知接口发送工具事件，由后台通过 MQTT 广播更新宠物状态。
2. **硬件端 UI 按钮位置对调**：将开发板屏幕 UI 按钮对调为“左边 Reject，右边 Approve”，使其与物理按键方向完全对齐。

---

## 2. 详细技术规格

### 2.1 硬件端 UI 按钮对调与触控逻辑

#### 2.1.1 按钮绘制重构 (`src/main.cpp`)
在 `drawApprovalScreen()` 中修改底部的按钮绘制位置与文字：
* **左侧按钮 (x=10, y=192, 宽105, 高38)**：
  - 颜色设为红色 `COLOR_RED`。
  - 文字印为 `REJECT`，居中坐标设为 `x=44, y=205`。
* **右侧按钮 (x=125, y=192, 宽105, 高38)**：
  - 颜色设为绿色 `COLOR_GREEN`。
  - 文字印为 `APPROVE`，居中坐标设为 `x=156, y=205`。

#### 2.1.2 触控坐标响应重构 (`src/main.cpp`)
在 `checkTouch()` 中的 `STATE_APPROVAL` 点击逻辑中，对调响应逻辑：
* 当点击区域为左侧 `tx >= 10 && tx <= 115` 时：触发 **Reject** (调用 `sendResponse(..., false)`)。
* 当点击区域为右侧 `tx >= 125 && tx <= 230` 时：触发 **Approve** (调用 `sendResponse(..., true)`)。

---

### 2.2 宠物状态静默传递与异步接口设计

#### 2.2.1 本地共享配置文件设计
- 后端服务 `server.js` 在启动时以及每次配置更新保存时，将当前的 `config` 原封不动写入本地系统的临时文件 `/tmp/aegis_pet_config.json` 中。
- 拦截 Hook 脚本直接通过本地极速读取该文件（无需发起 HTTP 请求）来判定当前模式，性能开销 <5ms，实现完全不干扰 AI 工具链的直接通过。

#### 2.2.2 新增状态通知路由 (`server.js`)
- 在 `server.js` 中新增接口 `POST /api/hook/event`：
  - 此接口为**状态传递专用接口**，不参与任何审批阻塞。
  - 收到请求后，立即返回响应，并在后台解析 `tool_name` 转换为对应宠物动画状态，通过 MQTT 广播至设备：
    - 查询/只读工具 (`read`, `viewfile`, `view_file`, `grep`, `grep_search`, `glob`, `list_dir`, `list_directory`, `search_web`, `web_search`, `read_url`) 映射为 `review`。
    - 写入/修改/终端工具 (`write`, `edit`, `editfile`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `bash`, `run_command`, `execute_command`) 映射为 `run`。

#### 2.2.3 Claude Code 拦截脚本重构 (`bin/claude-hook.sh`)
```bash
#!/bin/bash
INPUT=$(cat)

# 提取核心参数
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // .toolName // ""')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // .toolInput // {}')
CMD=$(echo "$TOOL_INPUT" | jq -r '.command // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""')

# 本地解析当前模式 (从共享临时配置文件中)
MODE=$(jq -r --arg cwd "$CWD" --arg agent "claude-code" '
  if .freeFlyMode then "freefly"
  else (.projects[$cwd].platforms[$agent] // .projects[$cwd].mode // .platforms[$agent] // .global.mode // "companion")
  end' /tmp/aegis_pet_config.json 2>/dev/null || echo "companion")

# 包装 payload
PAYLOAD=$(jq -n \
  --arg tn "$TOOL_NAME" \
  --argjson ti "$TOOL_INPUT" \
  --arg cmd "$CMD" \
  --arg cwd "$CWD" \
  --arg sid "$SESSION_ID" \
  --arg tp "$TRANSCRIPT_PATH" \
  '{tool_name: $tn, tool_input: $ti, command: $cmd, cwd: $cwd, session_id: $sid, transcript_path: $tp}')

if [ "$MODE" = "strict" ]; then
    # 严格拦截模式：前台同步请求审批，阻塞等待结果
    RESPONSE=$(curl -s -X POST http://localhost:4000/api/approve \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD")
    APPROVED=$(echo "$RESPONSE" | grep -o '"approved":true')
    if [ -n "$APPROVED" ]; then
        exit 0
    else
        echo "Access Denied: Blocked by physical device." >&2
        exit 2
    fi
else
    # 伴侣/其他模式：不做任何阻塞操作，直接退出，同时后台异步发送状态更新
    curl -s -X POST http://localhost:4000/api/hook/event \
      -H "Content-Type: application/json" \
      -d "$PAYLOAD" &
    exit 0
fi
```

#### 2.2.4 Antigravity 终端 Wrapper 脚本重构
在 `hooks-manager.js` 生成的 Wrapper 脚本中同样集成该本地解析逻辑：
- 识别为 `strict` 模式时，前台同步调用 `/api/approve`。
- 识别为非严格模式时，直接运行命令，并在后台上报状态。
- 命令结束后，捕获退出状态码 `$?` 并上报至新路由 `POST /api/result`，根据结果异步播放 3 秒 `jump` 或 `failed` 动画。

---

## 3. 验证计划

### 3.1 固件编译验证
- 运行 `pio run` 确保固件修改无编译报错。

### 3.2 联调与交互手动验证
1. **物理审批键方向对齐**：
   - 触发 Strict 拦截审批，验证屏幕左边为红色的 Reject，右边为绿色的 Approve。
   - 点击屏幕左侧红色 Reject，验证请求被正常拒绝。
2. **终端结果与庆祝动画测试**：
   - 在 Hook 控制面板重新启用一下 Antigravity 保护。
   - 终端输入 `echo "test"`（退出码 0），观察屏幕宠物播放 3 秒 `jump` 庆祝动画。
   - 终端输入 `ls non_existent_file`（退出码 非0），观察屏幕宠物播放 3 秒 `failed` 悲伤动画。
3. **Claude Code 状态传递测试**：
   - 运行 Claude Code 查看文件或搜索，验证小宠物屏幕显示 `review` 状态，但不发生任何阻塞。
   - 运行 Claude Code 写入文件，验证小宠物显示 `run` 状态，且不发生任何阻塞。
