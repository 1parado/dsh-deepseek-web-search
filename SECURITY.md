# 安全策略

## 报告漏洞

请通过 GitHub 的 [Private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) 私下报告，不要开公开 issue。

报告时请勿附带任何真实凭证 —— 用 `userToken: "REDACTED"` 之类的占位符复现即可。

## 这个插件接触什么

本插件会读取并使用 **DeepSeek 网页版账号的 `userToken`（及可选 Cookie）**。该凭证等同于账号的完整访问权，请按以下方式对待：

- 只使用**你自己有权使用**的账号。
- 不要把 `userToken`、Cookie 或 `credentials.json` 提交进 Git、贴进 issue、日志或工单。
- 若曾把它写进过聊天记录或截图，请到 DeepSeek 账号设置里登出该会话使其失效。

## 插件侧的保护措施

| 措施 | 实现 |
|:--|:--|
| 凭证不出现在日志/错误消息/会话事件里 | 所有对外文本经 `lib/envelope.js` 的 `redact()`；`describe()` 只报告来源名，不报告值 |
| 不泄漏到其他域名 | 请求固定带 `redirect: 'error'`，不跟随任何跳转 |
| 不明文传输 | 端点必须是 `https`，仅允许指向本机（`127.0.0.1` / `localhost` / `::1`）的 `http` 用于协议测试 |
| 凭证文件权限 | `set-credential.mjs` 原子写入并设 `0600`（Windows 上 `chmod` 为空操作，依赖用户目录 ACL） |
| 不吞异常 | 凭证文件损坏、JSON 非法、形状不合法都明确报错，不静默降级 |
| 上游异常不放大 | SSE 单帧上限 1 MiB；PoW `difficulty` 上界 500 万；各阶段独立超时 |

## 部署方建议

- 把 `$DSH_HOME`（默认 `~/.dsh`）排除在云盘同步与备份之外。
- 商业部署前准备官方 API 作为降级方案，并配置出站代理与审计日志。
- 网页内部协议属非公开接口，可能随网页版本变化；本插件不做验证码绕过，不规避限流、封禁或访问控制。

## 支持范围

仅最新版本。上游协议变更导致的失效按普通缺陷处理，不视为安全问题。