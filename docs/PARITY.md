# 内置 DeepSeek 对照核查

核查日期：2026-10-18。插件版本：0.3.0。

这份表区分插件负责的适配、Magpie 已提供的公共能力，以及宿主接口边界。测试只使用合成提示词、合成图片和模拟工具结果，不执行模型返回的工具、不保存推理文本或凭证。

## 核查范围

| 内置能力 | 插件处理 / 证据 |
| --- | --- |
| 官方模型发现、刷新、增删、已选模型 | `provider.models` 读取官方 `/models`；成功时以官方 ID 为准，失败交给 Magpie 保留已有列表；用户选择由 Magpie 管理 |
| 手工添加模型 ID / 兼容别名 | 区分“曾从官方拉到的 ID”和用户显式添加的 ID；显式模型和配置中的模型声明保留，下架的自动发现模型不会因此复活 |
| 名称、上下文、输出上限、模态、推理档位 | 官方模型元数据；精确读取 1,048,576 / 393,216；Pro 不误标视觉；没有元数据的新 ID 不猜视觉或价格 |
| 价格、缓存命中价格、用户价格覆盖 | 读取 Magpie 自己使用的 DeepSeek 目录；目录缺失才用标明日期的价格快照；用户的 Magpie 模型价格覆盖仍由宿主管理 |
| API key、多个账号、启停、注销、代理 | 原生 `auth` 钩子；Magpie 按账号传入凭证与代理；文件缓存按 key 哈希隔离 |
| 便携版 / XDG 配置目录 | 使用 Magpie 注入的真实配置目录；价格目录支持便携版 cache、XDG cache 与 OpenCode 后备目录 |
| 官方余额、多币种、赠送/充值明细 | `/user/balance`；正余额币种优先、按币种稳定排序；明细用不影响路由的旁列窗口展示 |
| 余额不足、登录失效、临时故障 | 余额耗尽报告路由配额用尽；只有 401 标记登录失效；403、429、5xx、网络问题不误注销账号 |
| Responses、Chat、Anthropic 客户端 | 三种客户端入口通过 Magpie 协议适配；分别实测文本、思考、SSE、JSON、视觉、工具往返 |
| 推理开关和档位 | 官方档位与 `none`；实测思考输出和多轮思考工具回放；Chat `none` 在传输层映射为 `thinking.disabled` |
| Function、namespace、自定义 apply_patch | 实测调用与模拟结果往返；工具参数、调用 ID、顺序和已有推理保持 |
| 工具返回图片 | 三种客户端协议分别实测工具 → 图片结果 → 正确识别颜色；Responses 内含历史工具图片转 file_id |
| DeepSeek 专用 schema 修正 | 补上内置 `deepseekToolPatterns` 的 `\0` → `\u0000`；只遍历工具的 JSON Schema，不改默认值、工具参数字符串或普通消息 |
| 最大输出字段 | Chat `max_completion_tokens` → `max_tokens`；已有明确 `max_tokens` 保留；实测输出不超过请求上限 |
| JSON object / JSON Schema | 三协议实际调用；沿用 Magpie 的格式适配与官方接口行为 |
| 前缀续写 | 实测 Chat 客户端续写；本机旧 CLI 0.1.1275 的内置路径存在 beta 地址错误，单独记录，插件成功不依赖该路径 |
| 官方联网搜索 | 声明 `searches: true`；在支持官方 `web_search` 的 **V4 Pro** 上验证真实 search call 和结果回放。Flash 的官方 Responses 接口不支持该工具 |
| 文件引用、流式、取消、并发、缓存 | 原始图片上传、元数据缓存、7 天失效、同图去重、共享上传取消隔离、过期重传一次；普通流原样透传 |
| 大图片请求 | 54,562,369 字节的合成图片内容，13 个图片引用完整保留，通过原生插件宿主返回成功 |
| 401/402/403/429/5xx、Retry-After、请求 ID | 上游 HTTP 响应、响应体和头保留；不在插件内重放普通推理失败；宿主继续执行休息、故障转移和路由 |
| 权重、规则、嵌套组、压缩、模型覆盖、账单统计 | Magpie 公共路由与记账机制；本机旧 DeepSeek 组成员、压缩规则和自定义 router 已迁移到 `deepseek-files` |

## 宿主边界

Magpie 当前 `pluginAPIs` 按每个模型的 AI SDK 包决定**一种上游协议**。本插件使用 Responses。Chat 和 Anthropic 客户端通过宿主转换进入 Responses；功能用例已分别验证，但这不等于三种原始协议的请求逐字直通。需要的工具参数及图片没有为了压缩而省略。

插件通过 `auth.usage` 提供余额和赠送/充值明细。Magpie 的插件用量卡与内置 API key 卡是不同界面；其插件 RPC 不接收内置的 `balanceParts` 和余额趋势数据，不能仅靠本插件复制内置余额趋势图。赠送/充值数据已通过旁列用量窗口显示，余额不足会影响路由。此界面差异未标成“完全一致”。

内置的账户页面、密钥管理网址和 maker 目录可以通过 Magpie 自身的提供商设置补充，无需写入或复制密钥：

```sh
magpie provider set deepseek-files catalog=deepseek website=https://platform.deepseek.com keys=https://platform.deepseek.com/api_keys
```

DeepSeek 自身的限制仍适用：Pro 不接收图片；Responses 为无状态 API，`previous_response_id` 不提供服务器端会话存储；文件引用不扩展 token 窗口。官方直接 API 的 FIM 不是 Magpie 网关公开的客户端端点，此处没有把它冒称为网关能力。

## 可重复验证

```sh
npm test
npm run check
node scripts/parity.mjs --gateway http://127.0.0.1:3425 --providers deepseek,deepseek-files
node scripts/parity.mjs --gateway http://127.0.0.1:3425 --providers deepseek-files --large
```

实时测试消耗正常 API 用量。对照测试要求内置提供商可用；脚本不会自行启停提供商。`--filter "roundtrip"` 可只运行一类用例。摘要写入 Git 忽略的 `validation/parity.json`，真实失败会使进程非零退出，内置基线的失败也会保留。

此次源代码核查涉及 Magpie 的 `internal/provider/presets.go`、`plugins.go`、`plugin_usage.go`、`plugin_accounts.go`、`balance.go`、`modelprefs.go`、`internal/gateway/deepseek_schema.go`、`chat.go`、`responses.go`、`search.go`、`gateway.go`、`internal/plugin/host.js` 和 `internal/appdir/appdir.go`。

官方依据：

- [模型发现](https://api-docs.deepseek.com/api/list-models/)
- [Responses 兼容表](https://api-docs.deepseek.com/guides/responses_api/)
- [思考与工具回放](https://api-docs.deepseek.com/guides/thinking_mode/)
- [视觉与 Files API](https://api-docs.deepseek.com/guides/vision/)
- [Search / Fetch](https://api-docs.deepseek.com/guides/search)
