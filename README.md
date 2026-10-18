# DeepSeek Files Bridge

Magpie 原生提供商插件：将内联图片原样上传至 DeepSeek Files API，缓存文件引用，解决长图片会话先触发 HTTP 413 的问题。

**无需独立代理、无需修改 Magpie 二进制，也不会删除本地图片或聊天记录。** 插件新增提供商 `deepseek-files`，原来的 `deepseek` 提供商保持不变。

**0.3.0 已完成内置 DeepSeek 能力对照核查**：三种客户端协议、思考工具回放、namespace / custom 工具、JSON、视觉、官方 Pro 搜索、价格目录、余额与路由状态。完整证据和宿主限制见 [核对表](docs/PARITY.md)。

## 安装

需要支持 OpenCode 提供商插件的 Magpie。已在 Windows Magpie **0.1.1282**、Bun **1.4.3** 中验证。

```sh
magpie plugin add github:disturbwe/magpie-deepseek-files
magpie plugin login deepseek-files
```

登录时选择：

1. **DeepSeek API key**：输入自己的官方 API key。
2. **Import existing Magpie DeepSeek API key**：从本机 Magpie 的官方 `deepseek` 提供商导入现有 key，不显示 key、不修改原提供商。

需要与内置提供商相同的账户/密钥管理链接和 maker 目录时，可补充这些 Magpie 提供商设置（不复制密钥）：

```sh
magpie provider set deepseek-files catalog=deepseek website=https://platform.deepseek.com keys=https://platform.deepseek.com/api_keys
```

然后在 Codex / Magpie 模型选择器中选择：

```text
deepseek-files/deepseek-flash
```

**只有选择这个提供商才会启用文件适配。** 继续选择 `deepseek/deepseek-flash`，或路由组中仍指向原提供商的成员，仍使用原来的发送路径。需要时将相应组成员改成 `deepseek-files/deepseek-flash`。

## 官方模型列表与余额

从 **0.2.0** 起，登录后通过 `GET https://api.deepseek.com/models` 获取该 key 可用的全部官方模型。“重新获取模型”及以下命令都会重新询问官方接口：

```sh
magpie provider refresh deepseek-files
```

模型名、准确的上下文窗口、最大输出、输入/输出模态和推理档位使用官方返回值；新模型无需升级插件即可出现在供应商列表中，用户的已选模型仍由 Magpie 管理。官方下架的 ID 不会被静态列表加回来。接口失败时由 Magpie 保留上次成功的列表并显示获取失败；401 标记登录失效，403、限流及临时故障不会误注销账号。

当前官方列表包含 `deepseek-flash` 和 `deepseek-v4-pro`。Flash 支持图片，V4 Pro 是纯文本模型，插件不会把后者标成支持视觉。两者都经过原生插件传输；只有请求含内联图片时才会调用 Files API。

余额通过官方 `/user/balance` 查询，显示在 Magpie 的用量/余额区域，多币种顺序稳定。赠送/充值明细显示为不参与配额路由的旁列窗口；余额耗尽单独报告用尽，避免继续选中该账号。未登录时只显示离线启动用的模型快照，不会请求官方接口。

开发安装也支持本地路径：

```sh
git clone https://github.com/disturbwe/magpie-deepseek-files.git
magpie plugin add ./magpie-deepseek-files
```

## 工作方式

1. Magpie 把最终请求交给插件的 `auth.loader.fetch`。
2. 插件识别 Responses `input` 中的图片，包括 `function_call_output` / `custom_tool_call_output` 内的图片；也支持 Chat Completions 图片块。
3. 原始图片字节通过 `POST https://api.deepseek.com/files` 上传，不缩放、不转码。
4. 用 `file_id` 替换发送给 DeepSeek 的 Base64；所有文字、工具调用 ID、顺序及配对保留。
5. 相同凭证、相同图片复用磁盘缓存，重启后仍有效。同一插件进程内并发请求会合并重复上传，最多同时上传四张图片。
6. 文件过期或上游明确报告文件失效时，重新上传，最多重试一次。普通 413 不会原样循环重试。
7. 流式响应直接透传，不缓冲整段回复，也不会在回复开始后重放推理请求。取消请求会释放等待者；如果另一请求仍在使用同一个上传，不会误取消它。

插件不修改 Codex 历史。最新截图和旧截图都被保留，只改变这一次上游请求中的图片表示。

## 缓存与隐私

- 默认缓存目录：`~/.config/magpie/deepseek-files-cache`，位于原 Magpie 配置目录旁。
- 缓存只包含哈希路径、文件 ID、过期时间和字节数。**不写入 API key、图片内容、提示词或会话历史。** API key 的保存沿用 Magpie 自己的登录机制。
- 用户手工添加的模型 ID 单独保存在配置目录的 `deepseek-files-manual-models.json`，保证连续刷新仍保留手工模型；该文件只记录模型 ID，不含密钥或会话内容。
- 缓存按 key 的 SHA-256 指纹隔离。即使两个 key 属于同一 DeepSeek 账号，也保守地分开缓存。
- 上传文件设置 **7 天过期**，避免永久积累。到期后需要再次使用的图片会从请求中重新上传。
- 文件与推理请求只发送至 `https://api.deepseek.com`，不跟随重定向，不下载外部图片 URL。
- 上传失败会明确报错，**不会省略图片、静默切换供应商或提交不完整上下文**。
- 本插件直接使用宿主提供的 `fetch`，沿用 Magpie 插件宿主的网络/代理环境。

环境变量（可选，设置后重启 Magpie）：

| 变量 | 用途 |
| --- | --- |
| `DEEPSEEK_FILES_CACHE_DIR` | 自定义缓存目录 |
| `MAGPIE_CONFIG_DIR` | 本插件读取 Magpie 配置的目录；适用于非默认安装位置 |

## 限制

文件引用解决的是**请求体字节数**，不会增加模型的 token 上下文容量，也不会免除视觉 token 计费。

DeepSeek 当前文档规定：请求体最多 48 MiB，单个上传文件最多 64 MiB，单次最多 600 张图，包含文件引用时图片总大小最多 200 MiB。若文字或工具输出本身过大，仍需要压缩会话。这里没有通过删图规避这些限制。

模型列表以官方接口为准。该接口不提供价格；估算价格优先跟随 Magpie 自己的 DeepSeek maker 目录，目录缺失时 Flash 和 V4 Pro 使用 2026-10-18 官方峰时价格快照。新模型不会套用 Flash 的价格。实际费用以 DeepSeek 账单为准。

本插件的上游使用 Responses，Chat 和 Anthropic 客户端由 Magpie 适配。官方 `web_search` 目前只在 V4 Pro 上可用。插件用量卡的界面与内置 key 卡不同，内置余额趋势图不在当前插件 RPC 的可扩展范围；具体边界见核对表。

官方参考：

- [DeepSeek Files API](https://api-docs.deepseek.com/guides/files_api/)
- [DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/)
- [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/)
- [DeepSeek Models API](https://api-docs.deepseek.com/api/list-models/)
- [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [Magpie 插件机制](https://github.com/yetone/magpie/blob/main/docs/reference.md#plugins)

## 验证

零运行时依赖。离线测试使用 Node.js 20.3+，不调用外部 API：

```sh
npm test
npm run check
```

覆盖上传字节完整性、工具配对、磁盘缓存、账号隔离、失效重传、流式透传、并发去重、取消、错误处理，以及超过 48 MiB 的输入。

真实接口测试是**手动选择运行**的，会使用现有官方 API key 并产生正常 API 用量：

```sh
npm run smoke
node scripts/smoke.mjs --rollout /path/to/local-rollout.jsonl
node scripts/gateway-smoke.mjs --rollout /path/to/local-rollout.jsonl
```

最后一条经过运行中的本地 Magpie `127.0.0.1:3425` 及其原生插件宿主，验证大请求和 SSE。回放只使用会话中的图片和诊断指令，不重放工具调用、不执行原任务。测试摘要写入被 Git 忽略的 `validation/`，不保存原图片、完整会话或 key。

首次真实验证：31 张原图加一次重复引用，**52,118,816 字节 → 2,804 字节**，全部 32 个图片引用保留；DeepSeek 返回 HTTP 200。重复请求全部命中缓存。经本地 Magpie 原生插件宿主发送同样规模请求以及 SSE 也通过。

## 更新和卸载

```sh
magpie plugin update
magpie plugin rm magpie-deepseek-files
```

卸载后选回原 `deepseek/deepseek-flash`。磁盘缓存可手动删除；已上传文件在设置的 7 天期限内自动过期。不要在公开 issue 中粘贴 API key、`plugin-auth.json` 或完整聊天记录。

## English

A native Magpie/OpenCode provider plugin that replaces inline DeepSeek images with cached Files API references. Originals are uploaded unchanged, scoped per credential, and expire after seven days. It preserves text, tool pairs, streaming, cancellation and local conversation history. Select `deepseek-files/deepseek-flash` after installing and signing in. No standalone proxy, binary patch, runtime dependency, or image eviction is required.

## 图标来源

DeepSeek 品牌图标来自 [Lobe Icons](https://github.com/lobehub/lobe-icons)，使用其 MIT 许可。插件随包提供 SVG，提供商图标无需联网加载。
