# 变更记录

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-17

首个版本。

**能力**

- 以 `deepseek-web` 身份注册 `ctx.web` 搜索提供方，DSH 内置的 `web_search` 工具零改动即可使用。
- 使用 DeepSeek 网页版账号的 `userToken`（可选 Cookie）而非 API Key。
- 实现 `DeepSeekHashV1` 工作量证明（23 轮 SHA3 海绵，前缀单次吸收 + 逐 nonce 折入）。
- 从 SSE 补丁流的结构化 `results[]` 归集来源：URL 去重、按 `cite_index` 排序、`published_at` 归一为 `YYYY-MM-DD`。
- 拿到结果即断开上游，不等整轮回答生成；可选读取完整回答作为 `content`。
- 凭证三来源解析（配置字面值 → 环境变量 → 私有凭证文件），每次搜索重新解析，支持热轮换。
- `scripts/set-credential.mjs` 写入/查看/清除凭证文件，原子写入 + `0600`，只回显长度与指纹。

**安全**

- 所有对外文本经 `redact()`，凭证不进日志、错误消息与会话事件。
- 请求固定 `redirect: 'error'`；端点必须 https，仅本机允许 http。
- 凭证文件损坏、JSON 非法、形状不合法均明确报错，不静默降级。

**取舍**

- 零外部依赖：不 `import` 任何 `@deepseek-ai/*`（profile 下的 junction 可能指向旧版本的 npx 缓存）。
- 不做多账号池与故障切换，仅单凭证。
- 只认结构化字段，绝不从回答正文正则抓 URL。

[0.1.0]: https://github.com/1parado/dsh-deepseek-web-search/releases/tag/v0.1.0