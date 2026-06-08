# 前端电量及充电状态展示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web 控制台（Dashboard）顶部 Header 的“硬件状态”右侧动态渲染一个精致的电量与充电状态指示标签。

**Architecture:** 充分利用现有的前端 Polling（每秒轮询 `/api/status`）以及后端 config 数据字段，引入后端心跳防抖存盘、前端动态样式分类着色与发光 CSS 动画。

**Tech Stack:** JavaScript (ES6), HTML, CSS

---

### Task 1: 后端电量与充电状态变更防抖持久化

**Files:**
- Modify: `local-daemon/server.js:250-280`

- [ ] **Step 1: 修改 server.js 中的心跳包变更检测逻辑**

找到 `local-daemon/server.js` 中心跳消息接收的回调函数（大约在第 255 行到第 275 行），将其修改为检测到数值变化时才写盘存盘：

```javascript
        // Cache battery and charging info in config with change detection
        let configChanged = false;
        if (typeof payload.battery === 'number' && payload.battery !== config.deviceBattery) {
          config.deviceBattery = payload.battery;
          configChanged = true;
        }

        const chargingState = !!payload.charging;
        if (payload.charging !== undefined && chargingState !== config.deviceCharging) {
          config.deviceCharging = chargingState;
          configChanged = true;
        }

        if (configChanged) {
          saveConfig();
        }
```

- [ ] **Step 2: 运行 node 语法检查确认修改正确**

Run: `/home/zyx/.nvm/versions/node/v24.15.0/bin/node --check local-daemon/server.js`
Expected: 无报错（Exit 0）

- [ ] **Step 3: 提交后端变更检测修改**

```bash
git add local-daemon/server.js
git commit -m "feat(backend): 优化心跳包中的电量/充电状态变更检测及写盘持久化逻辑"
```

---

### Task 2: 前端 HTML 结构与 JS 轮询渲染重构

**Files:**
- Modify: `local-daemon/public/index.html:48-55`, `local-daemon/public/index.html:340-360`

- [ ] **Step 1: 在 HTML 状态栏中增加电量小胶囊标签占位符**

找到 `local-daemon/public/index.html` 中的“硬件状态”结构（大约在第 50 行），在后面加上占位 `<span>` 元素：

```html
        <div class="status-item">
          <span class="status-label">硬件状态:</span>
          <span class="status-indicator-dot" id="hardware-dot"></span>
          <span id="hardware-text" class="status-offline">OFFLINE</span>
          <span id="hardware-battery" class="hardware-battery" style="display: none;"></span>
        </div>
```

- [ ] **Step 2: 在 JS 轮询渲染逻辑中增加动态电量更新与切换**

修改 `index.html` 的 `fetchStatus()` 函数（大约在第 340 行到第 355 行），更新为：

```javascript
        // Update Hardware Status
        const hardwareDot = document.getElementById('hardware-dot');
        const hardwareText = document.getElementById('hardware-text');
        const hardwareBattery = document.getElementById('hardware-battery');
        if (data.deviceOnline) {
          hardwareDot.className = 'status-indicator-dot online';
          hardwareText.innerText = 'ONLINE';
          hardwareText.className = 'status-online';
          
          if (hardwareBattery && data.config) {
            const battery = data.config.deviceBattery;
            const charging = data.config.deviceCharging;
            if (typeof battery === 'number') {
              let icon = battery <= 20 ? '🪫' : '🔋';
              if (charging) icon = '⚡';
              
              hardwareBattery.innerHTML = `<span>${icon}</span> <span>${battery}%</span>`;
              hardwareBattery.style.display = 'inline-flex';
              
              // Apply specific classes for color/glow effects
              if (charging) {
                hardwareBattery.className = 'hardware-battery charging';
              } else if (battery <= 20) {
                hardwareBattery.className = 'hardware-battery low';
              } else {
                hardwareBattery.className = 'hardware-battery';
              }
            } else {
              hardwareBattery.style.display = 'none';
            }
          }
        } else {
          hardwareDot.className = 'status-indicator-dot';
          hardwareText.innerText = 'OFFLINE';
          hardwareText.className = 'status-offline';
          if (hardwareBattery) {
            hardwareBattery.style.display = 'none';
          }
        }
```

- [ ] **Step 3: 提交前端 HTML/JS 逻辑修改**

```bash
git add local-daemon/public/index.html
git commit -m "feat(frontend): 重构 HTML 状态栏，引入 fetch 轮询电量渲染及 class 动态绑定"
```

---

### Task 3: 前端 CSS 状态样式表精细化处理

**Files:**
- Modify: `local-daemon/public/style.css:1200-1250`

- [ ] **Step 1: 在 CSS 样式表尾部增加小标签及充电呼吸发光动画**

打开 `local-daemon/public/style.css`，在文件尾部（大约第 1200 行以后）追加样式定义：

```css
/* Hardware Battery Label Styling */
.hardware-battery {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-left: 0.5rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border-color);
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-main);
  transition: all 0.3s ease;
}

.hardware-battery.charging {
  color: var(--accent-approve);
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.25);
  animation: chargingGlow 2s infinite alternate;
}

.hardware-battery.low {
  color: var(--accent-reject);
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.25);
}

@keyframes chargingGlow {
  from {
    box-shadow: 0 0 4px rgba(16, 185, 129, 0.05);
  }
  to {
    box-shadow: 0 0 10px rgba(16, 185, 129, 0.25);
  }
}
```

- [ ] **Step 2: 提交 CSS 样式文件修改**

```bash
git add local-daemon/public/style.css
git commit -m "style(frontend): 定制精致的电量小标签布局并加入充电发光呼吸微动画"
```

---

### Task 4: 完整部署与集成验证

- [ ] **Step 1: 重启后端 Docker 容器使前后端代码修改全部生效**

Run: `docker compose restart backend`
Expected: 容器重启成功

- [ ] **Step 2: 真机验证测试**
  1. 开启设备，观察浏览器前端控制面板（`http://localhost:4000`）上的硬件状态栏。
  2. 验证 ONLINE 右侧是否立即出现设备对应的电量标签（例如 `🔋 65%` 或 `⚡ 65%`）。
  3. 如果插上/拔掉充电线，验证前台标签能否在 5~10 秒内随之更新为 `⚡ 充电状态` 并在其周边呈现绿色呼吸辉光。
  4. 拔掉电源关机，验证硬件状态置为 `OFFLINE` 后，电量标签是否能自动完美隐藏。
