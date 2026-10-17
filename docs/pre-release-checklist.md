# 发布前敏感信息自检清单

这个仓库会经手 DeepSeek 网页账号的 `userToken`（等同账号完整访问权），所以发布/推送前按下面走一遍。

[← 返回 README](../README.md)

---

## 0. 先跑自动化门禁

```powershell
node scripts/scan-secrets.mjs --all   # 敏感信息扫描（命中即非零退出）
node scripts/check.mjs                # 语法 + 58 个单测 + 扫描
```

一次性启用提交前钩子：

```powershell
git config core.hooksPath .githooks
```

启用后每次 `git commit` 都会自动扫暂存区，命中就拦下。

---

## 1. 凭证类（最高优先级）

- [ ] 仓库里没有任何 `userToken` / `cookie` 的**真实值**（示例必须写成 `<token>`、`xxxxx` 这类占位）
- [ ] 没有 `credentials.json`、`.env`、`*.pem`、`*.key`、`id_rsa*` 被跟踪
      → `git ls-files | Select-String "credentials|\.env|\.pem|id_rsa"`
- [ ] `.gitignore` 已覆盖：`credentials.json`、`.env`、`.env.*`、`node_modules/`
- [ ] 测试与文档里的示例值都是**合成**的，且该行带 `secret-scan: ignore` 标记
- [ ] 没有把 `x-ds-pow-response`、`authorization` 头的真实值贴进注释或 fixture

## 2. 提交历史（删文件不等于清理）

- [ ] 若历史上曾提交过真凭证：**先轮换/吊销**，再清理历史
      → 删除文件后旧提交里依然可读，`git log -S "<关键词>"` 能查出来
- [ ] 用 `git log --all -S "userToken" --oneline` 确认没有意外命中
- [ ] 清理工具：`git filter-repo` 或 BFG；清理后强制推送并通知协作者重新克隆

> 判断顺序永远是：**先吊销，再清理历史**。凭证一旦进过公开仓库，就当作已泄露。

## 3. 文档与截图

- [ ] README / SECURITY / issue 模板里没有真实账号、邮箱、头像、内网地址
- [ ] 截图（如有）里没有 token、Cookie、账号名、DevTools 的 Local Storage 面板
- [ ] 示例 JSON 里的字段是占位值，不是复制粘贴来的真值

## 4. 发布产物

- [ ] `package.json` 的 `files` 字段覆盖正确，没有把本地调试文件打进去
      → `npm pack --dry-run`
- [ ] `test/fixtures/` 里若有真实抓包，已脱敏（URL、时间戳、账号信息）
- [ ] 没有 `console.log` 打印请求头、凭证或完整请求体
- [ ] 没有硬编码的内网地址、端口、代理凭据

## 5. 第三方与合规

- [ ] 移植/参考的代码已标注来源与 LICENSE（本仓库：`lib/pow.js` ← magpie-deepseekweb2api，MIT）
- [ ] 文档没有把上游内部协议写成"可批量滥用"的指南
- [ ] 明确说明「只使用你有权使用的账号」，不含验证码绕过/风控规避内容

## 6. 提交前 30 秒自查

- [ ] `git diff --cached` 逐行看过，没有夹带调试代码或本地路径
- [ ] 没有把自己的用户名路径（`C:\Users\<你的名字>`）写进文档示例
- [ ] 版本号与 `CHANGELOG.md` 已更新

---

## 万一已经泄露了

1. **立刻轮换**：登录 chat.deepseek.com 登出该会话，或让 token 失效，重新取一个新的。
2. 从工作区删除该文件 / 该行，提交。
3. 清理历史（`git filter-repo`），强制推送。
4. 如果仓库是公开的且已存在一段时间：视为已泄露，检查账号是否有异常活动。
5. 不要在 issue / 聊天记录里复述那个 token —— 包括「只是前几位」。

## 这个仓库的扫描器覆盖什么

| 规则 | 抓什么 |
|:--|:--|
| `private-key` | `BEGIN … PRIVATE KEY` 私钥块 |
| `github-token` / `github-pat` | `ghp_` / `github_pat_` 等 |
| `openai-key` / `aws-key` / `google-key` / `stripe-key` / `slack-token` | 常见平台前缀 |
| `jwt` | 三段式 JWT |
| `credential-assignment` | `userToken: "<32+ 字符>"`、`cookie = …`、`"password": …` |
| `high-entropy` | 无固定前缀的高熵长串（≥40 字符，香农熵 ≥3.6） |
| `forbidden-path` | `.env`、`credentials.json`、`*.pem/*.key`、`id_rsa*` |

已知不覆盖：**熵低于阈值的长随机串**、二进制文件、`.git` 内部、git 历史。
所以自动化只是第一道闸，第 2、3、6 节仍需人工过一遍。
