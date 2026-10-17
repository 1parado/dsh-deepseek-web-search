# 变更记录

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.1] - 2026-10-17

**修复**

- 设置页「连接检测 / 搜索测试」报
  `Cannot read properties of undefined (reading 'origin' / 'search')`：
  apply() 组装 createSettingsApi 依赖时漏传 `provider` 与 `settings`。
  handler 级单测全部绿但装配路径没人测 —— 新增 `test/assembly.test.mjs`
  （跑真 apply() + 假 webServer + 真实 HTTP 请求），专抓这一类"漏传依赖"。

**测试**

- 装配测试用假 token 走真实上游，断言返回的是认证类失败而非组装错误
  （注意：credentialsFile 必须显式指向临时文件，否则会读用户真实凭证，
  那样检测"成功"是正确行为却让测试失去意义）。


## [0.3.0] - 2026-10-17

按《认证管理模块 PRD》重构（F-01/02/04/05/06/08/09）：

- 浏览器三模式：系统默认（注册表 UserChoice 链路，实测可解析装在
  AppData 的 Chromium 系浏览器）｜指定浏览器（严格使用）｜自动挑选
- 登录状态机：launching → waiting-login → token-captured → saving，
  全部由真实业务结果驱动
- 凭证原子写入（tmp→校验→rename）：写坏文件不再可能，重新登录失败
  不破坏旧凭证
- 三层检测：本地文件检查 → 连接检测（真实调 chat_session/create）→
  搜索测试（用户主动触发）
- DSH 专用登录目录持久化，二次连接免登录；设置页可清除
- 高级设置折叠：凭证路径、手动粘贴、清除登录数据
- 设置页 UI 按视觉规范重写（状态卡片/状态点/主按钮随状态变化）
- 新增 web search 主题图标（icon.svg）
- 修复：resolveDefaultBrowser 内 execFileSync 未导入，ReferenceError
  被 catch 吞成 null


## [0.2.3] - 2026-10-17

**修复**

- 浏览器发现不再只看固定安装路径：Windows 上先查注册表（App Paths 与
  Uninstall 的 DisplayIcon，覆盖任意安装盘符与便携目录），再查 PATH，
  固定位置只作兜底；POSIX 上查 PATH。
- CDP 调试端口可经 `$DSH_CDP_PORT` 覆盖，不再写死 9223。

**变更**

- `labelFor` 导出用于测试；新增 `test/browser-login.test.mjs`（5 个用例，
  覆盖严格指定、静默回退禁止、去重与展示名映射）。

## [0.2.2] - 2026-10-17

**修复**

- 登录窗口不自动关闭：专用实例用完即关（taskkill 进程树）并清理临时目录。
- 选了 Chrome 却弹出 Edge：indBrowser 不再静默回退，指定的浏览器不存在
  直接报错并显示在设置页。

**验证**

- 用真实账号 token 跑通全链路（verify-live 拿到 14 条带日期来源）。

## [0.2.0] - 2026-10-17

**新增**

- **设置页区块**（客户端半身，`client.js`）：设置 → 内置插件 里出现「DeepSeek 网页搜索」
  卡片 —— 凭证状态、一键浏览器登录、手动粘贴兜底，全部走同源 API。
- **一键浏览器登录**（`lib/browser-login.js`）：拉起独立的 Edge/Chrome 窗口
  （`--remote-debugging-port` + 独立临时用户目录，不干扰日常会话），通过 DevTools
  协议轮询 `localStorage.userToken`，登录成功后自动写入凭证文件。只读 `userToken`
  一个键，读完即止。
- 设置页同源 API（`/api/deepseek-web-search/*`）：`status`（只报来源/长度，不含
  token）、`credential`（POST 写入 0600 文件）、`browser-login/start|poll|cancel`、
  `open-credentials-folder`。`webServer` 不存在时静默降级（headless 组合）。

**修复**

- 设置 API 的写入目标必须与凭证解析器是**同一个文件**：初版曾写死默认路径，
  在注入了自定义 `credentialsFile` 的组合里会写到错误位置。已在测试中用临时
  目录锁住这个行为。

**变更**

- `package.json` 声明 `dsh.client`（浏览器半身）与 `./client` 导出。

## [0.1.2] - 2026-10-17

**新增**

- `scripts/scan-secrets.mjs`：发布前敏感信息扫描。默认扫暂存区（pre-commit 用），
  `--all` 扫全部被跟踪文件，`--path` 扫目录，`--json` 输出机器可读结果。
  覆盖私钥块、常见平台 token 前缀、JWT、`userToken: "…"` 类赋值、无前缀高熵长串，
  以及 `.env` / `credentials.json` / `*.pem` 等禁止提交的路径。
  **命中内容只打印长度与前 4 位**，不回显原文。
- `.githooks/pre-commit`：提交前门禁，`git config core.hooksPath .githooks` 启用。
- `docs/pre-release-checklist.md`：人工自检清单（凭证、提交历史、文档截图、发布产物、
  第三方合规、提交前自查，以及「万一已经泄露」的处理顺序）。
- `test/scan-secrets.test.mjs`：9 个用例，既验证能抓到各类真凭证，也验证不误报
  环境变量名 / URL / 路径 / 摘要。

**变更**

- `scripts/check.mjs` 现在把敏感信息扫描并入发布前门禁；CI 也新增该步骤。

## [0.1.1] - 2026-10-17

**新增**

- `scripts/verify-live.mjs`：用真实账号跑一次完整搜索链路（开会话 → PoW →
  completion → 结果归集），不用重启 DSH 就能确认 userToken 是否可用。

**修复**

- 实测发现 token 无效时上游返回 **HTTP 200 + `biz_code: 40003`**
  （`Authorization Failed (invalid token)`），并非 HTTP 401/403。此前只会显示
  「被拒绝（40003）」，现在映射为明确的登录失效提示并给出重取 token 的指引；
  同义的英文文案（`invalid token` / `unauthorized`）即使换了业务码也能识别。

**文档**

- 安装说明改为桌面端走 GUI 插件管理器 —— 实测 `dsh plugin --profile desktop`
  会挂住，`--dump-config` 直接报 profile 由 Electron 独占管理。
- 补全「怎么拿到 userToken」的两种取法（Console 一行命令 / DevTools 手动点选）。

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



