/**
 * dsh-deepseek-web-search — 浏览器半身。
 *
 * 给设置页挂一个区块：状态展示、一键浏览器登录（自动读 localStorage 写凭证）、
 * 手动粘贴兜底。数据走同源 /api/deepseek-web-search/*，不引入任何依赖。
 *
 * 手写 ModuleLoader bundle：无构建步骤，只依赖 shell 已有的 react。
 *
 * @module dsh-deepseek-web-search/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web-search',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useRef } = React

    const name = 'dsh-deepseek-web-search'
    /** 浏览器半身只依赖 slots；locale 不需要（文案走中文常量）。 */
    const inject = ['slots']

    const API = '/api/deepseek-web-search'

    /** 卡片容器样式，全部走主题变量，跟随明暗切换。 */
    const styles = {
      card: { border: '1px solid var(--border-color, #ddd)', borderRadius: 10, padding: '16px 18px', margin: '12px 0', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.6 },
      title: { fontSize: 15, fontWeight: 600, marginBottom: 6 },
      muted: { opacity: 0.7, fontSize: 13 },
      row: { display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0', flexWrap: 'wrap' },
      button: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border-color, #ccc)', background: 'var(--button-bg, #f5f5f5)', cursor: 'pointer', fontSize: 13 },
      primary: { background: 'var(--accent-color, #4d6bfe)', color: '#fff', border: 'none' },
      input: { flex: 1, minWidth: 260, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border-color, #ccc)', fontSize: 13, fontFamily: 'monospace' },
      ok: { color: '#2da44e' },
      bad: { color: '#cf222e' },
      code: { background: 'var(--code-bg, rgba(0,0,0,.05))', padding: '2px 6px', borderRadius: 4, fontSize: 12 },
    }

    /**
     * 主组件：状态 + 一键登录 + 手动兜底。
     * @param {object} props - slot 注入的 props（未用到具体字段）。
     */
    function SettingsPage() {
      const [status, setStatus] = useState(null)
      const [loginState, setLoginState] = useState({ running: false, message: '' })
      const [manual, setManual] = useState('')
      const [notice, setNotice] = useState(null)
      const timerRef = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const response = await fetch(`${API}/status`, { cache: 'no-store' })
          setStatus(await response.json())
        } catch {
          setStatus({ error: '无法访问宿主 API（本页面只在桌面端设置里可用）' })
        }
      }, [])

      useEffect(() => {
        void refresh()
        return () => {
          if (timerRef.current) clearInterval(timerRef.current)
        }
      }, [refresh])

      const startLogin = useCallback(async () => {
        setNotice(null)
        setLoginState({ running: true, message: '正在拉起浏览器…' })
        try {
          const response = await fetch(`${API}/browser-login/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          const payload = await response.json()
          if (!response.ok || payload.error) {
            setLoginState({ running: false, message: payload.error ?? '启动失败' })
            return
          }
          setLoginState({ running: true, message: '浏览器已打开。请在页面里登录 DeepSeek；登录后 token 会自动写入，此窗口可关闭。' })
          // 轮询结果；拿到结果或 5 分钟后停止
          const deadline = Date.now() + 5 * 60_000
          if (timerRef.current) clearInterval(timerRef.current)
          timerRef.current = setInterval(async () => {
            if (Date.now() > deadline) {
              clearInterval(timerRef.current)
              setLoginState({ running: false, message: '等待登录超时，可重试或改用手动粘贴。' })
              return
            }
            try {
              const poll = await fetch(`${API}/browser-login/poll`, { method: 'POST' })
              const result = await poll.json()
              if (result.running === false && result.outcome) {
                clearInterval(timerRef.current)
                if (result.outcome.ok) {
                  setLoginState({ running: false, message: `✓ 已写入凭证（长度=${result.outcome.length}）` })
                  setNotice({ ok: true, text: '登录成功，重启 DSH 后 web_search 即可用网页账号搜索。' })
                } else {
                  setLoginState({ running: false, message: `失败：${result.outcome.error}` })
                }
                void refresh()
              }
            } catch {
              // 宿主暂时不可达，继续轮询
            }
          }, 3000)
        } catch (error) {
          setLoginState({ running: false, message: String(error) })
        }
      }, [refresh])

      const cancelLogin = useCallback(async () => {
        await fetch(`${API}/browser-login/cancel`, { method: 'POST' }).catch(() => {})
        if (timerRef.current) clearInterval(timerRef.current)
        setLoginState({ running: false, message: '已取消。' })
      }, [])

      const saveManual = useCallback(async () => {
        setNotice(null)
        const userToken = manual.trim()
        if (!userToken) {
          setNotice({ ok: false, text: '请先粘贴 userToken。' })
          return
        }
        try {
          const response = await fetch(`${API}/credential`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userToken }),
          })
          const payload = await response.json()
          if (!response.ok || payload.error) {
            setNotice({ ok: false, text: payload.error ?? '写入失败' })
            return
          }
          setNotice({ ok: true, text: `✓ 已写入 ${payload.file}` })
          setManual('')
          void refresh()
        } catch (error) {
          setNotice({ ok: false, text: String(error) })
        }
      }, [manual, refresh])

      const resolved = status?.resolved
      const ok = Boolean(resolved?.source)

      return h('div', { style: styles.card },
        h('div', { style: styles.title }, 'DeepSeek 网页搜索'),
        h('div', { style: styles.muted },
          '让内置 web_search 用你的网页版 DeepSeek 账号（chat.deepseek.com）做联网搜索，无需 API Key。'),

        h('div', { style: styles.row },
          h('span', null, '凭证状态：'),
          status === null
            ? h('span', { style: styles.muted }, '读取中…')
            : status.error
              ? h('span', { style: styles.bad }, status.error)
              : resolved?.source
                ? h('span', { style: styles.ok },
                    `✓ 已配置（来源：${resolved.source}，长度=${resolved.length}${resolved.hasCookie ? '，含 Cookie' : ''}）`)
                : h('span', { style: styles.bad }, `✗ 未配置 —— ${resolved?.error ?? '尚未设置 userToken'}`)),

        h('div', { style: styles.row },
          h('button', { style: { ...styles.button, ...styles.primary }, onClick: startLogin, disabled: loginState.running }, '一键浏览器登录'),
          h('button', { style: styles.button, onClick: () => void refresh() }, '刷新状态'),
          loginState.running ? h('button', { style: styles.button, onClick: cancelLogin }, '取消') : null),

        loginState.message
          ? h('div', { style: styles.muted }, loginState.message)
          : null,

        h('div', { style: { ...styles.muted, margin: '6px 0 2px' } },
          '一键登录会打开一个独立的浏览器窗口（不干扰日常会话），在页面里登录 DeepSeek 后自动读取 token。'),

        h('details', { style: { margin: '8px 0' } },
          h('summary', { style: { cursor: 'pointer', ...styles.muted } }, '手动粘贴 userToken'),
          h('div', { style: styles.row },
            h('input', {
              style: styles.input,
              placeholder: '从 chat.deepseek.com 的 localStorage 里复制 userToken',
              value: manual,
              onChange: (event) => setManual(event.target.value),
            }),
            h('button', { style: styles.button, onClick: saveManual }, '保存'))),

        notice ? h('div', { style: notice.ok ? styles.ok : styles.bad }, notice.text) : null,

        h('div', { style: { ...styles.muted, marginTop: 8 } },
          '凭证文件：', h('code', { style: styles.code }, status?.credentialsFile ?? '…')),
      )
    }

    /**
     * 客户端插件入口：挂设置页 slot。
     * @param {object} ctx - 客户端 cordis 上下文（inject: ['slots']）。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'deepseek-web-search',
        order: 40,
        label: () => 'DeepSeek 网页搜索',
      }, () => h(SettingsPage)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
