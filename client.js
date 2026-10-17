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
 * i18n：内置 zh-CN / en 两套文案，按 navigator.language 自动选择（zh* → zh-CN），
 * 顶部提供语言切换。t(key, params) 支持 {name} 占位符。
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
    const REPO_URL = 'https://github.com/1parado/dsh-deepseek-web-search'

    // ---------------------------------------------------------------------------
    // i18n
    // ---------------------------------------------------------------------------

    const MESSAGES = {
      'zh-CN': {
        title: 'DeepSeek 网页搜索',
        desc: '',
        // 状态卡片
        loginPrompt: '请在打开的窗口里登录 DeepSeek。',
        cancel: '取消',
        statusError: '无法读取状态',
        retry: '重试',
        connected: '已连接',
        connectedDesc: '凭证已就绪，可直接使用 web_search。',
        sourceLocalFile: '本地凭证文件',
        corrupt: '凭证文件损坏',
        corruptDesc: 'credentials.json 不是合法 JSON 或缺少 userToken。可重新登录或手动粘贴 token。',
        loginAndFix: '登录并修复',
        notConnected: '未连接',
        notConnectedDesc: '点击下方按钮，在浏览器里登录一次即可。',
        loginAndConnect: '登录并连接 DeepSeek',
        reLogin: '重新登录',
        loggingIn: '登录中…',
        waitingLogin: '等待用户登录',
        // 操作按钮
        checkConnection: '连接检测',
        checking: '检测中…',
        testSearch: '搜索测试',
        testing: '测试中…',
        // 浏览器选择
        useBrowser: '使用浏览器：',
        defaultBrowser: '系统默认浏览器',
        noBrowserFound: '未发现 Chromium 系浏览器',
        browserDefaultHint: '',
        browserSpecificHint: '',
        // 通知
        startFailed: '启动失败',
        credentialSaved: '✓ 凭证已保存（长度={length}）。',
        loginFailed: '登录失败：{error}',
        checkOk: '✓ 连接检测通过。',
        checkAuthInvalid: '✗ 凭证已失效，请重新登录。',
        checkFailed: '✗ 检测失败（{code}）：{error}',
        testOk: '✓ 搜索测试通过（{sources} 条来源）。',
        testFailed: '✗ 搜索测试失败：{error}',
        pasteTokenFirst: '请先粘贴 userToken。',
        saved: '✓ 已保存。',
        pathCopied: '路径已复制。',
        // 高级设置
        advanced: '高级设置',
        credentialsFile: '凭证文件：',
        copy: '复制',
        clipboardPaste: '粘贴',
        openFolder: '打开目录',
        manualPaste: '手动粘贴 userToken：',
        pasteTokenPlaceholder: '粘贴 userToken',
        save: '保存',
        clearLoginData: '清除登录数据',
        clearLoginDataDesc: '',
        confirmClear: '清除登录数据？下次连接需要重新登录。',
        cleared: '✓ 已清除。',
        hostApiError: '无法访问宿主 API',
        language: '语言',
        github: 'GitHub 仓库',
        checkUpdate: '检查更新',
        checkingUpdate: '检查中…',
        updateNow: '一键更新',
        updating: '更新中…',
        upToDate: '✓ 已是最新（{version}）。',
        updateAvailable: '新版本 {latest}（当前 {current}）。',
        updateDone: '✓ 已更新到 {version}，重启后生效。',
        updateFailed: '✗ 更新失败：{error}',
        currentVersion: '当前版本：{version}',
        openReleases: 'Releases',
      },
      en: {
        title: 'DeepSeek Web Search',
        desc: '',
        loginPrompt: 'Please sign in to DeepSeek in the opened window.',
        cancel: 'Cancel',
        statusError: 'Unable to read status',
        retry: 'Retry',
        connected: 'Connected',
        connectedDesc: 'Credentials ready. web_search is ready to use.',
        sourceLocalFile: 'local credential file',
        corrupt: 'Credential file corrupted',
        corruptDesc: 'credentials.json is not valid JSON or is missing userToken. Sign in again or paste the token manually.',
        loginAndFix: 'Sign in & fix',
        notConnected: 'Not connected',
        notConnectedDesc: 'Click the button below and sign in once in your browser.',
        loginAndConnect: 'Sign in & connect DeepSeek',
        reLogin: 'Sign in again',
        loggingIn: 'Signing in…',
        waitingLogin: 'Waiting for sign-in',
        checkConnection: 'Check connection',
        checking: 'Checking…',
        testSearch: 'Test search',
        testing: 'Testing…',
        useBrowser: 'Browser:',
        defaultBrowser: 'System default browser',
        noBrowserFound: 'No Chromium-based browser found',
        browserDefaultHint: '',
        browserSpecificHint: '',
        startFailed: 'Start failed',
        credentialSaved: '✓ Credentials saved (length={length}).',
        loginFailed: 'Sign-in failed: {error}',
        checkOk: '✓ Connection check passed.',
        checkAuthInvalid: '✗ Credentials are no longer valid. Please sign in again.',
        checkFailed: '✗ Check failed ({code}): {error}',
        testOk: '✓ Search test passed ({sources} sources).',
        testFailed: '✗ Search test failed: {error}',
        pasteTokenFirst: 'Please paste a userToken first.',
        saved: '✓ Saved.',
        pathCopied: 'Path copied.',
        advanced: 'Advanced settings',
        credentialsFile: 'Credential file: ',
        copy: 'Copy',
        clipboardPaste: 'Paste',
        openFolder: 'Open folder',
        manualPaste: 'Paste userToken manually:',
        pasteTokenPlaceholder: 'Paste userToken',
        save: 'Save',
        clearLoginData: 'Clear sign-in data',
        clearLoginDataDesc: '',
        confirmClear: 'Clear sign-in data? You will need to sign in again next time.',
        cleared: '✓ Cleared.',
        hostApiError: 'Host API unreachable',
        language: 'Language',
        github: 'GitHub repository',
        checkUpdate: 'Check for updates',
        checkingUpdate: 'Checking…',
        updateNow: 'Update now',
        updating: 'Updating…',
        upToDate: '✓ Up to date ({version}).',
        updateAvailable: 'New version {latest} (current {current}).',
        updateDone: '✓ Updated to {version}. Restart to take effect.',
        updateFailed: '✗ Update failed: {error}',
        currentVersion: 'Current version: {version}',
        openReleases: 'Releases',
      },
    }

    /** 从 navigator.language 解析初始语言：zh* → zh-CN，否则 en。 */
    function detectLocale() {
      try {
        const lang = (navigator.language || 'en').toLowerCase()
        if (lang.startsWith('zh')) return 'zh-CN'
      } catch { /* 非浏览器环境兜底 */ }
      return 'en'
    }

    let currentLocale = detectLocale()

    /**
     * 取文案；{name} 占位符用 params 替换。缺 key 时回退英文，再回退 key 本身。
     * @param {string} key - 文案 key。
     * @param {Record<string, string|number>} [params] - 占位符参数。
     * @returns {string}
     */
    function t(key, params) {
      let text = MESSAGES[currentLocale]?.[key] ?? MESSAGES.en[key] ?? key
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          text = text.replaceAll('{' + name + '}', String(value))
        }
      }
      return text
    }

    /** GitHub 图标（内联 SVG，走 currentColor 适配主题）。 */
    const GITHUB_ICON = h('svg', {
      viewBox: '0 0 16 16', width: 18, height: 18, 'aria-hidden': true,
      style: { display: 'block', fill: 'currentColor' },
    },
      h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z' }))

    /** 16px 内联小图标工厂（走 currentColor）。 */
    const icon = (pathD, size = 14) => h('svg', {
      viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true,
      style: { display: 'block', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
    }, h('path', { d: pathD }))

    /** 齿轮（高级设置）。 */
    const GEAR_ICON = icon('M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5ZM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4')
    /** 复制。 */
    const COPY_ICON = icon('M5.5 5.5h8v8h-8ZM10.5 5.5v-3h-8v8h3')
    /** 文件夹。 */
    const FOLDER_ICON = icon('M1.5 3.5h4l2 2h7v7h-13Z')
    /** 剪贴板（粘贴）。 */
    const CLIPBOARD_ICON = icon('M5.5 2.5h5v2h-5ZM3.5 3.5h-1v11h11v-11h-1M6.5 9h3M6.5 11.5h3')

    /** 主题变量驱动的样式表。间距体系 8/12/16/24，圆角统一 8/12。 */
    const S = {
      wrap: { padding: '24px', maxWidth: 720 },
      header: { display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 16px' },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      headerActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 },
      langButton: { height: 28, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border-color, #d0d0d0)', background: 'transparent', color: 'inherit', fontSize: 12, cursor: 'pointer' },
      repoLink: { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'inherit', textDecoration: 'none', opacity: 0.75 },
      desc: { fontSize: 13, color: 'var(--text-secondary, #666)', margin: '0 0 16px', lineHeight: 1.6 },
      card: { border: '1px solid var(--border-color, #e0e0e0)', borderRadius: 12, padding: '24px', background: 'var(--card-bg, #fff)', display: 'grid', gap: 16 },
      // 独立状态块：浅色背景 + 圆角，随状态换底色
      statusBlock: { borderRadius: 8, padding: '12px 16px', background: 'var(--status-bg, #f6f7f9)' },
      statusOk: { background: 'rgba(45,164,78,0.08)' },
      statusBad: { background: 'rgba(207,34,46,0.07)' },
      statusBusy: { background: 'rgba(77,107,254,0.07)' },
      stateName: { fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 },
      stateDot: { width: 9, height: 9, borderRadius: '50%', flexShrink: 0 },
      stateDesc: { fontSize: 13, color: 'var(--text-secondary, #666)', margin: '6px 0 0', lineHeight: 1.55 },
      row: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
      label: { fontSize: 13, color: 'var(--text-secondary, #666)', flexShrink: 0 },
      select: { flex: '1 1 240px', minWidth: 200, height: 40, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border-color, #d0d0d0)', fontSize: 13, background: 'var(--input-bg, #fff)', color: 'inherit' },
      primary: { height: 40, padding: '0 20px', borderRadius: 8, border: 'none', background: 'var(--accent-color, #4d6bfe)', color: '#fff', fontSize: 14, cursor: 'pointer', fontWeight: 500 },
      secondary: { height: 40, padding: '0 16px', borderRadius: 8, border: '1px solid var(--border-color, #d0d0d0)', background: 'transparent', color: 'inherit', fontSize: 13, cursor: 'pointer' },
      ghost: { height: 28, padding: '0 10px', borderRadius: 6, border: 'none', background: 'transparent', color: 'var(--text-secondary, #666)', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 },
      dangerOutline: { height: 40, padding: '0 16px', borderRadius: 8, border: '1px solid rgba(207,34,46,0.45)', background: 'transparent', color: '#cf222e', fontSize: 13, cursor: 'pointer' },
      iconBtn: { height: 28, padding: '0 8px', borderRadius: 6, border: '1px solid var(--border-color, #d0d0d0)', background: 'transparent', color: 'inherit', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 },
      disabled: { opacity: 0.55, cursor: 'not-allowed' },
      ok: { color: '#1a7f37' },
      bad: { color: '#cf222e' },
      dotOk: { background: '#2da44e' },
      dotBad: { background: '#cf222e' },
      dotIdle: { background: '#9e9e9e' },
      dotBusy: { background: '#4d6bfe', animation: 'dsh-dws-pulse 1.4s ease-in-out infinite' },
      advanced: { borderRadius: 8, border: '1px solid var(--border-color, #eee)', background: 'var(--status-bg, #fafafa)', overflow: 'hidden' },
      summary: { cursor: 'pointer', fontSize: 13, fontWeight: 500, color: 'inherit', userSelect: 'none', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 6, listStyle: 'none' },
      summaryInner: { display: 'inline-flex', alignItems: 'center', gap: 6 },
      chevron: { display: 'inline-block', transition: 'transform 0.15s ease', fontSize: 10, color: 'var(--text-secondary, #666)' },
      inner: { padding: '16px', borderTop: '1px solid var(--border-color, #eee)', display: 'grid', gap: 16, background: 'var(--card-bg, #fff)' },
      fieldRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      // 凭证路径：等宽 + 省略号 + 悬停显示全路径
      pathBox: { flex: '1 1 240px', minWidth: 200, display: 'flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-color, #e0e0e0)', borderRadius: 8, padding: '0 4px 0 10px', height: 32, background: 'var(--input-bg, #fff)' },
      path: { flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left', color: 'var(--text-secondary, #666)' },
      input: { flex: '1 1 260px', minWidth: 220, height: 40, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border-color, #d0d0d0)', fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', background: 'var(--input-bg, #fff)', color: 'inherit' },
      small: { fontSize: 12, color: 'var(--text-secondary, #666)', wordBreak: 'break-all' },
      result: { fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      divider: { border: 'none', borderTop: '1px solid var(--border-color, #eee)', margin: 0 },
      updateRow: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
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
      if (loginLabel) return { name: loginLabel, desc: t('loginPrompt'), button: t('cancel'), kind: 'busy', running: true }
      const local = status?.local
      const resolved = status?.resolved
      if (status?.error) return { name: t('statusError'), desc: status.error, button: t('retry'), kind: 'bad', retry: true }
      if (resolved?.source) {
        const source = resolved.source === status.credentialsFile ? t('sourceLocalFile') : resolved.source
        return { name: t('connected'), desc: t('connectedDesc', { source }), button: t('reLogin'), kind: 'ok', connected: true }
      }
      if (local?.corrupt) return { name: t('corrupt'), desc: t('corruptDesc'), button: t('loginAndFix'), kind: 'bad' }
      return { name: t('notConnected'), desc: t('notConnectedDesc'), button: t('loginAndConnect'), kind: 'idle' }
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
      const [updateState, setUpdateState] = useState(null)
      const [, setLocaleTick] = useState(0)
      const timerRef = useRef(null)

      /** 切换语言并强制重渲染（文案是模块级快照）。 */
      const toggleLocale = useCallback(() => {
        currentLocale = currentLocale === 'zh-CN' ? 'en' : 'zh-CN'
        setLocaleTick((tick) => tick + 1)
      }, [])

      const refresh = useCallback(async () => {
        try {
          setStatus(await (await fetch(API + '/status', { cache: 'no-store' })).json())
        } catch {
          setStatus({ error: t('hostApiError') })
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
            setNotice({ ok: false, text: payload.error ?? t('startFailed') })
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
                if (poll.outcome.ok) setNotice({ ok: true, text: t('credentialSaved', { length: poll.outcome.length }) })
                else setNotice({ ok: false, text: t('loginFailed', { error: poll.outcome.error }) })
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
            ? { ok: true, text: t('checkOk') }
            : { ok: false, text: result.code === 'auth-invalid' ? t('checkAuthInvalid') : t('checkFailed', { code: result.code ?? 'unknown', error: result.error ?? '' }) })
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
            ? { ok: true, text: t('testOk', { sources: result.sources }) }
            : { ok: false, text: t('testFailed', { error: result.error ?? '' }) })
        } catch (error) {
          setTestResult({ ok: false, text: String(error) })
        }
        setBusy(null)
      }, [])

      const saveManual = useCallback(async () => {
        setNotice(null)
        const userToken = manual.trim()
        if (!userToken) {
          setNotice({ ok: false, text: t('pasteTokenFirst') })
          return
        }
        try {
          const response = await fetch(API + '/credential', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userToken }) })
          const payload = await response.json()
          setNotice(payload.error ? { ok: false, text: payload.error } : { ok: true, text: t('saved') })
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
        if (!window.confirm(t('confirmClear'))) return
        await fetch(API + '/clear-login-data', { method: 'POST' }).catch(() => {})
        setNotice({ ok: true, text: t('cleared') })
      }, [])

      const view = describeState(status, busy === 'login' ? (status?.login?.label ?? t('waitingLogin')) : null)
      const browserOptions = browsers === null ? [] : browsers.browsers ?? []

      /** 检查更新：比较本地与 GitHub 上的最新版本。 */
      const checkUpdateNow = useCallback(async () => {
        setUpdateState({ phase: 'checking' })
        try {
          const result = await (await fetch(API + '/update/check', { cache: 'no-store' })).json()
          if (!result.ok) setUpdateState({ phase: 'error', text: t('updateFailed', { error: result.error ?? '' }) })
          else if (result.updateAvailable) setUpdateState({ phase: 'available', latest: result.latestVersion, current: result.currentVersion })
          else setUpdateState({ phase: 'upToDate', current: result.currentVersion })
        } catch (error) {
          setUpdateState({ phase: 'error', text: String(error) })
        }
      }, [])

      /** 一键更新：后端在 profile 目录执行 pnpm update。 */
      const applyUpdateNow = useCallback(async () => {
        setUpdateState((state) => ({ ...state, phase: 'updating' }))
        try {
          const result = await (await fetch(API + '/update/apply', { method: 'POST' })).json()
          if (result.ok) setUpdateState({ phase: 'done', version: result.version })
          else setUpdateState({ phase: 'error', text: t('updateFailed', { error: result.error ?? '' }) })
        } catch (error) {
          setUpdateState({ phase: 'error', text: String(error) })
        }
      }, [])

      /** 状态块底色随状态切换。 */
      const statusBlockStyle = { ...S.statusBlock }
      if (view.kind === 'ok') Object.assign(statusBlockStyle, S.statusOk)
      else if (view.kind === 'bad') Object.assign(statusBlockStyle, S.statusBad)
      else if (view.kind === 'busy') Object.assign(statusBlockStyle, S.statusBusy)

      const credentialsFile = status?.credentialsFile ?? ''

      return h('div', { style: S.wrap },
        h('div', { style: S.header },
          h('h3', { style: S.title }, t('title')),
          h('div', { style: S.headerActions },
            h('a', { style: S.repoLink, href: REPO_URL, target: '_blank', rel: 'noreferrer', title: t('github'), 'aria-label': t('github') },
              GITHUB_ICON,
              h('span', { style: { fontSize: 12 } }, 'GitHub')),
            h('button', { style: S.langButton, onClick: toggleLocale, title: t('language') }, currentLocale === 'zh-CN' ? 'EN' : '中文'))),
        t('desc') ? h('p', { style: S.desc }, t('desc')) : null,

        h('div', { style: S.card },
          // 状态块（独立浅色卡片：圆点 + 状态名 + 说明）
          h('div', { style: statusBlockStyle },
            h('div', { style: S.stateName },
              h('span', { style: { ...S.stateDot, ...dot(view.kind) } }),
              view.name),
            h('div', { style: S.stateDesc }, view.desc)),

          // 操作按钮组：主按钮 + 描边次要按钮，同一行
          h('div', { style: S.row },
            h('button', {
              style: { ...S.primary, ...(busy === 'login' ? S.disabled : {}) },
              onClick: primaryAction,
              disabled: busy === 'login',
            }, busy === 'login' ? t('loggingIn') : view.button),
            view.connected ? h('button', { style: S.secondary, onClick: checkConnectionNow, disabled: busy !== null }, busy === 'check' ? t('checking') : t('checkConnection')) : null,
            view.connected ? h('button', { style: S.secondary, onClick: testSearchNow, disabled: busy !== null }, busy === 'test' ? t('testing') : t('testSearch')) : null),
          notice ? h('div', { style: { ...S.result, ...(notice.ok ? S.ok : S.bad) } }, notice.text) : null,

          // 浏览器选择（登录中禁用）
          h('div', { style: { ...S.row, marginTop: 0 } },
            h('span', { style: S.label }, t('useBrowser')),
            h('select', {
              style: S.select,
              value: browserChoice,
              disabled: busy === 'login',
              onChange: (event) => setBrowserChoice(event.target.value),
            },
              h('option', { value: 'default' }, t('defaultBrowser')),
              browserOptions.map((browser) => h('option', { key: browser.path, value: browser.path }, browser.label))),
            browsers !== null && browserOptions.length === 0 ? h('span', { style: S.bad }, t('noBrowserFound')) : null),
          (browserChoice === 'default' ? t('browserDefaultHint') : t('browserSpecificHint'))
            ? h('div', { style: S.small }, browserChoice === 'default' ? t('browserDefaultHint') : t('browserSpecificHint')) : null,

          checkResult ? h('div', { style: { ...S.result, ...(checkResult.ok ? S.ok : S.bad) } }, checkResult.text) : null,
          testResult ? h('div', { style: { ...S.result, ...(testResult.ok ? S.ok : S.bad) } }, testResult.text) : null,

          // 高级设置（折叠块：浅底容器 + 齿轮图标 + 展开箭头）
          h('details', { style: S.advanced },
            h('summary', { style: S.summary },
              h('span', { style: S.summaryInner, onClick: undefined },
                GEAR_ICON, t('advanced'))),
            h('div', { style: S.inner },
              // 凭证路径：路径框（省略号+悬停全路径）+ 右侧图标按钮
              h('div', { style: S.fieldRow },
                h('div', { style: S.pathBox, title: credentialsFile },
                  h('span', { style: S.path }, credentialsFile || '…'),
                  h('button', {
                    style: S.iconBtn,
                    title: t('copy'),
                    onClick: () => {
                      void navigator.clipboard?.writeText(credentialsFile)
                      setNotice({ ok: true, text: t('pathCopied') })
                    },
                  }, COPY_ICON),
                  h('button', { style: S.iconBtn, title: t('openFolder'), onClick: () => { void fetch(API + '/open-credentials-folder', { method: 'POST' }) } }, FOLDER_ICON)),
                h('span', { style: S.label }, t('credentialsFile'))),
              // 手动粘贴 userToken：右侧粘贴按钮，输入框高度与下拉一致
              h('div', null,
                h('div', { style: { ...S.small, marginBottom: 8 } }, t('manualPaste')),
                h('div', { style: S.fieldRow },
                  h('input', { style: S.input, placeholder: t('pasteTokenPlaceholder'), value: manual, onChange: (event) => setManual(event.target.value) }),
                  h('button', { style: S.iconBtn, height: undefined, title: t('clipboardPaste'), onClick: async () => {
                    try { setManual(await navigator.clipboard.readText()) } catch { /* 剪贴板权限不足时忽略 */ }
                  } }, CLIPBOARD_ICON),
                  h('button', { style: S.secondary, onClick: saveManual }, t('save')))),
              // 危险操作：红色描边按钮
              h('div', null,
                h('button', { style: S.dangerOutline, onClick: clearLoginData }, t('clearLoginData')),
                t('clearLoginDataDesc') ? h('div', { style: { ...S.small, marginTop: 8 } }, t('clearLoginDataDesc')) : null),
              // 插件更新（最底部：更轻的 ghost 样式 + 文字链接）
              h('div', null,
                h('div', { style: S.updateRow },
                  h('button', {
                    style: S.ghost,
                    onClick: checkUpdateNow,
                    disabled: updateState?.phase === 'checking' || updateState?.phase === 'updating',
                  }, updateState?.phase === 'checking' ? t('checkingUpdate') : t('checkUpdate')),
                  updateState?.phase === 'available' ? h('button', { style: S.primary, onClick: applyUpdateNow }, t('updateNow')) : null,
                  updateState && (updateState.phase === 'upToDate' || updateState.phase === 'available') ? h('a', { style: { ...S.repoLink, fontSize: 12 }, href: REPO_URL + '/releases', target: '_blank', rel: 'noreferrer' }, t('openReleases')) : null),
                updateState ? h('div', { style: { ...S.result, marginTop: 8 } },
                  updateState.phase === 'upToDate' ? h('span', { style: S.ok }, t('upToDate', { version: updateState.current })) : null,
                  updateState.phase === 'available' ? h('span', null, t('updateAvailable', { latest: updateState.latest, current: updateState.current })) : null,
                  updateState.phase === 'done' ? h('span', { style: S.ok }, t('updateDone', { version: updateState.version })) : null,
                  updateState.phase === 'error' ? h('span', { style: S.bad }, updateState.text) : null) : null)))))
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
        label: () => t('title'),
      }, () => h(SettingsPage)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
