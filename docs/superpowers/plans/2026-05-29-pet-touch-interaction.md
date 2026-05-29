# 宠物点击交互与长按切换实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强宠物屏幕交互性，实现短按宠物播放随机动态动作（3秒后复原），长按 3 秒切换系统 diagnostics/approval 页面，在 diagnostics 页面短按返回。

**Architecture:** 在 [main.cpp](file:///home/zyx/code-project/ai-execution-reminder/src/main.cpp) 中新增手势检测状态变量，修改触摸事件处理流程，引入基于 SENSOR_IRQ 引脚状态和触摸坐标采样的防抖手势判定器。

**Tech Stack:** C++ / Arduino / PlatformIO

---

### Task 1: 声明手势追踪变量与随机动作函数

**Files:**
- Modify: `src/main.cpp:320-330`

- [ ] **Step 1: 新增触摸手势状态变量**

在 `Touch debounce` 注释下方声明新的全局手势状态变量。

```cpp
// Touch gesture tracking
bool touchActive = false;
unsigned long touchStartTime = 0;
unsigned long lastTouchTime = 0;
bool longPressTriggered = false;
int startTouchX = 0;
int startTouchY = 0;
```

- [ ] **Step 2: 声明并实现 `playRandomAction` 与 `handleShortPress` 函数**

在 `Touch Input Handler` 注释上方实现这两个函数。
`playRandomAction` 动态选择当前加载的宠物动画（排除 `"failed"` 和 `"idle"`）并随机播放 3 秒：

```cpp
void playRandomAction() {
  if (animations.empty()) return;
  
  std::vector<String> availableStates;
  for (const auto& anim : animations) {
    String name = String(anim.name);
    if (name != "failed" && name != "idle") {
      availableStates.push_back(name);
    }
  }
  
  // 回退机制：若无其他状态则播放 idle
  if (availableStates.empty()) {
    availableStates.push_back("idle");
  }
  
  int idx = random(0, availableStates.size());
  // 尽量避免连续播放完全相同的动作
  if (availableStates.size() > 1 && availableStates[idx] == companionState) {
    idx = (idx + 1) % availableStates.size();
  }
  
  companionState = availableStates[idx];
  companionStateExpiry = millis() + 3000; // 播放 3 秒
  currentFrameIndex = 0;
  lastFrameTime = millis();
  
  Serial.printf("Triggered random action: %s for 3000ms\n", companionState.c_str());
}

// 提前声明 handleShortPress，将在 Task 2 中具体实现
void handleShortPress(int tx, int ty);
```

- [ ] **Step 3: 运行编译验证**

运行以下编译命令以确保新增的代码没有任何语法或类型错误：
Run: `.venv/bin/pio run`
Expected: SUCCESS

---

### Task 2: 实现短按事件分发 `handleShortPress`

**Files:**
- Modify: `src/main.cpp:1265-1350`

- [ ] **Step 1: 实现 `handleShortPress` 函数主体**

将原有的 `checkTouch` 中针对短按的逻辑提取并改写至 `handleShortPress`：

```cpp
void handleShortPress(int tx, int ty) {
  if (currentState == STATE_COMPANION) {
    playRandomAction();
  }
  else if (currentState == STATE_STATUS) {
    currentState = STATE_COMPANION;
    updateUI();
  }
  else if (currentState == STATE_APPROVAL) {
    if (ty < 40) {
      // 头部栏多任务切换
      if (requests.size() > 1 && tx >= 155 && tx <= 180 && ty >= 12 && ty <= 34) {
        currentRequestIndex--;
        if (currentRequestIndex < 0) currentRequestIndex = requests.size() - 1;
        updateUI();
        return;
      }
      else if (requests.size() > 1 && tx >= 210 && tx <= 235 && ty >= 12 && ty <= 34) {
        currentRequestIndex++;
        if (currentRequestIndex >= (int)requests.size()) currentRequestIndex = 0;
        updateUI();
        return;
      }
      
      currentState = STATE_COMPANION;
      updateUI();
      return;
    }

    // Reject 按钮: x: 10-115, y: 192-230
    else if (tx >= 10 && tx <= 115 && ty >= 192 && ty <= 230) {
      Serial.println("Rejected button clicked!");
      sendResponse(requests[currentRequestIndex].id, false);
      requests.erase(requests.begin() + currentRequestIndex);
      if (requests.empty()) {
        currentState = STATE_COMPANION;
        currentRequestIndex = 0;
      } else {
        if (currentRequestIndex >= (int)requests.size()) {
          currentRequestIndex = requests.size() - 1;
        }
      }
      updateUI();
    }
    // Approve 按钮: x: 125-230, y: 192-230
    else if (tx >= 125 && tx <= 230 && ty >= 192 && ty <= 230) {
      Serial.println("Approved button clicked!");
      sendResponse(requests[currentRequestIndex].id, true);
      requests.erase(requests.begin() + currentRequestIndex);
      if (requests.empty()) {
        currentState = STATE_COMPANION;
        currentRequestIndex = 0;
      } else {
        if (currentRequestIndex >= (int)requests.size()) {
          currentRequestIndex = requests.size() - 1;
        }
      }
      updateUI();
    }
  }
}
```

- [ ] **Step 2: 运行编译验证**

运行以下编译命令以确保代码无语法错误：
Run: `.venv/bin/pio run`
Expected: SUCCESS

---

### Task 3: 覆盖改写 `checkTouch` 实现手势检测状态机

**Files:**
- Modify: `src/main.cpp:1265-1350` (替换原有的 `checkTouch` 函数)

- [ ] **Step 1: 重构 `checkTouch`**

使用包含 SENSOR_IRQ 状态判定、150ms 释放延迟的手势检测器替换原先的 `checkTouch` 实现：

```cpp
void checkTouch() {
  if (!hasTouch) return;

  unsigned long now = millis();
  bool pinTouched = (digitalRead(SENSOR_IRQ) == LOW);
  
  int16_t x[5], y[5];
  bool gotPoint = false;
  int tx = 0, ty = 0;

  if (isPressed || pinTouched) {
    isPressed = false;
    uint8_t touched = touch.getPoint(x, y, touch.getSupportTouchPoint());
    if (touched > 0) {
      gotPoint = true;
      tx = x[0];
      ty = y[0];
    }
  }

  if (gotPoint) {
    if (!touchActive) {
      touchActive = true;
      touchStartTime = now;
      longPressTriggered = false;
      startTouchX = tx;
      startTouchY = ty;
      Serial.printf("Touch started: X=%d, Y=%d\n", tx, ty);
    }
    lastTouchTime = now;

    // 长按 3 秒判定（仅在宠物主界面下触发长按）
    if (currentState == STATE_COMPANION && !longPressTriggered) {
      if (now - touchStartTime >= 3000) {
        longPressTriggered = true;
        Serial.println("Long press triggered in Companion mode (3 seconds)!");
        if (requests.size() > 0) {
          currentState = STATE_APPROVAL;
          currentRequestIndex = 0;
        } else {
          currentState = STATE_STATUS;
        }
        updateUI();
      }
    }
  } else {
    // 触摸断开判定，设置 150ms 采样时间窗过滤短暂的 I2C 响应间歇
    if (touchActive && (now - lastTouchTime > 150)) {
      touchActive = false;
      unsigned long duration = now - touchStartTime;
      Serial.printf("Touch released. Duration: %d ms, longPressTriggered=%s\n", duration, longPressTriggered ? "YES" : "NO");
      
      if (!longPressTriggered) {
        handleShortPress(startTouchX, startTouchY);
      }
    }
  }
}
```

- [ ] **Step 2: 运行固件编译**

运行完整编译以确保一切工作正常：
Run: `.venv/bin/pio run`
Expected: SUCCESS

- [ ] **Step 3: 上传固件至硬件（如果连接了硬件）**

Run: `.venv/bin/pio run -t upload`
Expected: SUCCESS (上传完成并启动)
