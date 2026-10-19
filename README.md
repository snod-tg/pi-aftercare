# Pi Aftercare

基于 **Pi SDK 的服饰电商售后 Agent**：查询订单、检索适用政策、核对尺码库存、生成报价，经用户在网页确认后创建申请。支持 PostgreSQL 事务、幂等恢复和完整会话持久化。

技术栈：TypeScript · Pi SDK 1.2.0 · Fastify · React/Vite · PostgreSQL · Python/τ-bench。模型独立部署，应用只消费外部 HTTP API。

![真实模型生成方案与政策依据](docs/images/live-demo-quote.png)

这是可演示、可测试的实习项目，使用模拟商家、订单和公开演示身份，不处理真实资金或物流。2026-10-19 已用真实 Qwen3.5-4B 完成网页闭环及刷新、后端重启恢复，见[演示与验收记录](docs/演示与验收记录-2026-10-19.md)。

## 快速启动

需要 Node.js **24.22.x**、npm **11.x**、PostgreSQL 17，以及已独立运行、支持工具调用的 Chat Completions 兼容模型 API。Python 仅评测需要。

```bash
# 项目根目录；已有 .env 时不要覆盖
npm ci --ignore-scripts
cp .env.example .env
```

在 `.env` 配置以下项，模型名须与 API 暴露的名称一致：

```dotenv
MODEL_BASE_URL=http://127.0.0.1:8080/v1
MODEL_NAME=aftercare-4b
MODEL_API_KEY=local
MODEL_CONTEXT_WINDOW=32768
MODEL_MAX_OUTPUT_TOKENS=2048
AGENT_TIMEOUT_MS=120000
# 使用自己的连接；不要提交真实密码
DATABASE_URL=postgresql://aftercare:YOUR_PASSWORD@127.0.0.1:55432/pi_aftercare
```

模型服务实际窗口应至少为 32K；修改应用配置不能扩大服务窗口。本次演示使用 Qwen3.5-4B、关闭 thinking、独立 vLLM 服务，见[服务器模型说明](docs/服务器模型部署与测速-2026-10-19.md)。其他兼容模型的质量与耗时需单独验证。

数据库可连接已有 PostgreSQL。macOS Apple Silicon 也可创建项目专用实例：

```bash
# 仅首次缺少 PostgreSQL 时安装
brew install postgresql@17
# 不要预填示例 DATABASE_URL，脚本自动生成真实连接并写入 .env
npm run db:local -- start
```

辅助脚本默认程序路径 `/opt/homebrew/opt/postgresql@17/bin`、端口 `55432`、数据目录 `.data/postgres/`，其他路径用 `PG_BIN` 指定。已有 `DATABASE_URL` 会保留；若已填占位连接，先改为有效连接或删去该行再运行辅助脚本。

```bash
# 迁移、保留式初始化、构建并启动网页
npm run demo:web
```

打开 **http://127.0.0.1:3000/**。该入口使用独立 schema `aftercare_demo`，重复启动保留历史和申请。已有 `.runtime/node/` 时可把 `npm` 换成 `./scripts/npm`；新克隆使用 PATH 中的 Node/npm 即可。`.runtime/` 不随仓库分发。

## 两分钟演示

1. 默认 Alice，订单 `O-1001`。点击快捷需求，或输入“订单 O-1001，T 恤换 L 码，外套退掉”。
2. 查看政策原文、版本、检索时间和报价：T 恤换 L，外套退款 ¥199。此时尚未创建申请。
3. 刷新页面，确认历史与待确认方案恢复。点击 **确认并提交**。
4. 查看真实后台回执：**等待寄回**、预计退款 ¥199、**退款尚未开始**。
5. 再刷新，或停止网页服务后用相同命令重启。输入“查询刚才申请的状态，不要重复提交”，应读取同一申请。

“新的对话”不重置已办理的商品。录制新一轮演示时选择新 schema，避免删除旧数据：

```bash
DEMO_DATABASE_SCHEMA=aftercare_demo_take2 npm run demo:web
```

![真实模型创建申请](docs/images/live-demo-receipt.png)

## 架构与执行边界

```mermaid
flowchart LR
  U[顾客网页 React] -->|消息 / SSE| H[Fastify 会话服务]
  U -->|按钮确认| G[宿主确认与授权]
  H --> P[Pi SDK Agent 循环]
  P <-->|HTTP / 工具调用| L[独立模型 API]
  P --> T[7 个受限业务工具]
  G --> T
  T --> R[政策 BM25 检索]
  T --> B[订单 / 报价 / 申请服务]
  B -->|事务 / 商家行锁 / 幂等| DB[(PostgreSQL)]
  H -->|Pi 检查点 / 消息 / 回执| DB
```

- **模型决定查询步骤**，宿主负责权限与确认。工具只暴露业务能力，无终端、文件操作或确认工具。
- **政策可追溯**：按商家、版本和生效时间过滤 BM25 原文；资格与金额由业务规则计算，检索文字不能覆盖权限。
- **写入可恢复**：确认绑定方案，稳定操作键绑定参数；创建时重新校验订单、库存与政策版本，再在事务内写入。
- **会话可恢复**：保存完整 Pi 工具上下文和网页历史；中断结果标记未知，先查实际状态，不自动重放旧写操作。

设计取舍与代码入口见[架构与面试讲解](docs/架构与面试讲解.md)。

## 验证与评测

| 验证层 | 2026-10-19 结果 | 范围 |
|---|---|---|
| Node 测试与构建检查 | 50 通过；3 个 PG 专用测试在普通检查中跳过 | 业务、工具、HTTP/SSE、类型、SDK 与构建 |
| 单独真实 PostgreSQL 测试 | 3/3 通过 | 回滚、竞争库存、并发幂等、重启及 SIGKILL 恢复 |
| Python 评测工具测试 | 37/37 通过 | 原生环境适配、预算、截断保护、执行器 |
| 自建 fixture 回归 | 8 类 × 3 次，24/24 通过 | 可控故障与协议；不代表模型能力分数 |
| 真实 4B 网页验收 | 1 个混合退换货案例通过 | 刷新、重启继续查询、只创建 1 笔申请 |
| 上游 τ-bench test 全量 | 75/165，45.45% | retail 54/115，airline 21/50，单次 trial |
| 修正后定向回归 | 5/13；error=0，step_limit=2 | 已知失败子集，不能外推新全量分数 |

τ-bench 使用上游环境、工具与最终状态奖励，**不是本项目 7 个工具的业务成功率，也非官方榜单配置复现**。全量中 78 项正常结束但目标未达成、6 项 error、6 项步数到限；修正后仍有 8 个定向失败。详见[验收汇总](docs/演示与验收记录-2026-10-19.md)。

```bash
npm run check
npm run test:postgres                 # 真实 PG，隔离 schema
npm run eval -- --mode fixture --trials 3

# 可选评测环境，普通网页不需要
uv sync --extra tau --frozen --cache-dir .cache/uv
npm run check:tau
# 会消费真实模型资源
npm run tau:full -- --domain all --split test --trials 1 --concurrency 4 --output .data/evals/my-full-run
```

全量脚本、断点续跑与进度见[评测说明](evals/README.md)。历史[全量分析](docs/评测分析-4B-vLLM四任务并行-2026-10-19.md)与[定向回归](docs/修正回归结果-2026-10-19.md)保留原始口径。

## 项目材料与目录

- [真实演示、截图与验收记录](docs/演示与验收记录-2026-10-19.md)
- [架构图、取舍与源码导航](docs/架构与面试讲解.md)
- [简历项目描述](docs/简历项目描述.md)
- [网页接口与持久化](docs/网页使用说明.md)、[事务边界](docs/持久化与事务.md)、[故障场景](docs/故障注入与评测.md)

```text
web/                  React 对话、方案确认、政策、回执
src/agent/            Pi 会话、工具、模型 API、预算与恢复
src/domain/           售后规则、方案、确认、库存、申请
src/retrieval/        政策版本过滤与 BM25
src/http/             认证、会话接口、SSE
src/storage/          业务事务和会话存储
migrations/           业务与会话表
tests/                业务、协议和数据库检查
evals/                τ-bench 适配、全量运行、分析
docs/                 截图、验证记录、架构与求职材料
```

边界：演示令牌不适用于生产；商家级行锁优先保证一致性，未证明生产吞吐；BM25 尚未扩展为向量或混合检索；完整历史暂未压缩；4B 仍有目标理解和动作顺序错误。未配置数据库时使用进程内存，不具备重启恢复能力。密钥保留在后端 `.env`，不要放入 `VITE_*` 或提交 Git。
