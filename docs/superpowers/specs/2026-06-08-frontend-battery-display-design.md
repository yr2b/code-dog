# 2026-06-08 前端电量与充电状态展示设计规范

## 背景与目标

为了让用户在 Web 控制台（Dashboard）实时掌握 AI 安全审批硬件设备的电量情况，本需求将在控制台顶部 Header 的“硬件状态”右侧动态渲染一个精细的电量与充电状态小标签。

## 技术方案

本需求复用现有的前端每秒轮询 `/api/status` 接口的机制，实现无感实时的状态同步。

### 1. 后端修改 (`local-daemon/server.js`)
- 在 MQTT 心跳解析中，引入设备电量和充电状态的变更检测。
- 只有当 `deviceBattery` 或 `deviceCharging` 的实际值发生改变时，才触发 `saveConfig()` 写盘，从而在极小化磁盘 I/O 损耗的同时保证配置在后端容器重启后的持久恢复。

### 2. 前端 HTML 修改 (`local-daemon/public/index.html`)
- 在顶栏硬件状态一栏增加 ID 为 `hardware-battery` 的标签容器：
  ```html
  <span id="hardware-battery" class="hardware-battery" style="display: none;"></span>
  ```

### 3. 前端 JS 修改 (`local-daemon/public/index.html`)
- 在每秒触发的 `fetchStatus()` 响应解析逻辑中：
  - 若 `data.deviceOnline` 为 `true` 且包含合法的 `data.config.deviceBattery`，渲染相应的电池 Unicode 图标并动态呈现百分比，根据当前是否充电或低电量着色切换 CSS Class，最后设为 `display: inline-flex`。
  - 若 `data.deviceOnline` 为 `false` 或无电量数据，自动将该标签隐藏（`display: none`）。

### 4. 前端 CSS 修改 (`local-daemon/public/style.css`)
- 定制 `.hardware-battery` 类及其子状态修饰类 `.charging` 与 `.low`。
- 使用半透明背景和极细边框凸显玻璃质感。
- 为充电状态标签引入绿光呼吸式发光 CSS 动画。

---

## 模块设计细节

### 后端端 (`local-daemon/server.js`)

在 MQTT 心跳接收逻辑中（大约第 255 行）：
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

### 前端端 (`local-daemon/public/index.html`)

在 `fetchStatus()` 函数中（大约第 340 行）：
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
              
              // 状态着色样式选择
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

### 样式表 (`local-daemon/public/style.css`)

在文件尾部追加：
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

---

## 验证与测试方案

1. **静态代码检查**：
   通过 `node --check` 及浏览器控制台静态编译检测，确认修改无语法错误。
2. **逻辑通路测试**：
   - 启动本地后端，使用模拟工具或真机设备发送包含不同电量/充电状态的 JSON 心跳包。
   - 验证后端日志输出中，只有电量或充电状态改变时才会写入 `config.json`。
   - 打开浏览器，进入控制台观察顶栏“硬件状态”右侧是否能对应正确显示电量标签、电量数值及背景发光动画，且每秒正常随动刷新。
   - 当关闭硬件或停止心跳时，验证标签是否在 15 秒（超时判断时间）后随着 `OFFLINE` 状态自动隐藏。
