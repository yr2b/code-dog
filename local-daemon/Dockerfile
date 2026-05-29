FROM node:20-slim

# 安装 SSH 客户端（用于 nokey@localhost.run 隧道）和 jq 依赖
RUN apt-get update && apt-get install -y openssh-client jq && rm -rf /var/lib/apt/lists/*

WORKDIR /home/zyx/code-project/ai-execution-reminder/local-daemon

# 拷贝依赖包配置
COPY package.json package-lock.json ./

# 运行依赖安装
RUN npm ci

# 拷贝后端代码（配合 .dockerignore 过滤无关文件）
COPY . .

EXPOSE 4000 4001

CMD ["node", "server.js"]
