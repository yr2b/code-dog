# 后端与前端 Docker 部署实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将整个 Node.js 后端（及其包含的静态前端服务）容器化，通过 Docker Compose 部署运行，并保证其与宿主机 AI 代理钩子的同步和端口通信完好。

**Architecture:** 
编写 `local-daemon/Dockerfile` 以及根目录 `docker-compose.yml`。通过挂载卷形式，把宿主机配置目录（`.claude`, `.config/Antigravity`, `.gemini`, `/tmp`）挂载进容器，确保宿主机与容器共享状态。

**Tech Stack:** Docker / Docker Compose / Node.js

---

### Task 1: 创建 Dockerfile

**Files:**
- Create: `local-daemon/Dockerfile`

- [ ] **Step 1: 编写 local-daemon/Dockerfile**

在 `local-daemon/Dockerfile` 中输入以下配置：

```dockerfile
FROM node:20-slim

# 安装 SSH 客户端（用于 nokey@localhost.run 隧道）和 jq 依赖
RUN apt-get update && apt-get install -y openssh-client jq && rm -rf /var/lib/apt/lists/*

# 预先创建临时 SSH 目录并赋予完全读写权限，防止 SSH 写入 known_hosts 时因为权限拒绝报错
RUN mkdir -p /home/zyx/.ssh && chmod 777 /home/zyx/.ssh

WORKDIR /home/zyx/code-project/ai-execution-reminder/local-daemon

# 拷贝依赖包配置
COPY package.json package-lock.json ./

# 运行依赖安装
RUN npm ci

# 拷贝后端代码
COPY . .

EXPOSE 4000 4001

CMD ["node", "server.js"]
```

---

### Task 2: 创建 docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: 编写根目录 docker-compose.yml**

在根目录的 `docker-compose.yml` 中输入以下服务配置：

```yaml
version: '3.8'

services:
  backend:
    build:
      context: ./local-daemon
      dockerfile: Dockerfile
    container_name: aegis_pet_backend
    user: "${UID}:${GID}"
    environment:
      - HOME=/home/zyx
    volumes:
      # 映射项目目录，确保路径和宿主机保持完全一致以契合 hook 里的绝对路径
      - .:/home/zyx/code-project/ai-execution-reminder
      # 避免宿主机的 node_modules 覆盖容器内的 node_modules
      - /home/zyx/code-project/ai-execution-reminder/local-daemon/node_modules
      # 映射配置及临时状态，实现双向同步
      - /home/zyx/.claude:/home/zyx/.claude
      - /home/zyx/.config/Antigravity:/home/zyx/.config/Antigravity
      - /home/zyx/.gemini:/home/zyx/.gemini
      - /tmp:/tmp
    ports:
      - "4000:4000"
      - "4001:4001"
    restart: always
```

---

### Task 3: 启动容器并进行端到端验证

- [ ] **Step 1: 编译并拉起服务**

在根目录下运行以下命令（传入当前的 UID 和 GID）：
Run: `UID=$(id -u) GID=$(id -g) docker compose up --build -d`
Expected: SUCCESS

- [ ] **Step 2: 验证容器状态**

Run: `docker compose ps`
Expected: `aegis_pet_backend` 处于 running 状态。

- [ ] **Step 3: 验证网页端与配置同步**

在网页浏览器中访问 `http://localhost:4000` 并检查控制台。在终端中检查配置同步：
Run: `cat /tmp/aegis_pet_config.json`
Expected: 能够查看到正确的 JSON 格式配置输出。
