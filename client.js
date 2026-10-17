/**
 * dsh-deepseek-web-search — 浏览器半身。
 *
 * 设置页区块按 PRD 结构分层：
 *   1. 连接状态卡片（状态名 + 一句话说明 + 主操作按钮）
 *   2. 浏览器选择（系统默认 / 指定浏览器 下拉）
 *   3. 高级设置（默认折叠：凭证路径、连接检测、搜索测试、手动粘贴、清除登录数据）
 *
 * 所有状态来自 /status、/check-connection、/test-search 的真实结果；
 * 登录进度由 /browser-login/poll 的 state 驱动。样式全部走主题变量。
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
    const inject = ['slots']
    const API = '/api/deepseek-web-search'

    /** 主题变量驱动的样式表（PRD 5.1：克制浅色、圆角 12-16、按钮高 40-44）。 */
    const S = {
      wrap: { padding: '20px 24px', maxWidth: 720 },
      title: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' },
      desc: { fontSize: 13, color: 'var(--text-secondary, #666)', margin: '0 0 16px', lineHeight: 1.6 },
      card: { border: '1px solid var(--border-color, #e0e0e0)', borderRadius: 14, padding: '20px 24px', background: 'var(--card-bg, #fff)' },
      stateName: { fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 },
      stateDot: { width: 9, height: 9, borderRadius: '50%', flexShrink: 0 },
      stateDesc: { fontSize: 13, color: 'var(--text-secondary, #666)', margin: '6px 0 16px', lineHeight: 1.55 },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' },
      label: { fontSize: 13, color: 'var(--text-secondary, #666)', flexShrink: 0 },
      select: { flex: '1 1 240px', minWidth: 200, height: 40, padding: '0 10px', borderRadius: 10, border: '1px solid var(--border-color, #d0d0d0)', fontSize: 13, background: 'var(--input-bg, #fff)', color: 'inherit' },
      primary: { height: 42, padding: '0 22px', borderRadius: 10, border: 'none', background: 'var(--accent-color, #4d6bfe)', color: '#fff', fontSize: 14, cursor: 'pointer', fontWeight: 500 },
      secondary: { height: 42, padding: '0 16px', borderRadius: 10, border: '1px solid var(--border-color, #d0d0d0)', background: 'transparent', color: 'inherit', fontSize: 13, cursor: 'pointer' },
      disabled: { opacity: 0.55, cursor: 'not-allowed' },
      ok: { color: '#1a7f37' },
      bad: { color: '#cf222e' },
      dotOk: { background: '#2da44e' },
      dotBad: { background: '#cf222e' },
      dotIdle: { background: '#9e9e9e' },
      dotBusy: { background: '#4d6bfe', animation: 'dsh-dws-pulse 1.4s ease-in-out infinite' },
      advanced: { marginTop: 14, borderTop: '1px solid var(--border-color, #eee)', paddingTop: 12 },
      summary: { cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary, #666)', userSelect: 'none' },
      inner: { marginTop: 12, display: 'grid', gap: 10 },
      input: { flex: '1 1 260px', minWidth: 220, height: 38, padding: '0 10px', borderRadius: 8, border: '1px solid var(--border-color, #d0d0d0)', fontSize: 12, fontFamily: 'monospace', background: 'var(--input-bg, #fff)', color: 'inherit' },
      small: { fontSize: 12, color: 'var(--text-secondary, #666)', wordBreak: 'break-all' },
      result: { fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    }

    /** 状态点样式：成功绿 / 失败红 / 进行中蓝闪 / 空闲灰。 */
    function dot(kind) {
      if (kind === 'ok') return S.dotOk
      if (kind === 'bad') return S.dotBad
      if (kind === 'busy') return S.dotBusy
      return S.dotIdle
    }

    /**
     * 连接状态 → 卡片展示（状态名/说明/主按钮文案/状态点类别）。
     * 只认真实业务结果，不做任何乐观假设（PRD F-06）。
     */
    function describeState(status, loginLabel) {
      if (loginLabel) return { name: loginLabel, desc: '浏览器已打开，请在新窗口里登录 DeepSeek；完成后自动写回凭证。', button: '取消', kind: 'busy', running: true }
      const local = status?.local
      const resolved = status?.resolved
      if (status?.error) return { name: '无法读取状态', desc: status.error, button: '重试', kind: 'bad', retry: true }
      if (resolved?.source) {
        return { name: '已连接', desc: '凭证已就绪（来源：' + (resolved.source === status.credentialsFile ? '本地凭证文件' : resolved.source) + '）。可以直接使用 web_search。', button: '重新登录', kind: 'ok', connected: true }
      }
      if (local?.corrupt) return { name: '凭证文件损坏', desc: 'credentials.json 内容不是合法 JSON 或缺少 userToken 字段。可重新登录覆盖，或手动粘贴正确的 token。', button: '登录并修复', kind: 'bad' }
      return { name: '未连接', desc: '还没有配置网页版凭证。点击下方按钮，在浏览器里登录一次即可。', button: '登录并连接 DeepSeek', kind: 'idle' }
    }

    function SettingsPage() {
      const [status, setStatus] = useState(null)
      const [browsers, setBrowsers] = useState(null)
      const [browserChoice, setBrowserChoice] = useState('default')
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [manual, setManual] = useState('')
      const [checkResult, setCheckResult] = useState(null)
      const [testResult, setTestResult] = useState(null)
      const timerRef = useRef(null)

      const refresh = useCallback(async () => {
        try {
          setStatus(await (await fetch(API + '/status', { cache: 'no-store' })).json())
        } catch {
          setStatus({ error: '无法访问宿主 API（本页面只在桌面端设置里可用）' })
        }
      }, [])

      useEffect(() => {
        void refresh()
        void (async () => {
          try {
            const payload = await (await fetch(API + '/browsers', { cache: 'no-store' })).json()
            setBrowsers(payload)
          } catch {
            setBrowsers({ browsers: [] })
          }
        })()
        return () => {
          if (timerRef.current) clearInterval(timerRef.current)
        }
      }, [refresh])

      /** 主按钮动作：连接中 → 取消；否则 → 启动登录（F-07 防重复点击）。 */
      const primaryAction = useCallback(async () => {
        setNotice(null)
        setCheckResult(null)
        setTestResult(null)
        const view = describeState(status, status?.login?.label)
        if (view.running) {
          await fetch(API + '/browser-login/cancel', { method: 'POST' }).catch(() => {})
          return
        }
        if (view.retry) return void refresh()
        setBusy('login')
        try {
          const body = { browserPath: browserChoice === 'default' ? 'default' : browserChoice }
          const response = await fetch(API + '/browser-login/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          const payload = await response.json()
          if (!response.ok || payload.error) {
            setNotice({ ok: false, text: payload.error ?? '启动失败' })
            setBusy(null)
            await refresh()
            return
          }
          await refresh()
          const deadline = Date.now() + 5 * 60_000
          if (timerRef.current) clearInterval(timerRef.current)
          timerRef.current = setInterval(async () => {
            if (Date.now() > deadline) {
              clearInterval(timerRef.current)
              setBusy(null)
              await refresh()
              return
            }
            try {
              const poll = await (await fetch(API + '/browser-login/poll', { method: 'POST' })).json()
              if (poll.running === false && poll.outcome) {
                clearInterval(timerRef.current)
                setBusy(null)
                if (poll.outcome.ok) setNotice({ ok: true, text: '✓ 凭证已保存（长度=' + poll.outcome.length + '）。建议在高级设置里做一次「连接检测」确认可用。' })
                else setNotice({ ok: false, text: '登录失败：' + poll.outcome.error })
                await refresh()
              }
            } catch {
              // 宿主暂时不可达，继续轮询
            }
          }, 2500)
        } catch (error) {
          setBusy(null)
          setNotice({ ok: false, text: String(error) })
        }
      }, [status, browserChoice, refresh])

      /** F-09 第 2 层：连接检测。 */
      const checkConnectionNow = useCallback(async () => {
        setCheckResult(null)
        setBusy('check')
        try {
          const result = await (await fetch(API + '/check-connection', { method: 'POST' })).json()
          setCheckResult(result.ok
            ? { ok: true, text: '✓ 连接检测通过：凭证通过了 DeepSeek 的真实校验。' }
            : { ok: false, text: result.code === 'auth-invalid' ? '✗ 凭证已失效，请重新登录。' : '✗ 检测失败（' + (result.code ?? 'unknown') + '）：' + (result.error ?? '') })
        } catch (error) {
          setCheckResult({ ok: false, text: String(error) })
        }
        setBusy(null)
      }, [])

      /** F-09 第 3 层：搜索测试。 */
      const testSearchNow = useCallback(async () => {
        setTestResult(null)
        setBusy('test')
        try {
          const result = await (await fetch(API + '/test-search', { method: 'POST' })).json()
          setTestResult(result.ok
            ? { ok: true, text: '✓ 搜索测试通过：拿到 ' + result.sources + ' 条来源。web_search 可正常使用。' }
            : { ok: false, text: '✗ 搜索测试失败：' + (result.error ?? '') })
        } catch (error) {
          setTestResult({ ok: false, text: String(error) })
        }
        setBusy(null)
      }, [])

      const saveManual = useCallback(async () => {
        setNotice(null)
        const userToken = manual.trim()
        if (!userToken) {
          setNotice({ ok: false, text: '请先粘贴 userToken。' })
          return
        }
        try {
          const response = await fetch(API + '/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userToken }) })
          const payload = await response.json()
          setNotice(payload.error ? { ok: false, text: payload.error } : { ok: true, text: '✓ 已保存。' })
          if (!payload.error) {
            setManual('')
            await refresh()
          }
        } catch (error) {
          setNotice({ ok: false, text: String(error) })
        }
      }, [manual, refresh])

      const clearLoginData = useCallback(async () => {
        // F-04：清除前明确告知范围
        if (!window.confirm('清除 DSH 专用登录数据？\n\n只删除本插件创建的登录目录（不影响你日常浏览器里的任何数据），下次连接需要重新登录。')) return
        await fetch(API + '/clear-login-data', { method: 'POST' }).catch(() => {})
        setNotice({ ok: true, text: '已清除 DSH 专用登录数据。' })
      }, [])

      const view = describeState(status, busy === 'login' ? (status?.login?.label ?? '等待用户登录') : null)
      const browserOptions = browsers === null ? [] : browsers.browsers ?? []

      return h('div', { style: S.wrap },
        h('h3', { style: S.title }, 'DeepSeek 网页搜索'),
        h('p', { style: S.desc }, '让内置 web_search 用你的网页版 DeepSeek 账号（chat.deepseek.com）做联网搜索，无需 API Key。'),

        h('div', { style: S.card },
          // 状态卡片
          h('div', { style: S.stateName },
            h('span', { style: { ...S.stateDot, ...dot(view.kind) } }),
            view.name),
          h('div', { style: S.stateDesc }, view.desc),
          h('div', { style: S.row },
            h('button', {
              style: { ...S.primary, ...(busy === 'login' ? S.disabled : {}) },
              onClick: primaryAction,
              disabled: busy === 'login',
            }, busy === 'login' ? '登录中…' : view.button),
            view.connected ? h('button', { style: S.secondary, onClick: checkConnectionNow, disabled: busy !== null }, busy === 'check' ? '检测中…' : '连接检测') : null,
            view.connected ? h('button', { style: S.secondary, onClick: testSearchNow, disabled: busy !== null }, busy === 'test' ? '测试中…' : '搜索测试') : null),
          notice ? h('div', { style: { ...S.result, ...(notice.ok ? S.ok : S.bad) } }, notice.text) : null,

          // 浏览器选择（登录中禁用）
          h('div', { style: { ...S.row, marginTop: 16 } },
            h('span', { style: S.label }, '使用浏览器：'),
            h('select', {
              style: S.select,
              value: browserChoice,
              disabled: busy === 'login',
              onChange: (event) => setBrowserChoice(event.target.value),
            },
              h('option', { value: 'default' }, '系统默认浏览器'),
              browserOptions.map((browser) => h('option', { key: browser.path, value: browser.path }, browser.label))),
            browsers !== null && browserOptions.length === 0 ? h('span', { style: S.bad }, '未发现 Chromium 系浏览器') : null),
          h('div', { style: S.small },
            browserChoice === 'default'
              ? '将使用 Windows 当前默认浏览器打开登录页；不修改系统设置。若该浏览器无法自动读取凭证，会明确提示。'
              : '将严格使用所选浏览器（不存在时直接报错，不会偷偷换别的）。'),

          checkResult ? h('div', { style: { ...S.result, ...(checkResult.ok ? S.ok : S.bad) } }, checkResult.text) : null,
          testResult ? h('div', { style: { ...S.result, ...(testResult.ok ? S.ok : S.bad) } }, testResult.text) : null,

          // 高级设置（默认折叠，F-08）
          h('details', { style: S.advanced },
            h('summary', { style: S.summary }, '高级设置'),
            h('div', { style: S.inner },
              h('div', { style: S.small },
                '凭证文件：',
                h('code', null, status?.credentialsFile ?? '…'), ' ',
                h('button', {
                  style: { ...S.secondary, height: 28, padding: '0 10px', fontSize: 12 },
                  onClick: () => {
                    void navigator.clipboard?.writeText(status?.credentialsFile ?? '')
                    setNotice({ ok: true, text: '路径已复制。' })
                  },
                }, '复制'),
                ' ',
                h('button', { style: { ...S.secondary, height: 28, padding: '0 10px', fontSize: 12 }, onClick: () => { void fetch(API + '/open-credentials-folder', { method: 'POST' }) } }, '打开目录')),
              h('div', null,
                h('div', { style: { ...S.small, marginBottom: 4 } }, '手动粘贴 userToken（与一键登录等效）：'),
                h('div', { style: S.row },
                  h('input', { style: S.input, placeholder: '粘贴 userToken', value: manual, onChange: (event) => setManual(event.target.value) }),
                  h('button', { style: S.secondary, onClick: saveManual }, '保存'))),
              h('div', null,
                h('button', { style: { ...S.secondary, color: '#cf222e' }, onClick: clearLoginData }, '清除 DSH 专用登录数据'),
                h('div', { style: { ...S.small, marginTop: 4 } }, '只删除本插件创建的登录目录，不影响你日常浏览器里的任何数据。'))))))
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
