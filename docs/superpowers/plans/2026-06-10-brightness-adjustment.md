# 屏幕亮度物理按键调节功能实现计划 (Brightness Adjustment Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 ESP32-S3 硬件端在状态页中通过物理按键调节背光亮度，并通过 Preferences 库持久化保存亮度设置。

**Architecture:** 
1. 采用 ESP32 的 LEDC (PWM) 控制 `GFX_BL` (GPIO 46) 驱动屏幕背光；
2. 利用 Preferences 存储库读写 NVS Flash 以持久化状态；
3. 重写 `checkButtons()` 轮询，在 `STATE_STATUS` 模式下截获短按信号并触发背光和 UI 刷新。

**Tech Stack:** ESP32-S3, Arduino Framework, ESP32 LEDC (PWM), ESP32 Preferences (NVS), PlatformIO.

---

### Task 1: 引入 Preferences 库与实现亮度调光底座

**Files:**
- Modify: `src/main.cpp:1-12` (库引用)
- Modify: `src/main.cpp:41-45` (新增全局变量)
- Modify: `src/main.cpp` (添加核心控制函数)

- [ ] **Step 1: 引入库与定义全局变量**

在 `src/main.cpp` 顶部引入库，并定义 `screenBrightness` 和 `prefs`：

```cpp
// 在 src/main.cpp 约第 11 行 #include <PNGdec.h> 下方添加：
#include <Preferences.h>

// 在全局变量定义区（例如 batteryPct 等变量下方）添加：
int screenBrightness = 80; // 默认亮度百分比 80%
Preferences prefs;
```

- [ ] **Step 2: 实现控制与 NVS 存储函数**

在 `src/main.cpp` 中定义 `setBrightness`、`initBrightness` 和 `saveBrightness`：

```cpp
// 在 drawGlobalBattery 函数前方添加：
void setBrightness(int percent) {
  if (percent < 10) percent = 10;
  if (percent > 100) percent = 100;
  
  // 将 10%-100% 映射到 15-255 占空比，确保最低档时屏幕仍可勉强看清
  int duty = map(percent, 10, 100, 15, 255);
  ledcWrite(0, duty);
  Serial.printf("Backlight set to %d%% (duty %d)\n", percent, duty);
}

void initBrightness() {
  // LEDC 通道 0，频率 5KHz，8位分辨率
  ledcSetup(0, 5000, 8);
  ledcAttachPin(GFX_BL, 0);
  
  prefs.begin("system", false);
  screenBrightness = prefs.getInt("brightness", 80);
  prefs.end();
  
  setBrightness(screenBrightness);
}

void saveBrightness(int percent) {
  prefs.begin("system", false);
  prefs.putInt("brightness", percent);
  prefs.end();
}
```

- [ ] **Step 3: 编译验证**

运行 PlatformIO 编译，确保无语法与库依赖冲突：

Run: `.venv/bin/pio run`
Expected: 编译输出 SUCCESS。

- [ ] **Step 4: Commit**

```bash
git add src/main.cpp
git commit -m "feat: add LEDC brightness driver and preferences storage"
```


### Task 2: 替换系统初始化与适配关机逻辑

**Files:**
- Modify: `src/main.cpp:1580-1595` (关机逻辑)
- Modify: `src/main.cpp:1740-1748` (系统初始化逻辑)

- [ ] **Step 1: 修改系统初始化中的背光使能**

在 `src/main.cpp` 的 `setup()` 函数中，将原有的背光初始化：

```cpp
  pinMode(GFX_BL, OUTPUT);
  digitalWrite(GFX_BL, HIGH);
```

替换为：

```cpp
  initBrightness();
```

- [ ] **Step 2: 适配关机背光切断逻辑**

在 `src/main.cpp` 的 `checkButtons()` 关机长按触发代码块中：

```cpp
      if (duration >= 2000) {
        Serial.println("PWR Button: Shutdown triggered");
        // Turn off screen backlight immediately
        pinMode(GFX_BL, OUTPUT);
        digitalWrite(GFX_BL, LOW);
        gfx->displayOff();
```

替换为：

```cpp
      if (duration >= 2000) {
        Serial.println("PWR Button: Shutdown triggered");
        // Turn off screen backlight immediately
        ledcWrite(0, 0);
        pinMode(GFX_BL, OUTPUT);
        digitalWrite(GFX_BL, LOW);
        gfx->displayOff();
```

- [ ] **Step 3: 编译验证**

Run: `.venv/bin/pio run`
Expected: 编译输出 SUCCESS。

- [ ] **Step 4: Commit**

```bash
git add src/main.cpp
git commit -m "feat: hook up brightness setup and safe shutdown behavior"
```


### Task 3: 状态页按键动作重写

**Files:**
- Modify: `src/main.cpp:1505-1570` (按键处理)

- [ ] **Step 1: 修改 BOOT 键短按处理**

在 `checkButtons()` 中，对 `PIN_BOOT` 短按逻辑中增加 `STATE_STATUS` 处理：

```cpp
  // --- BOOT Button (GPIO 0) ---
  bool bootPressed = (digitalRead(PIN_BOOT) == LOW);
  if (bootPressed && !bootWasPressed) {
    bootPressStart = now;
    bootWasPressed = true;
  } else if (!bootPressed && bootWasPressed) {
    unsigned long duration = now - bootPressStart;
    if (duration > 50 && duration < 1000) { // Short press
      // In Approval mode, BOOT button acts as Reject
      if (currentState == STATE_APPROVAL && !requests.empty()) {
        Serial.println("BOOT Button: Rejecting Request");
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
      } else if (currentState == STATE_STATUS) {
        // 状态页短按 BOOT 键为“减小亮度”
        screenBrightness -= 10;
        if (screenBrightness < 10) screenBrightness = 10;
        setBrightness(screenBrightness);
        saveBrightness(screenBrightness);
        updateUI();
      }
    }
    bootWasPressed = false;
  }
```

- [ ] **Step 2: 修改 PLUS 键短按处理**

在 `checkButtons()` 中，对 `PIN_PLUS` 短按逻辑重写，限制其在状态页下的功能为增加亮度：

```cpp
  // --- PLUS Button (GPIO 4) ---
  bool plusPressed = (digitalRead(PIN_PLUS) == LOW);
  if (plusPressed && !plusWasPressed) {
    plusPressStart = now;
    plusWasPressed = true;
  } else if (!plusPressed && plusWasPressed) {
    unsigned long duration = now - plusPressStart;
    if (duration > 50 && duration < 1000) { // Short press
      // In Approval mode, PLUS button acts as Approve
      if (currentState == STATE_APPROVAL && !requests.empty()) {
        Serial.println("PLUS Button: Approving Request");
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
      } else if (currentState == STATE_STATUS) {
        // 状态页短按 PLUS 键为“增加亮度”
        screenBrightness += 10;
        if (screenBrightness > 100) screenBrightness = 100;
        setBrightness(screenBrightness);
        saveBrightness(screenBrightness);
        updateUI();
      } else {
        // Toggle view between Companion and Diagnostics (only trigger from other states)
        Serial.println("PLUS Button: Toggling View Mode");
        if (currentState == STATE_COMPANION) {
          currentState = STATE_STATUS;
        }
        updateUI();
      }
    }
    plusWasPressed = false;
  }
```

- [ ] **Step 3: 编译验证**

Run: `.venv/bin/pio run`
Expected: 编译输出 SUCCESS。

- [ ] **Step 4: Commit**

```bash
git add src/main.cpp
git commit -m "feat: intercept BOOT and PLUS button short-press on status screen"
```


### Task 4: 状态页 UI 亮度调节控件渲染

**Files:**
- Modify: `src/main.cpp:689-730` (状态页渲染)

- [ ] **Step 1: 增加进度条与文字绘制**

修改 `drawStatusScreen()` 函数，在 "Tap screen to return." 绘制语句的下方，加入亮度控制台指示的绘制：

```cpp
  gfx->setTextSize(1);
  gfx->setTextColor(COLOR_TEXT_MUTED);
  gfx->setCursor(20, 150);
  gfx->println("All configurations synced.");
  gfx->setCursor(20, 165);
  gfx->println("Tap screen to return.");

  // === 开始绘制亮度面板 ===
  gfx->setCursor(20, 190);
  gfx->print("亮度: ");
  gfx->setTextColor(COLOR_CYAN);
  gfx->printf("%d%%", screenBrightness);

  // 绘制进度条背景
  int barX = 65;
  int barY = 184;
  int barW = 110;
  int barH = 8;
  gfx->fillRoundRect(barX, barY, barW, barH, 4, COLOR_DARK_BG);
  
  // 绘制进度条高亮部分
  int activeW = map(screenBrightness, 10, 100, 0, barW);
  if (activeW > 0) {
    gfx->fillRoundRect(barX, barY, activeW, barH, 4, COLOR_CYAN);
  }

  // 右侧实体按键提示
  gfx->setTextColor(COLOR_TEXT_MUTED);
  gfx->setCursor(185, 190);
  gfx->print("[-/+]");
}
```

- [ ] **Step 2: 编译验证**

Run: `.venv/bin/pio run`
Expected: 编译输出 SUCCESS。

- [ ] **Step 3: Commit**

```bash
git add src/main.cpp
git commit -m "feat: render brightness level indicator and bar on diagnostics screen"
```
