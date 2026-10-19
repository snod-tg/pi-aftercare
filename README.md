# Pi Aftercare

基于 [Pi SDK](https://github.com/earendil-works/pi) 的服饰电商售后 Agent。通过自然语言查询订单、检索政策、核对库存并生成退换货方案，用户在网页确认后才创建申请。

**TypeScript · Pi SDK · React · Fastify · PostgreSQL**

模型推理服务独立部署，应用通过兼容 OpenAI Chat Completions 的 HTTP API 调用模型。项目自带模拟订单与商家政策，可用于本地运行和二次开发，不处理真实退款或物流。

## 功能

- **多轮售后对话**：支持同一订单的换码与部分退货，展示报价、工具执行记录和实际申请回执。
- **可追溯政策检索**：按商家、政策版本和生效时间过滤，使用 BM25 检索原文并返回引用与检索时间。
- **显式确认**：用户必须点击方案卡片确认；普通聊天中的“同意”不能代替授权，模型没有确认工具。
- **事务与幂等**：提交时重新检查订单、政策及库存版本；稳定操作键避免重复申请，响应丢失后可查询原结果。
- **会话持久化**：PostgreSQL 保存完整 Pi 上下文、工具结果、确认记录和网页历史，支持刷新及后端重启恢复。
- **执行约束**：限制模型调用次数、工具调用次数与单轮耗时，支持停止处理；截断生成的工具调用不会执行。

## 架构

```mermaid
flowchart LR
  UI[React 网页] <-->|HTTP / SSE| API[Fastify 会话服务]
  UI -->|方案确认按钮| API
  API --> AGENT[Pi Agent]
  AGENT <-->|HTTP| MODEL[独立模型 API]
  AGENT --> TOOLS[受限业务工具]
  TOOLS --> POLICY[政策 BM25 检索]
  TOOLS --> DOMAIN[售后规则与申请服务]
  DOMAIN -->|事务 / 版本校验 / 幂等| DB[(PostgreSQL)]
  API -->|上下文与会话检查点| DB
```

模型负责决定查询步骤，宿主和业务服务负责客户归属、方案确认、金额计算与提交校验。只注册售后业务工具，不加载终端或文件操作工具。

## 环境要求

- Node.js **24.22.x**、npm **11.x**（版本由 `.node-version` 和 `package.json` 声明）。
- PostgreSQL **17**，用于业务及会话持久化。
- 独立运行、支持工具调用的 Chat Completions 兼容模型服务；建议至少 **32K** 上下文。

### 1. 安装

```bash
git clone https://github.com/snod-tg/pi-aftercare.git
cd pi-aftercare
npm ci --ignore-scripts
cp .env.example .env
```

已有 `.env` 时请直接编辑，不要覆盖。依赖版本由 `package-lock.json` 锁定。

### 2. 配置模型 API

编辑 `.env`：

```dotenv
MODEL_BASE_URL=http://127.0.0.1:8080/v1
MODEL_NAME=aftercare-4b
MODEL_API_KEY=local
MODEL_CONTEXT_WINDOW=32768
MODEL_MAX_OUTPUT_TOKENS=2048
```

`MODEL_NAME` 必须匹配服务暴露的模型名称。使用云端或其他模型时，替换地址、名称和密钥。上下文配置不能超过模型服务实际支持的窗口；应用不会下载模型或启动推理引擎。

### 3. 配置 PostgreSQL

使用已有数据库时，在 `.env` 中填写连接：

```dotenv
DATABASE_URL=postgresql://USERNAME:PASSWORD@127.0.0.1:5432/pi_aftercare
```

也可在 macOS Apple Silicon 上创建项目专用的本地实例：

```bash
# 尚未安装时执行
brew install postgresql@17
# 自动生成凭据并向 .env 写入 DATABASE_URL
npm run db:local -- start
```

辅助脚本默认使用 `/opt/homebrew/opt/postgresql@17/bin`、端口 `55432`，数据保存在 `.data/postgres/`。其他安装路径通过 `PG_BIN` 指定。脚本保留已有 `DATABASE_URL`；若使用自动生成方式，不要先填占位连接。

### 4. 启动网页

```bash
npm run demo:web
```

打开 **http://127.0.0.1:3000/**。启动入口依次执行数据库迁移、保留式初始化、构建和启动，默认使用隔离 schema `aftercare_demo`。重复启动会保留会话、库存及申请，不会重置数据。

如需一套全新模拟订单，选择新的 schema：

```bash
DEMO_DATABASE_SCHEMA=aftercare_demo_take2 npm run demo:web
```

如仅预览内存模式，可不配置 `DATABASE_URL`，运行 `npm run build` 后 `npm start`；该模式重启会丢失数据，不具备持久化能力。

## 使用

1. 默认演示顾客为 Alice，订单为 `O-1001`。输入“订单 O-1001，T 恤换 L 码，外套退掉”，或点击快捷需求。
2. 查看政策原文、方案明细和预计退款。报价阶段不会创建申请或扣减换货库存。
3. 点击方案卡片 **确认并提交**。成功回执表示“等待寄回、退款尚未开始”，不表示退款到账。
4. 刷新页面或重启服务后继续对话，可查询同一申请的状态。

“新的对话”保留历史和已创建的业务记录。“停止”取消后续模型处理，已提交的操作不会回滚；结果不明时先查询申请状态。

命令行对话也可复用相同数据库 schema：

```bash
DATABASE_SCHEMA=aftercare_demo npm run chat
# 终端内使用 /confirm <方案ID> 确认；/quotes 查看待确认方案
```

## 配置

| 变量 | 默认值 | 用途 |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `3000` | 网页监听地址 |
| `MODEL_BASE_URL` | 配置必填 | 模型 API 地址，包含 `/v1` |
| `MODEL_NAME` | 配置必填 | 模型服务中的名称 |
| `MODEL_API_KEY` | 按服务要求配置 | 仅保存在后端 |
| `MODEL_CONTEXT_WINDOW` | 示例 32768 | 模型上下文元数据，与服务实际窗口一致 |
| `MODEL_MAX_OUTPUT_TOKENS` | 示例 2048 | 每次模型输出上限 |
| `AGENT_MAX_MODEL_CALLS` | `8` | 每条用户消息的模型调用上限 |
| `AGENT_MAX_TOOL_CALLS` | `24` | 每条用户消息的工具调用上限 |
| `AGENT_TIMEOUT_MS` | `120000` | 单轮总耗时上限，毫秒 |
| `DATABASE_URL` | 未配置时使用内存 | PostgreSQL 连接 |
| `DATABASE_SCHEMA` | `aftercare` | 直接启动或 CLI 使用的 schema |
| `DEMO_DATABASE_SCHEMA` | `aftercare_demo` | `demo:web` 入口使用的 schema |

完整示例见 [.env.example](.env.example)。不要把模型密钥放入 `VITE_*` 变量或提交到 Git。

## 开发与检查

```bash
# 开发：分别在两个终端启动，网页地址为 http://127.0.0.1:5173
npm run dev
npm run dev:web

# 类型、业务测试、Pi SDK、HTTP 检查和构建；无需真实模型
npm run check
# 单独验证真实 PostgreSQL；使用临时隔离 schema，需要已配置 DATABASE_URL
npm run test:postgres
```

正式构建由 Fastify 同源提供网页；开发时由 Vite 代理 `/api` 请求。测试覆盖确认门禁、身份隔离、库存竞争、事务回滚、幂等重试、超时、取消及会话恢复。普通检查会跳过真实数据库专用测试，需单独运行 `test:postgres`。

## 目录

```text
web/                React 网页
src/agent/          Pi 会话、工具、模型连接与执行限制
src/domain/         订单、报价、确认、库存与申请规则
src/retrieval/      政策检索与有效版本过滤
src/http/           业务 API、会话、认证与 SSE
src/storage/        PostgreSQL 业务及会话存储
migrations/         数据库迁移
scripts/            启动、初始化与检查入口
tests/             项目单元和集成测试
data/policies/      模拟政策原文
```

## 当前边界

- 网页使用公开的本地演示身份；不具备生产客户登录、真实支付和物流能力。默认仅监听本机。
- PostgreSQL 使用商家级行锁保证写入一致性，尚未针对大订单量优化锁粒度。
- 检索使用 BM25，尚未接入向量或混合召回；完整会话历史尚未压缩。
- 模型可能误解需求或选择错误的操作顺序，宿主校验不能证明所有自然语言目标都被满足。
- 中断后不自动重放旧工具调用；多实例停止请求需要路由到持有该轮处理的实例。

## License

[MIT](LICENSE)
