# 硬件宠物点击交互与长按切换设计文档

本项目旨在增强 ESP32-S3 硬件端宠物的交互性。通过重新设计触摸屏的处理逻辑，实现以下交互行为：
1. **短按宠物（主界面）**：随机呈现不同的宠物动作状态（从 `run`、`review`、`jump` 中随机选择），动作播放 3 秒后恢复默认的 `idle` 状态。排除代表死机/失败的 `failed` 状态。
2. **长按 3 秒（主界面）**：切换至系统状态页（若有待审批请求切换至 `STATE_APPROVAL`，否则切换至 `STATE_STATUS`）。
3. **点击状态页/审批页返回**：在系统状态页点击任意位置切换回宠物主界面；在审批页面点击顶部栏返回宠物主界面。

## 1. 触摸手势检测状态机

在 [main.cpp](file:///home/zyx/code-project/ai-execution-reminder/src/main.cpp) 中，通过检测 `SENSOR_IRQ` 中断信号和轮询触摸状态，实现一个支持防抖的手势识别状态机。

### 状态跟踪变量
```cpp
// 触摸手势状态跟踪
bool touchActive = false;          // 当前是否有持续触摸
unsigned long touchStartTime = 0;   // 触摸开始的时间戳
unsigned long lastTouchTime = 0;    // 最后一次检测到有效触摸的时间戳
bool longPressTriggered = false;   // 本次触摸是否已触发过长按逻辑
int startTouchX = 0;               // 触摸开始的 X 坐标
int startTouchY = 0;               // 触摸开始的 Y 坐标
```

### 手势检测逻辑设计
- **触摸开始**：当检测到中断 `isPressed` 为 `true` 或轮询到 `SENSOR_IRQ` 引脚为低电平时，尝试获取触摸坐标。若获取成功且 `touchActive` 为 `false`，则初始化触摸状态，记录当前时间及初始坐标。
- **长按判定**：在主界面下，如果触摸状态持续存在（`now - touchStartTime >= 3000`）且尚未触发长按，则立即触发长按事件（切换到系统状态页），并设置 `longPressTriggered = true`。
- **触摸释放**：如果连续 150ms 未检测到任何有效触摸坐标（用于防抖过滤数据抖动），则判定手指已离开屏幕。
  - 若 `longPressTriggered` 为 `false`，则判定为**短按**，调用短按处理函数 `handleShortPress(startTouchX, startTouchY)`。
  - 重置 `touchActive` 状态。

---

## 2. 交互行为逻辑实现

### 随机动作播放 `playRandomAction`
动作包内可能包含多个自定义或标准状态。为保证扩展性，我们从当前加载的 `animations` 列表中动态提取名字不为 `"failed"` 且不为 `"idle"` 的动画状态，并随机选取一个播放，持续时间设定为 3000ms（3秒）。
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
  
  // 如果没有其他动态状态，则回退到 idle
  if (availableStates.empty()) {
    availableStates.push_back("idle");
  }
  
  int idx = random(0, availableStates.size());
  // 尽量避免连续播放完全相同的动作
  if (availableStates.size() > 1 && availableStates[idx] == companionState) {
    idx = (idx + 1) % availableStates.size();
  }
  
  companionState = availableStates[idx];
  companionStateExpiry = millis() + 3000; // 播放3秒
  currentFrameIndex = 0;
  lastFrameTime = millis();
  
  Serial.printf("Triggered random action: %s for 3000ms\n", companionState.c_str());
}
```

### 短按事件分发 `handleShortPress`
根据当前屏幕状态 (`currentState`) 进行不同逻辑的分发：
- **`STATE_COMPANION` (宠物主界面)**：触发随机宠物动作。
- **`STATE_STATUS` (诊断界面)**：切换回宠物主界面 `STATE_COMPANION` 并调用 `updateUI()`。
- **`STATE_APPROVAL` (审批界面)**：保留原有的区域点击判定逻辑（Reject 按钮、Approve 按钮、多任务切换箭头、点击顶部栏返回）。

---

## 3. 具体修改点

### [main.cpp](file:///home/zyx/code-project/ai-execution-reminder/src/main.cpp)

#### 1. 声明新全局变量
在合适位置（如 `Touch debounce` 配置下方）定义触摸手势跟踪变量。

#### 2. 添加 `playRandomAction` 与 `handleShortPress`
编写动作播放逻辑和短按事件分发代码。

#### 3. 覆盖修改 `checkTouch` 函数
替换原有的 `checkTouch` 检测逻辑，实现带 150ms 释放防抖的手势判定器。

---

## 4. 验证计划

1. **编译验证**：
   运行 `pio run` 确保固件成功构建，无任何编译或链接错误。
2. **长按/短按响应验证**：
   - 验证在宠物主界面单次点击是否会播放随机动作（如奔跑、跳跃等），且 3 秒后是否能平滑切回 `idle`。
   - 验证长按 3 秒是否能正常跳转至 Diagnostics 诊断页面，且长按时在第 3 秒**立即响应**切换（不需要松手）。
   - 验证在 Diagnostics 页面点击是否能立即切回宠物页面。
   - 验证当有待审批请求时，长按 3 秒是否切换至审批页而不是诊断页。
