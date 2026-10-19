# 评测与 τ-bench 适配

## 项目售后场景

```bash
./scripts/npm run eval -- --mode fixture --trials 3
./scripts/npm run eval -- --mode live --case response_lost --trials 1
```

fixture 是脚本模型协议回归，不是模型能力分数；live 调用 `.env` 中的真实模型 API。均使用隔离的内存业务状态，不写入用户正在使用的数据库。8 类场景、状态评分、pass^k 和边界见 [故障注入与评测](../docs/故障注入与评测.md)。完整报告在 `.data/evals/`，摘要在 `reports/`。

## 官方 τ-bench 接口

官方仓库固定为 [sierra-research/tau-bench](https://github.com/sierra-research/tau-bench/tree/59a200c6d575d595120f1cb70fea53cef0632f6b)，提交 `59a200c6d575d595120f1cb70fea53cef0632f6b`。这次适配的是原版 τ-bench，不是 τ²-bench。

```bash
uv sync --extra tau --frozen --cache-dir .cache/uv
./scripts/npm run check:tau
./scripts/npm run tau:smoke
```

Python 依赖在项目 `.venv` 内。tau 为可选依赖，常规业务不需要导入任何 τ-bench 包。

`PiTauAgent` 继承官方 `Agent`，实现 `solve(env, task_index, max_num_steps)`，返回官方 `SolveResult`。Python 负责 `env.reset`、`env.step(Action)`、用户模拟器和官方奖励；Node worker 使用真实 Pi SDK，把环境的 tools_info 注册为工具并将工具调用传给 Python。Agent 文本回复映射到官方 `respond` 动作，由用户模拟器生成下一条消息。

这条适配路径只加载目标环境的工具和 wiki，不加载 Pi Aftercare 的 7 个业务工具、个人扩展或编码工具，也不修改业务 Agent 的确认规则。上游任务的标准答案 actions 不会发送给模型。节点进程只负责 API 消费，不管理推理进程。

动作和模型请求均有上限，模型轮次默认 120 秒，Python 等待默认 150 秒；错误、超时或未终止任务不当作成功。API 费用未知，SolveResult.total_cost 为 null，不把未知费用记成免费。报告保留步骤、轨迹、Token、错误和模型配置。

### 自建冒烟任务

`tau:smoke` 使用原生 Env、GetOrderDetails、ReturnDeliveredOrderItems 和官方最终状态奖励，但数据、任务和脚本用户是自建的，只用于验证适配链路，不能报告为官方任务得分。

2026-10-18，真实本地 9B 完成该冒烟任务：reward=1、status=completed，摘要在 `reports/tau-smoke-2026-10-18.json`。3 项 Python 集成测试还覆盖了模型宣称成功但实际写入失败时官方 reward=0、步数上限和模型 API 失败。测试的模型端使用本机模拟 HTTP，Pi SDK 和上游环境真实执行。

### 官方任务运行入口

```bash
.venv/bin/python -m evals.run_tau \
  --domain retail --split dev --task-index 0 \
  --trials 1 --max-steps 30 --output .data/evals/tau-retail-dev-0.json
```

默认用户模拟器也消费模型 API：可以单独设置 TAU_USER_BASE_URL、TAU_USER_MODEL、TAU_USER_API_KEY，否则复用 MODEL_*。用户提示使用官方用户模拟器同一份规则；传 `--user human` 可改为人工输入。每个用户模拟器和模型配置都会影响结果，比较时需固定配置。

已验证官方 retail 的 16 个工具、20 个 dev 任务及原始数据可以正常加载；尚未完成官方任务全量测评，不提供排行榜成绩。官方完整 wiki 和工具定义可能超过当前 8192 上下文，需在独立模型服务上另行配置足够上下文，并同步 MODEL_CONTEXT_WINDOW；修改 Agent 元数据不能扩大推理服务窗口。上下文不足会作为失败记录，不删减官方规则后冒充标准成绩。

## 当前验证

- 43 项 TypeScript 离线测试、类型检查、SDK/HTTP 检查、编译通过。
- 2 项真实 PostgreSQL 集成测试通过。
- 3 项 Python τ-bench/Pi 接口集成测试通过。
- 24 次自建 fixture 场景通过；1 次真实 9B τ 接口冒烟通过。

这几类验证分别证明业务边界、事务一致性、接口兼容及单例模型可用性，不能相互替代。

## 官方全量任务运行脚本

脚本 `evals/run_tau_full.py` 开头附有运行指令，默认顺序遍历固定版本 test 集：retail 115 个、airline 50 个，共 165 个。模型服务需独立启动，连接配置读取 `.env`。

```bash
# 先列任务，不调用模型
./scripts/npm run tau:full -- --domain all --split test --dry-run
# 全量，每个任务跑1次
./scripts/npm run tau:full -- --domain all --split test --trials 1
# Ctrl+C 中断后，使用完全相同配置续跑
./scripts/npm run tau:full -- --domain all --split test --trials 1 --resume
```

默认输出 `.data/evals/tau-full/`：manifest.json 固定任务、代码及不含密钥的配置，runs/ 按任务和 trial 原子保存完整记录，summary.json 每次更新覆盖率、成功率、错误分类与逐任务 pass^k。已有记录不会被默认覆盖；配置或代码变化会拒绝混合续跑，请改用新的 `--output` 目录。

每个 trial 使用独立进程、全新官方环境，默认最长900秒；超时或中断会清理该 trial 的子进程，不会关闭独立模型服务。失败记录按0分保留，后续任务继续执行；续跑不会自动重跑已记录的失败。默认 --max-steps 30。airline 仅支持 test 集，dev/train 需指定 retail。

完整流程结束时，有模型答错但没有执行错误仍退出0；存在接口错误或超时退出2；主动中断退出130。首次运行 --trials 3 可计算 pass^2/pass^3（会跑495次）；没有完成全部重复的任务不参与 pass^k 均值，须一起看覆盖率。

全量执行器的任务枚举、检查点、断点续跑、配置隔离及部分结果汇总已有自动化验证，未自动运行165项真实模型任务。当前8192上下文可能不足以容纳官方完整规则与工具，超限会记录为错误；需在独立推理服务增大窗口，并同步 MODEL_CONTEXT_WINDOW 后再开始正式评测。这里使用本地 API 用户模拟器，结果不是官方排行榜配置的复现。


### 运行中的实时进度

全量脚本在输出目录生成 `progress.log` 和对应的 `progress.jsonl`，显示当前任务、模型请求及环境工具调用；`tail -f <输出目录>/progress.log` 可实时查看。不会写入密钥、对话正文或工具参数。summary.json 仍按完成的 trial 更新。可用 TAU_WORKER_TIMEOUT_SECONDS 配置 Python 等待时间，与 TAU_TURN_TIMEOUT_MS 配合调整。

本轮32768上下文运行参数及进度命令见 [2026-10-19 全量评测](../docs/全量评测进度.md)。

官方任务可用 --task-start/--task-stop 选择每个域的索引范围（包含起点，不含终点）；默认范围仍为全量。双4B独立API配置及前3项复测见 [双4B评测](../docs/双4B评测.md)。

当前运行改为单4B服务，4个模型槽位、每槽32K，评测调度仍为1，见 [单4B顺序全量评测](../docs/单4B顺序全量评测.md)。历史配置和结果保留，各轮不混合计分。


### 四项并行运行

```bash
.venv/bin/python -m evals.run_tau_full --domain all --split test --trials 1 --concurrency 4 --output .data/evals/tau-full-vllm-4
```

`--concurrency` 默认1；四项并行需显式设为4。每个 trial 独立子进程，历史与业务环境隔离，结果逐项保存；进度页面展示全部活动任务。模型服务容量与上下文需独立配置（当前远端4B为4路、每路32768 token）。中断不把未完成项计成失败，原命令加 `--resume` 续跑；配置与代码指纹必须一致。服务器与当前完整运行命令见 `docs/服务器模型部署与测速-2026-10-19.md`。
