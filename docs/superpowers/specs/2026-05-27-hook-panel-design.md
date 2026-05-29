# Hook 控制面板直接安装与卸载功能设计方案 (Spec)

## 1. 背景与目标
目前 AegisPet 的拦截 Hook 安装和卸载逻辑隐式地与拦截模式的配置（配置为 `disabled` 时自动卸载，配置为其他模式时自动安装）相绑定。对于用户而言，缺乏直接、手动的“安装”与“卸载”操作按钮。
本方案旨在通过修改前端 Hook 控制面板卡片展示，引入显式的 `⚡ 安装并启用 Hook` 与 `🗑️ 卸载并禁用 Hook` 按钮，并与模式选择框进行状态联动，提升控制面板的易用性。

---

## 2. 详细技术方案

### 2.1 后端接口与逻辑
由于后端现有的 `/api/hooks/toggle` 接口在切换为 `disabled` 模式时，会自动调用 `hooksManager.uninstallAgentHook(agentId)`；在切换为非 `disabled` 模式时，会自动调用 `hooksManager.installAgentHook(agentId)`。
因此，后端**不需要任何改动**，可直接利用现有接口支持按钮的操作：
- **安装动作**：前端发送请求至 `POST /api/hooks/toggle`，参数为 `{ agentId: agentId, mode: 'strict' }`。
- **卸载动作**：前端发送请求至 `POST /api/hooks/toggle`，参数为 `{ agentId: agentId, mode: 'disabled' }`。

### 2.2 前端界面升级 (`local-daemon/public/index.html`)

修改 `local-daemon/public/index.html` 中的 `fetchHooksStatus()` 渲染逻辑：
1. **添加操作按钮**：根据平台状态 `h.installed` 动态在卡片底部输出操作按钮。
2. **模式下拉框状态联动**：
   - 若平台 Hook 尚未安装 (`h.installed === false`)：
     - 下拉选择框应处于 `disabled`（不可用）状态，提示用户先安装。
     - 下拉框的显示透明度降低（`opacity: 0.5; cursor: not-allowed;`），且默认选中 `Disabled`。
   - 若平台 Hook 已经安装 (`h.installed === true`)：
     - 下拉选择框为启用状态，用户可正常在 `strict`（强拦截）、`monitor`（静默审计）与 `companion`（伴侣随动）间进行模式切换。

---

## 3. 验证计划

### 3.1 自动化测试与检查
- 检查修改后的 HTML 是否有语法错误或标签未闭合。
- 确保浏览器控制台无 JS 执行报错。

### 3.2 手动验证步骤
1. 打开 Hook 控制面板。
2. 找到一个未安装 Hook 的客户端平台（例如 `Codex CLI`）。
3. 检查其“模式设定”下拉菜单是否为禁用（变灰）状态，且此时只显示 `⚡ 安装并启用 Hook` 绿色按钮。
4. 点击该安装按钮，确认状态瞬间变为 `保护中 (Hook 已写入)`，按钮切换为 `🗑️ 卸载并禁用 Hook` 红色按钮，同时“模式设定”下拉菜单变为可用状态。
5. 在下拉菜单中切换模式为 `📊 静默审计 (Monitor)` 或 `👾 伴侣随动 (Companion)`。
6. 点击该平台的卸载按钮，验证状态变回 `不做操作 (Hook 未写入)`，按钮变回绿色安装按钮，且模式下拉菜单恢复为禁用状态。
