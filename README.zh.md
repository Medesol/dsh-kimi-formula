# dsh-kimi-formula

让 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 通过 [Kimi (Moonshot AI)](https://platform.kimi.com) 官方 **Formula API** 使用全部官方工具——包括**联网搜索**——只需要你聊天已在用的那把 Kimi API key，不需要 DeepSeek / Exa / Perplexity 任何一家的 key。

[English README](README.md)

## 这是什么

DSH 内置的 `web_search` 工具自带三个搜索提供方（DeepSeek、Exa、Perplexity）。如果你跑的是 Kimi 模型（比如走 `moonshotai-cn` 的 `kimi-k3`）而没有这三家的 key，这个工具就是摆设。本插件对接 Kimi 官方推荐的 [Formula API 官方工具通道](https://platform.kimi.com/docs/guide/use-official-tools)，补上这个缺口：

1. **`ctx.web` 搜索提供方（`kimi-official`）**——接入 DSH 的 web 能力 seam，让*内置* `web_search` 工具获得 Kimi 原生检索。每次搜索运行一个辅助 chat 循环：模型声明官方 `web_search` 函数工具 → 产出 `tool_calls` → 插件按 Formula API 原样执行 fiber（加密信封原样回灌）→ 模型综合出带来源引用的答案。答案进 `content`；`sources[]` 从模型自己引用的链接中提取（Kimi 不向客户端暴露结构化搜索结果）。
2. **10 个模型可见的 `kimi_*` 工具**——每个对应一个官方 formula，直接执行 fiber：`kimi_convert`、`kimi_date`、`kimi_base64_encode`、`kimi_base64_decode`、`kimi_random_choice`、`kimi_memory`、`kimi_excel`、`kimi_fetch`、`kimi_rethink`、`kimi_mew`。

> 官方文档还列有 `quickjs` 和 `code-runner`，但当前在 `api.moonshot.cn` 返回 404（formula not found），故未注册。可运行 `node scripts/fetch-formula-tools.mjs` 复查；平台上线后在 `src/formula-tools.js` 的表里补两行即可。

## 前提

- 可用的 [DSH](https://github.com/deepseek-ai/deepseek-harness) 环境（`web` profile，即你用 `dsh web`），Node.js ≥ 22.19。
- 一个 Kimi API key（[platform.kimi.com](https://platform.kimi.com) 申请）。如果你已经在 DSH 的 **Models** 页配置过 Moonshot 提供方，插件会直接复用那个凭据（`MOONSHOTAI_CN_API_KEY`），无需额外设置。

## 安装

**一条命令**——`dsh plugin` 底层是 pnpm，会直接从 GitHub 拉取并自动安装运行时依赖：

```bash
dsh plugin --profile web add github:Medesol/dsh-kimi-formula
# → 提示 "declares no dsh.bundle — installed as a plain dependency" 属正常，
#    插件靠下面的 patch 行激活
```

<details>
<summary>备选：从本地克隆安装（用于二次开发）</summary>

```bash
git clone https://github.com/Medesol/dsh-kimi-formula.git
cd dsh-kimi-formula
pnpm install   # 裸路径 add 是 link 安装，依赖从这里解析
dsh plugin --profile web add "$PWD"
```

</details>

编辑 profile 用户补丁层 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
# 把 web seam 的搜索提供方切换为 kimi（patch 会整段替换 config，fetchProvider 需重述）
- id: web
  config:
    searchProvider: kimi-official
    fetchProvider: http

# 挂载本插件
- insert:
    - id: kimi-formula
      name: 'dsh-kimi-formula'
```

重启 `dsh web` 生效（profile 带 `patchReload: live` 时保存即热生效，无需重启）。

**验证**——新开会话，依次问：

```
用 web_search 查一下 Kimi K3 的最新消息
用 kimi_date 算一下 2026-01-01 到今天有多少天
```

卸载：`dsh plugin --profile web remove dsh-kimi-formula`，并删掉上面的 patch 行。

## 配置

全部字段可选；有 Settings 服务时会安装 `kimi-formula` 配置段（Settings → Plugins），也可直接写在 patch 行的 `config:` 里。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | — | 字面量 key（不推荐写入配置文件） |
| `apiKeyEnv` | `MOONSHOTAI_CN_API_KEY` | 凭据引用；与 Models 页 `moonshotai-cn` 一致。只有 `MOONSHOT_API_KEY` 环境变量时改成它 |
| `baseURL` | `https://api.moonshot.cn/v1` | 国际站改 `https://api.moonshot.ai/v1`；环境变量 `KIMI_FORMULA_BASE_URL` 也可覆盖 |
| `searchProvider` | `true` | 是否注册搜索提供方 |
| `searchModel` | `kimi-k3` | 辅助搜索循环的模型 |
| `searchReasoningEffort` | `low` | `low`/`high`/`max`；搜索场景 `low` 性价比最高 |
| `searchMaxTokens` | `8192` | 每次辅助请求的 max_tokens |
| `searchMaxRounds` | `8` | 搜索循环轮次上限 |
| `formulaTools` | `true` | 是否注册 `kimi_*` 工具 |
| `toolsTimeoutMs` | `60000` | 单次工具调用的协作式超时 |

> `web-search` 按次计费（见[联网搜索定价](https://platform.kimi.com/docs/pricing/tools)），其余官方工具目前限时免费。内置 `web_search` 在 base 组合里的超时是 60s（`tool-web.searchTimeoutMs`），慢搜索偶发超时可用 patch 行调大。

## 工具与样例

每个工具的真实调用样例（参数 + 真实输出）见 [English README](README.md#tools--examples)；本地复现运行：

```bash
node scripts/test-examples.mjs   # 跑一遍全部样例（消耗一次付费搜索）
```

### `kimi_excel` 注意事项

`function` 选算子（17 个：`read_file`、`groupby`、`filter`、`pipe` 等），`arguments` 填该算子参数；`file_id` 必须是 Kimi Files API 的文件 ID，不是本地路径。

> ⚠️ **平台迁移提示（2026-09-01）**：Kimi 文件服务正在向 `file_` 前缀的新版文件 ID 迁移（见[公告](https://platform.kimi.com/docs/api/files-upload)），excel lambda 目前会拒绝 `POST /v1/files` 返回的旧版 ID（报 `File <id> is empty or not found`）。请使用 `file_` 前缀的新 ID（如开发工作台上传的文件），或等迁移完成后重试。

## 排障

- **`configured web provider "kimi-official" is not registered`** —— 插件行没加载：检查 patch 文件，重启 `dsh web`。
- **`Kimi search has no API key for "MOONSHOTAI_CN_API_KEY"`** —— 在 Models 页配置 Moonshot 提供方，或在启动环境中导出该变量，或设置 `apiKeyEnv` / `apiKey`。
- **国际站** —— `baseURL` 改为 `https://api.moonshot.ai/v1`，凭据换成国际站 key。

## 开发

```
src/
  index.js           插件入口：Config schema、apply()、凭据解析
  search-provider.js ctx.web 提供方：web_search 辅助 chat 循环
  formula-tools.js   10 个 kimi_* 工具（静态声明表）
  kimi-api.js        chat completions + formulas 的极简 fetch 客户端
scripts/
  resolve-credential.mjs    凭据解析（环境变量 → ~/.dsh/.credentials.yaml，不打印密钥）
  fetch-formula-tools.mjs   从线上 API 刷新 formula-tools.snapshot.json
  test-examples.mjs         把 README 里的每个样例真机跑一遍
```

纯 ESM、零构建；开发期类型依赖（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-web`、`@deepseek-ai/schemastery`）从 npm 或 DSH checkout 解析。

## 许可证

[MIT](LICENSE)
