# 宠物面板增强与安全退出设计规范 (2026-05-27)

本设计文档旨在指导“AI Secure Guard”本地守护进程及 Web 仪表盘的升级。项目将重构宠物管理页面，增强本地导入的体验，支持公网 pet.json 单链接导入、本地多文件拖拽上传，并优化大量数据的市场加载体验（引入搜索与无限滚动）；同时增加日志保留上限设置与安全退出服务的全屏磨砂遮罩。

---

## 1. 后端 API 变更

### 1.1 `POST /api/pets/import-url` (公网 JSON 链接导入)
*   **请求格式**：`application/json`
    ```json
    {
      "petJsonUrl": "https://example.com/pets/some-pet/pet.json"
    }
    ```
*   **处理逻辑**：
    1. 使用 `fetch` 下载 `petJsonUrl` 并解析为 JSON 结构。
    2. 从 JSON 提取 `id`、`displayName`、`description` 和 `spritesheetPath`。
    3. 将 `spritesheetPath` 结合 `petJsonUrl` 解析出绝对路径：
       `const spritesheetUrl = new URL(spritesheetPath, petJsonUrl).href;`
    4. 调用已有的 `importPetByDetails(id, petJsonUrl, spritesheetUrl)` 自动处理下载、裁剪和打包为 `.bin`。
*   **响应格式**：`{ "success": true, "slug": "..." }`

### 1.2 `POST /api/pets/upload` (本地多文件拖拽/选择上传)
*   为了处理 `multipart/form-data` 文件上传，我们需要在本地守护进程中引入 `multer` 依赖。
*   **请求格式**：`multipart/form-data`
    *   `petJson`：上传的 `pet.json` 配置文件。
    *   `spritesheet`：上传的 Spritesheet 图像文件（webp/png）。
*   **处理逻辑**：
    1. 解析 `petJson` 文件，提取 `id`。
    2. 创建文件夹 `public/pets/<id>/`。
    3. 将 `pet.json` 保存到该目录。
    4. 将 `spritesheet` 重命名为 `spritesheet.webp` 或 `spritesheet.png` 并保存到该目录。
    5. 调用 `petManager.processAndPackagePet(id)` 打包输出 `pet_assets.bin`。
*   **响应格式**：`{ "success": true, "slug": "..." }`

### 1.3 `POST /api/config/retention` (配置日志保留上限)
*   **参数**：`{ "limit": 1000 }`
*   **逻辑**：修改全局 `config.logRetentionLimit` 并调用 `saveConfig()`。

### 1.4 `POST /api/shutdown` (安全还原 Hook 并关闭进程)
*   **逻辑**：
    1. 遍历所有注册平台，逐一调用 `hooksManager.uninstallAgentHook(agentId)`。
    2. 保存最后历史记录，发送 JSON 响应。
    3. `setTimeout` 在 500 毫秒后执行 `process.exit(0)`。

---

## 2. 前端页面重构与交互升级

### 2.1 宠物商店双栏与“我的宠物”展示
*   **“我的宠物”面板**：
    *   加载并过滤本地已导入的所有宠物（通过 `/api/pets/imported` 获取）。
    *   展示宠物名、描述及“激活”按钮。如果当前正在激活中，显示“当前活跃中”状态。
*   **“开源宠物市场”面板**：
    *   **搜索过滤**：顶部增加动态搜索框，输入关键字实时（防抖 200ms）在客户端过滤社区宠物名单。
    *   **无限滚动**：初始化仅渲染过滤结果的前 8 个，滚动到底部时自动追加渲染 8 个，直至显示完毕。

### 2.2 手动导入体验优化
*   提供选项卡或卡片页签切换：
    *   **链接导入**：输入 `pet.json` URL，一键导入。
    *   **拖入/多选上传**：提供拖拽区域。用户将 `pet.json` 与 `spritesheet` 文件拖入该区域，系统自动打包上传。

### 2.3 安全退出与全屏磨砂遮罩
*   增加安全关闭按钮，点击后二次确认。
*   确认后调用 `/api/shutdown`，成功后在页面生成全屏 `backdrop-filter: blur(15px)` 磨砂遮罩，阻断所有操作并提示“系统已安全还原所有 Hook 并已退出”。

---

## 3. 依赖变更
*   需要添加 `multer` 依赖到 `local-daemon/package.json`，方便解析 multipart 形式的文件上传。
