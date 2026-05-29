# Hook 控制面板单个平台安装与卸载控制开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Hook 控制面板中为每个平台加入明确的操作按钮以单独执行 Hook 保护程序的安装和卸载。

**Architecture:** 前端读取平台的安装状态 `h.installed`。未安装时，禁用模式选择下拉菜单，并展示 `⚡ 安装并启用 Hook` 绿色按钮（点击切换至 `strict` 模式以触发安装）；已安装时，启用下拉菜单并展示 `🗑️ 卸载并禁用 Hook` 红色按钮（点击切换至 `disabled` 模式以触发卸载）。

**Tech Stack:** HTML5 / JavaScript (Vanilla) / CSS3 / Node.js (Express)

---

### Task 1: 修改控制面板卡片生成逻辑

**Files:**
- Modify: `local-daemon/public/index.html`

- [ ] **Step 1: 升级 fetchHooksStatus() 内的模板结构**

修改 `local-daemon/public/index.html` 的 `fetchHooksStatus` 函数，使生成的 HTML 卡片包含联动下拉框与对应操作按钮。目标修改段落：

目标替换内容：
```javascript
        hooksList.innerHTML = data.statuses.map(h => `
          <div class="hook-card">
            <div class="hook-card-header">
              <h3>${h.name}</h3>
              <span class="hook-status-badge ${h.installed ? 'installed' : 'uninstalled'}">
                ${h.installed ? '保护中 (Hook 已写入)' : '不做操作 (Hook 未写入)'}
              </span>
            </div>
            <div class="hook-details">
              <span class="section-label">配置路径:</span>
              <span class="hook-path font-mono">${h.configPath}</span>
              <span class="section-label">检测状态:</span>
              <span>${h.detected ? '✅ 已在系统检测到此客户端' : 'ℹ️ 未检测到配置目录'}</span>
            </div>
            <div class="mode-selector-group">
              <span class="section-label">模式设定:</span>
              <select class="mode-select" onchange="toggleHookMode('${h.id}', this.value)">
                <option value="disabled" ${h.mode === 'disabled' ? 'selected' : ''}>❌ 彻底关闭 (Disabled)</option>
                <option value="strict" ${h.mode === 'strict' ? 'selected' : ''}>🛡️ 强安全拦截 (Strict)</option>
                <option value="monitor" ${h.mode === 'monitor' ? 'selected' : ''}>📊 静默审计 (Monitor)</option>
                <option value="companion" ${h.mode === 'companion' ? 'selected' : ''}>👾 伴侣随动 (Companion)</option>
              </select>
            </div>
          </div>
        `).join('');
```

新替换内容：
```javascript
        hooksList.innerHTML = data.statuses.map(h => {
          const actionBtn = h.installed
            ? `<button onclick="toggleHookMode('${h.id}', 'disabled')" class="btn btn-reject" style="width: 100%; margin-top: 0.5rem; justify-content: center;">🗑️ 卸载并禁用 Hook</button>`
            : `<button onclick="toggleHookMode('${h.id}', 'strict')" class="btn btn-approve" style="width: 100%; margin-top: 0.5rem; justify-content: center; background: var(--accent-primary); color: #fff; box-shadow: var(--glass-glow);">⚡ 安装并启用 Hook</button>`;

          return `
            <div class="hook-card">
              <div class="hook-card-header">
                <h3>${h.name}</h3>
                <span class="hook-status-badge ${h.installed ? 'installed' : 'uninstalled'}">
                  ${h.installed ? '保护中 (Hook 已写入)' : '不做操作 (Hook 未写入)'}
                </span>
              </div>
              <div class="hook-details">
                <span class="section-label">配置路径:</span>
                <span class="hook-path font-mono">${h.configPath}</span>
                <span class="section-label">检测状态:</span>
                <span>${h.detected ? '✅ 已在系统检测到此客户端' : 'ℹ️ 未检测到配置目录'}</span>
              </div>
              <div class="mode-selector-group">
                <span class="section-label">模式设定:</span>
                <select class="mode-select" ${!h.installed ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''} onchange="toggleHookMode('${h.id}', this.value)">
                  <option value="disabled" ${h.mode === 'disabled' ? 'selected' : ''}>❌ 彻底关闭 (Disabled)</option>
                  <option value="strict" ${h.mode === 'strict' ? 'selected' : ''}>🛡️ 强安全拦截 (Strict)</option>
                  <option value="monitor" ${h.mode === 'monitor' ? 'selected' : ''}>📊 静默审计 (Monitor)</option>
                  <option value="companion" ${h.mode === 'companion' ? 'selected' : ''}>👾 伴侣随动 (Companion)</option>
                </select>
              </div>
              <div class="hook-actions-row">
                ${actionBtn}
              </div>
            </div>
          `;
        }).join('');
```

- [ ] **Step 2: 验证 UI 安装/卸载交互**

启动服务并在浏览器面板中进行手动安装、卸载测试：
打开控制面板的 `Hook 控制面板` 选项卡，对各个平台卡片进行交互：
- 确认未安装时下拉框变灰禁用，且包含绿色的安装按钮。
- 点击安装按钮后，状态变为已安装，下拉框变为可用状态，按钮切换为红色卸载按钮。
- 点击卸载按钮后恢复为初始状态。
