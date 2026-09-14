# dsh-profile-multica

[English](README.md) | 中文

一个可安装的社区 bundle，通过带版本的 JSONL 进程协议把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) CLI 接入 Multica。

请求、事件、取消和退出语义见[协议参考](docs/protocol.zh.md)。

安装后，独立 profile 提供三个命令：

```bash
dsh --profile multica --probe
dsh --profile multica --list-models
dsh --profile multica --stdio
```

`--probe` 输出 Multica 使用的发现帧。`--list-models` 投影已安装的 DSH 提供方、模型与推理等级。`--stdio` 接受一个版本 1 的 execute 请求，以 JSONL 流式输出 Agent 和 Session 事件，允许取消活动请求，刷新持久化数据，输出一个终态结果后退出。协议帧写入 stdout，诊断写入 stderr。

execute 请求可以创建新 Agent 或恢复持久化 Session，选择提供方、模型与推理等级，并挂载任务作用域内的 stdio 或 Streamable HTTP MCP server。`MULTICA_DSH_SESSION_ROOT` 指定 JSONL 持久化目录。`DSH_PERMISSION_MODE` 可设为 `read-only`、`workspace-write` 或 `danger-full-access`，默认为 `workspace-write`。该传输不支持交互审批，因此超出所选策略的操作会直接失败。

DSH 会从模型发起的每个子进程中移除凭据形态的变量，因此本桥接只豁免其中一个名字：daemon 注入的 `MULTICA_TOKEN`——agent 调用 `multica` CLI 读取任务、发表评论时需要的任务令牌。其余 `*TOKEN*`、`*KEY*`、`*SECRET*`、`*PASSWORD*` 变量仍会被擦洗。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- `@deepseek-ai/dsh` `0.1.0-rc.7` 或兼容的后续预发布版本
- `PATH` 中存在 pnpm，供 `dsh plugin` 使用

## 安装

发布到 npm 后：

```bash
npm install --global @deepseek-ai/dsh@0.1.0-rc.7
dsh plugin --profile multica add dsh-profile-multica
dsh --profile multica --probe
```

安装本地 checkout 时，先生成 tarball：

```bash
pnpm install
pnpm pack
dsh plugin --profile multica add /absolute/path/dsh-profile-multica-0.1.0.tgz
dsh --profile multica --probe
```

plugin 命令会在官方 `dsh-base` 上创建 `multica` profile、安装该 bundle，并追加它声明的 patch layer。安装 profile 与运行 Multica daemon 必须使用同一操作系统用户；自定义 `DSH_HOME` 时，两边也必须使用同一个值。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run smoke:pack
pnpm pack
```

`smoke:pack` 会打包当前 checkout，使用受支持的官方 DSH 版本把 tarball 安装到隔离 profile，验证 `--probe`，然后删除临时 profile。

发布前请为 GitHub 仓库添加 `dsh-plugin` topic，并使用全新安装的官方 CLI 验证打包后的 tarball。

## 模型体验

桥接器不添加系统提示词或工具 schema。它把 Multica 输入作为普通用户消息提交，并投影已有的 DSH 事件。

## 限制

- 一个进程只接受一个 execute 请求；Multica 会为每项任务启动新进程。
- 协议没有审批响应。请为目标环境选择合适的非交互 permission mode。
- 模型发现会把失败的提供方写入 stderr，并继续处理其他提供方。
- 该包依赖预发布阶段的 DSH API；新的 DSH 预发布版本可能需要对应的插件版本。

## 许可证

MIT
