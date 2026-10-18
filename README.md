# Pi Aftercare

面向服饰电商退换货的 Agent 项目。主应用使用 TypeScript 与 Pi SDK，Python 用于后续评测和数据处理。

## 当前状态

完成项目骨架、独立运行环境和依赖配置，并实现退换货业务的内存模拟：订单归属、同款尺码换货、部分退货、方案确认、库存版本校验、申请创建和幂等重试。当前不提供真实退换货或资金操作，数据不持久化。

HTTP 接口、6 个 Pi 业务工具、外部模型 API 连接和命令行多轮对话已实现。`npm run demo` 离线演示确定性业务流程，`npm run chat` 通过配置的外部 API 驱动 Agent。已通过本机外部模型 API 完成一次真实模型售后闭环联调；自动化集成测试使用模拟 HTTP 响应和实际 Pi SDK 执行循环。售后政策当前是结构化模拟规则，尚未实现 RAG。

2026-10-18 初始化验证通过：TypeScript 类型检查、Pi SDK 离线会话创建、健康接口检查、编译、编译产物启动及本机 HTTP 请求、Python 虚拟环境和依赖导入。验证完成后已停止临时服务。Git 仓库已初始化；按照项目协作要求，每完成一组修改并验证后创建提交。

## 环境

- Node.js 24.22.0，项目本地目录 `.runtime/node/`，下载自 Node.js 官网并核对 SHA-256。
- npm 11.19.1，随项目本地 Node.js 分发。
- Pi SDK `@earendil-works/pi-coding-agent` 固定为 1.2.0，与本地 Pi 源码版本一致，使用 npm 官方发布包。
- Node 依赖保存在本项目 `node_modules/`，精确版本由 `package-lock.json` 锁定；通过 `overrides` 将 Pi 系列间接依赖统一为 1.2.0。
- Python 3.12.14，虚拟环境 `.venv/`；依赖由 `uv.lock` 锁定。
- npm/uv 缓存放在本项目 `.cache/`，不修改全局 Node/Pi 安装。

Node.js 不使用 Python 的虚拟环境机制；此项目用本地运行时和 `node_modules` 隔离 Node 环境，用 `.venv` 隔离 Python 包。Python 解释器由已有 3.12 运行时提供。

## 使用

在项目根目录：

```bash
source scripts/activate.sh
node --version
python --version
npm run check
npm run dev
```

服务地址 `http://127.0.0.1:3000`，健康检查 `http://127.0.0.1:3000/health`。按 Ctrl+C 停止。

不激活环境也可以使用包装入口，它始终使用项目自己的 Node.js：

```bash
./scripts/npm run check
./scripts/npm run dev
./scripts/npm run build
./scripts/npm start
```

初始化检查不需要模型 API key，也不发起模型调用。后续启用模型和数据库时再配置 `.env`；示例在 `.env.example`，真实配置不入 Git。

## 业务演示

```bash
./scripts/npm run demo
./scripts/npm test
```

服务启动后，查询演示客户 Alice 的订单：

```bash
curl -H 'Authorization: Bearer demo-alice' http://127.0.0.1:3000/orders/O-1001
```

另一位演示客户 Bob 使用 `Bearer demo-bob`，订单为 `O-2001`。令牌是本地模拟数据，不是生产登录机制；所有实例默认只监听本机。数据保存在进程内存，重启或开发模式重新加载会重置。

接口、工具与规则见 [业务闭环说明](docs/业务闭环.md)。

用户独立部署模型服务，本机推理程序记录见 [独立模型服务记录](docs/本地模型部署.md)。Agent 只消费模型 API，不管理模型文件或推理进程。首轮真实模型联调记录见 [API 联调记录](docs/真实模型联调记录.md)。

真实模型服务就绪后，在本项目配置 `.env`，运行 `./scripts/npm run chat`。用户确认通过 `/confirm <方案ID>` 完成。配置、边界和恢复说明见 [Agent 对话与 API 接入](docs/Agent对话与API接入.md)。

## 依赖

模型通过外部兼容 Chat Completions 的 HTTP API 接入，配置见 `.env.example` 的 `MODEL_*` 字段。Agent 不启动、停止或加载推理服务，不读取模型权重。推理服务与业务项目独立运行，连接地址可按部署环境调整。

- 应用：Pi SDK、Fastify、pg、dotenv、typebox。
- 开发：TypeScript、tsx、Node.js/pg 类型定义。
- Python：httpx；开发依赖 pytest。

依赖安装默认关闭生命周期脚本，与 Pi 官方发布包的安装方式一致。`package-lock.json` 和 `uv.lock` 应纳入版本控制。

## 目录

```text
src/domain/      订单、方案、确认、申请与模拟数据
src/http/        HTTP 路由和演示身份
src/agent/       Pi 业务工具及会话工厂
tests/           业务约束、接口和工具测试
scripts/         环境入口及初始化检查
evals/           Python 评测与数据脚本
docs/            业务流程与接口说明
.runtime/node/   本地 Node.js（忽略）
.venv/           Python 虚拟环境（忽略）
node_modules/    Node 依赖（忽略）
```

## 恢复依赖

已有项目 Node 环境时运行 `./scripts/npm ci`。Python 使用 `uv sync --frozen --cache-dir .cache/uv`；如本机缺少 Python 3.12，需要先提供对应解释器。

`.runtime/` 不进入 Git；换机器时按 `.node-version` 安装匹配平台的 Node.js，并放到 `.runtime/node/`，或使用自己的版本管理器按此版本启动 npm。

## 开发进度

当前完成：模拟业务闭环、HTTP API、Pi 工具注册、外部模型 API 客户端、命令行多轮对话、显式确认与运行限制、业务约束及模拟 API 集成测试。

已完成首轮真实模型联调；后续补充多场景模型评测、PostgreSQL 持久化与事务、政策检索、故障注入和 τ-bench 适配。内存中的幂等记录在重启后会丢失，当前结果不能视为已实现跨进程或重启恢复。
