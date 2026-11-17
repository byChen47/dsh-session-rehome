/**
 * dsh-session-rehome —— 浏览器半边。
 *
 * 在侧栏对话行的「…」菜单里加一行「移动到其他工作区…」，点开一个只列**别的**工作区的
 * 选择框，确认后把 `{ sessionId, workspaceId }` POST 给 Host。真正的搬运在 Host 半边。
 *
 * 两处刻意"少依赖"：
 *   1. 对话框自己向 Host 取工作区列表，不靠 slot 的隐式 props——那些 prop 是别的包
 *      内部的事，换个构建就没了；
 *   2. 菜单行与对话框都自己写 markup 与样式，只用 `react` 与主题 CSS token，
 *      不 import 任何会随构建变动的 Client 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-rehome',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'session-rehome'
    const ENDPOINT = '/session-rehome/move'
    const WORKSPACES_ENDPOINT = '/session-rehome/workspaces'
    const FILE_PLAN_ENDPOINT = '/session-rehome/file-plan'
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'
    const MENU_ORDER = 360

    const DICTIONARIES = {
      en: {
        'menu.label': 'Move to another workspace…',
        'title': 'Move this conversation',
        'description': '“{title}” moves into the workspace you pick: history, title and archive state stay, and the conversation id does not change.',
        'pick': 'Move into',
        'none': 'This conversation is already in every workspace. Create another workspace first.',
        'empty': 'No workspace is available, or the list could not be loaded.',
        'confirm': 'Move',
        'moving': 'Moving…',
        'cancel': 'Cancel',
        'running': 'This conversation is running a turn. Wait for it to finish, then try again.',
        'notStored': 'This conversation has never been written to disk (no message sent yet), so there is nothing to move.',
        'failed': 'The move failed: {detail}',
        'owner': 'current',
        'files.title': 'Files this conversation changed',
        'files.summary': '{count} file(s), {size} in total',
        'files.skipped': '{count} skipped (already in the target, missing, or outside the workspace)',
        'files.mode.move': 'Move them (delete from the old workspace)',
        'files.mode.copy': 'Copy them (keep the originals)',
        'files.mode.none': 'Session only',
        'files.more': '…and {count} more',
        'files.none': 'This conversation left no movable files in the old workspace.',
        'files.loading': 'Checking which files it changed…',
        'files.loadFailed': 'The file list could not be read.',
        'files.notLive': 'Cannot tell which files it changed: it has not been opened since DSH started. Open it once and try again.',
        'files.noTracker': 'This build does not record per-turn file changes, so its files cannot be listed.',
        'files.alreadyThere': 'The conversation already lives in that folder, so its files do not need to move.',
        'files.result': '{applied} file(s) {verb}, {failed} failed.',
        'files.verb.move': 'moved',
        'files.verb.copy': 'copied',
      },
      zh: {
        'menu.label': '移动到其他工作区…',
        'title': '移动这个对话',
        'description': '「{title}」会搬进你选的工作区：历史、标题、归档状态都保留，会话 id 不变。',
        'pick': '移动到',
        'none': '它已经在所有工作区里了。先创建另一个工作区再来。',
        'empty': '没有可用工作区，或者列表没取到。',
        'confirm': '移动',
        'moving': '正在移动…',
        'cancel': '取消',
        'running': '这条对话正在跑一轮，等结束后再试。',
        'notStored': '这条对话还没有落盘（没发过消息），没有可搬的东西。',
        'failed': '移动失败：{detail}',
        'owner': '当前',
        'files.title': '这个对话改过的文件',
        'files.summary': '共 {count} 个文件，{size}',
        'files.skipped': '{count} 个跳过（目标已存在、文件缺失或超出工作区）',
        'files.mode.move': '一起搬过去（从原工作区删除）',
        'files.mode.copy': '复制过去（保留原文件）',
        'files.mode.none': '只搬对话，不带文件',
        'files.more': '还有 {count} 个',
        'files.none': '这个对话没有在旧工作区留下可搬的文件。',
        'files.loading': '正在确认它改过哪些文件…',
        'files.loadFailed': '文件清单没读到。',
        'files.notLive': '无法确定它改过哪些文件：DSH 启动后它还没被打开过。先打开它一次再搬。',
        'files.noTracker': '这个构建没有开启逐轮文件变更记录，列不出它改过哪些文件。',
        'files.alreadyThere': '对话已经在这个工作区目录里了，文件不需要搬。',
        'files.result': '{applied} 个文件已{verb}，{failed} 个失败。',
        'files.verb.move': '搬迁',
        'files.verb.copy': '复制',
      },
    }


    // 菜单随弹窗一起卸载，所以待处理的请求放在模块作用域，由 shell overlay 渲染。
    let request = null
    const listeners = new Set()

    function openRequest(sessionId, displayTitle) {
      request = { sessionId, displayTitle, nonce: `${Date.now()}-${Math.random()}` }
      for (const listener of listeners) listener(request)
    }

    function closeRequest() {
      request = null
      for (const listener of listeners) listener(null)
    }

    function useRequest() {
      const [current, setCurrent] = React.useState(request)
      React.useEffect(() => {
        listeners.add(setCurrent)
        setCurrent(request)
        return () => listeners.delete(setCurrent)
      }, [])
      return current
    }

    /** 相对 `document.baseURI` 取路径：Electron 窗口下页面走自定义协议，硬编码端口会失效。 */
    const apiUrl = (path) => (typeof document === 'undefined' ? path : new URL(path.replace(/^\/+/, ''), document.baseURI).pathname)

    /** 人类可读的字节数。 */
    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / (1024 * 1024)).toFixed(1)} MB`
    }

    // ------------------------------------------------------------------
    // 样式（全部走主题 token，跟随明暗主题）
    // ------------------------------------------------------------------
    const menuRowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      minHeight: '28px',
      boxSizing: 'border-box',
      padding: '6px 8px',
      border: 'none',
      borderRadius: '6px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
      textAlign: 'left',
      cursor: 'pointer',
    }

    const backdropStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 40,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      background: 'rgba(0, 0, 0, 0.4)',
      pointerEvents: 'auto',
    }

    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      width: 'min(440px, calc(100vw - 32px))',
      maxHeight: 'calc(100vh - 64px)',
      boxSizing: 'border-box',
      padding: '20px',
      borderRadius: '12px',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 16px 48px rgba(0, 0, 0, 0.28)',
    }

    const titleStyle = { margin: 0, fontSize: '16px', lineHeight: '24px', fontWeight: 600 }
    const descriptionStyle = { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
    const listStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      overflowY: 'auto',
      maxHeight: '38vh',
      padding: '2px',
      margin: '0 -2px',
    }
    const footerStyle = { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }

    const buttonStyle = (primary, disabled) => ({
      minHeight: '32px',
      padding: '0 14px',
      borderRadius: '8px',
      border: primary ? 'none' : '0.5px solid var(--dsw-alias-border-l2)',
      background: primary ? 'var(--dsw-alias-label-primary)' : 'transparent',
      color: primary ? 'var(--dsw-alias-bg-overlay)' : 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
      fontWeight: primary ? 600 : 400,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    })

    function MoveIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('path', { d: 'M2.75 8h10.5' }),
        h('path', { d: 'M9.75 4.5 13.25 8l-3.5 3.5' }),
      )
    }

    // ------------------------------------------------------------------
    // 菜单行
    // ------------------------------------------------------------------
    function RelocateMenuItem({ sessionId, displayTitle, useMenuOpenState, useWorkspaces, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const [hover, setHover] = React.useState(false)
      // 归档行不显示这一项；拿不到那个 hook 就不判断，别为了它把整个菜单拖崩。
      const archived = typeof useWorkspaces === 'function'
        ? useWorkspaces((snapshot) => snapshot.archivedSessionIds.includes(sessionId))
        : false
      if (archived) return null
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          style: hover ? { ...menuRowStyle, background: 'var(--dsw-alias-bg-layer-2)' } : menuRowStyle,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onFocus: () => setHover(true),
          onBlur: () => setHover(false),
          onClick: () => {
            setMenuOpen(false)
            openRequest(sessionId, displayTitle)
          },
        },
        h(MoveIcon),
        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('menu.label')),
      )
    }

    // ------------------------------------------------------------------
    // 浮层入口
    // ------------------------------------------------------------------
    function RelocateDialogEntry({ t, onMoved }) {
      const current = useRequest()
      if (current === null) return null
      return h(RelocateDialog, {
        key: `${current.sessionId}:${current.nonce}`,
        request: current,
        t,
        onClose: closeRequest,
        onMoved,
      })
    }

    function RelocateDialog({ request, t, onClose, onMoved }) {
      const [all, setAll] = React.useState(null)
      const [selected, setSelected] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [plan, setPlan] = React.useState(null)
      const [planState, setPlanState] = React.useState('idle')
      const [fileMode, setFileMode] = React.useState('none')
      const cardRef = React.useRef(null)
      const restoreFocusRef = React.useRef(null)

      const choices = (all ?? []).filter((workspace) => !workspace.sessionIds.includes(request.sessionId))
      const choiceKey = choices.map((workspace) => workspace.id).join('|')

      // 选中目标后问一次 Host：这个对话改过哪些文件、能不能一起带过去。
      React.useEffect(() => {
        if (selected === null) {
          setPlan(null)
          setPlanState('idle')
          return undefined
        }
        let live = true
        setPlanState('loading')
        setPlan(null)
        fetch(apiUrl(FILE_PLAN_ENDPOINT), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: request.sessionId, workspaceId: selected }),
        })
          .then((response) => response.json())
          .then((payload) => {
            if (!live) return
            setPlan(payload?.ok === true ? payload : { available: false, reason: 'plan-failed', files: [], skipped: [] })
            setPlanState('ready')
          })
          .catch(() => {
            if (!live) return
            setPlan({ available: false, reason: 'plan-failed', files: [], skipped: [] })
            setPlanState('ready')
          })
        return () => {
          live = false
        }
      }, [selected, request.sessionId])

      // 有文件时默认「一起搬过去」，没有就只能是「只搬对话」。
      React.useEffect(() => {
        if (plan === null) return
        const movable = plan.available === true && Array.isArray(plan.files) && plan.files.length > 0
        setFileMode(movable ? 'move' : 'none')
      }, [plan])


      React.useEffect(() => {
        let live = true
        fetch(apiUrl(WORKSPACES_ENDPOINT), { cache: 'no-store' })
          .then((response) => response.json())
          .then((payload) => {
            if (!live) return
            if (payload?.ok === true && Array.isArray(payload.workspaces)) setAll(payload.workspaces)
            else setAll([])
          })
          .catch(() => {
            if (live) setAll([])
          })
        return () => {
          live = false
        }
      }, [])

      React.useEffect(() => {
        setSelected((current) => {
          if (current !== null && choices.some((workspace) => workspace.id === current)) return current
          return choices[0]?.id ?? null
        })
      }, [choiceKey])

      React.useEffect(() => {
        restoreFocusRef.current = typeof document === 'undefined' ? null : document.activeElement
        const card = cardRef.current
        const initial = card?.querySelector('[data-autofocus]') ?? card?.querySelector('button')
        initial?.focus()
        return () => {
          const previous = restoreFocusRef.current
          if (previous !== null && typeof previous.focus === 'function') {
            try {
              previous.focus()
            } catch {
              // 打开菜单的那一行可能已经不在了。
            }
          }
        }
      }, [])

      React.useEffect(() => {
        if (busy || typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [busy, onClose])

      const confirm = async () => {
        if (busy || selected === null) return
        setBusy(true)
        setError(null)
        try {
          const response = await fetch(apiUrl(ENDPOINT), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: request.sessionId, workspaceId: selected, files: fileMode }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) throw new Error(localizeFailure(payload, t))
          const target = choices.find((workspace) => workspace.id === selected)
          onMoved?.({ ...payload, workspaceId: selected, title: target?.title })
          onClose()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const close = () => {
        if (busy) return
        onClose()
      }

      const body = all === null
        ? h('p', { style: descriptionStyle }, '…')
        : choices.length === 0
          ? h('p', { style: descriptionStyle }, all.length === 0 ? t('empty') : t('none'))
          : h(
              'div',
              { role: 'radiogroup', 'aria-label': t('pick'), style: listStyle },
              ...choices.map((workspace) =>
                h(
                  'button',
                  {
                    key: workspace.id,
                    type: 'button',
                    role: 'radio',
                    'aria-checked': workspace.id === selected,
                    disabled: busy,
                    onClick: () => setSelected(workspace.id),
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: '2px',
                      padding: '8px 10px',
                      borderRadius: '8px',
                      border: workspace.id === selected
                        ? '1px solid var(--dsw-alias-label-primary)'
                        : '0.5px solid var(--dsw-alias-border-l2)',
                      background: workspace.id === selected ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                      color: 'var(--dsw-alias-label-primary)',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: '18px',
                      textAlign: 'left',
                      cursor: busy ? 'not-allowed' : 'pointer',
                    },
                  },
                  h('span', { style: { fontWeight: 500 } }, workspace.title),
                  h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, workspace.path),
                ),
              ),
            )

      // ---- 随迁文件：预览 + 三选一 ----------------------------------------
      const modeStyle = (active, disabled) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 10px',
        borderRadius: '8px',
        border: active ? '1px solid var(--dsw-alias-label-primary)' : '0.5px solid var(--dsw-alias-border-l2)',
        background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: '18px',
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
      })

      const fileBlock = (() => {
        if (planState === 'loading') return h('p', { style: descriptionStyle }, t('files.loading'))
        if (planState !== 'ready' || plan === null) return null
        const heading = h('div', { style: { ...descriptionStyle, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, t('files.title'))
        if (plan.available !== true) {
          const key = plan.reason === 'session-not-live'
            ? 'files.notLive'
            : plan.reason === 'no-change-tracker'
              ? 'files.noTracker'
              : plan.reason === 'already-there'
                ? 'files.alreadyThere'
                : 'files.loadFailed'
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, heading, h('p', { style: descriptionStyle }, t(key)))
        }
        const files = Array.isArray(plan.files) ? plan.files : []
        if (files.length === 0) {
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, heading, h('p', { style: descriptionStyle }, t('files.none')))
        }
        const skipped = Array.isArray(plan.skipped) ? plan.skipped.length : 0
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          heading,
          h('p', { style: descriptionStyle }, t('files.summary', { count: files.length, size: formatBytes(plan.totalBytes ?? 0) })),
          skipped > 0 ? h('p', { style: { ...descriptionStyle, fontSize: '12px' } }, t('files.skipped', { count: skipped })) : null,
          h(
            'div',
            { role: 'radiogroup', 'aria-label': t('files.title'), style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            ...['move', 'copy', 'none'].map((mode) =>
              h(
                'button',
                {
                  key: mode,
                  type: 'button',
                  role: 'radio',
                  'aria-checked': fileMode === mode,
                  disabled: busy,
                  onClick: () => setFileMode(mode),
                  style: modeStyle(fileMode === mode, busy),
                },
                t('files.mode.' + mode),
              ),
            ),
          ),
          h(
            'ul',
            { style: { ...listStyle, maxHeight: '16vh', margin: 0, paddingLeft: '18px' } },
            ...files.slice(0, 4).map((file) =>
              h('li', { key: file.path, style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } }, file.path),
            ),
          ),
          files.length > 4 ? h('p', { style: { ...descriptionStyle, fontSize: '12px' } }, t('files.more', { count: files.length - 4 })) : null,
        )
      })()

      return h(
        'div',
        {
          style: backdropStyle,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) close()
          },
        },
        h(
          'div',
          { ref: cardRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title'), style: cardStyle },
          h('h2', { style: titleStyle }, t('title')),
          h('p', { style: descriptionStyle }, t('description', { title: request.displayTitle ?? request.sessionId })),
          body,
          fileBlock,
          error === null ? null : h('p', { style: { ...descriptionStyle, color: 'var(--dsw-alias-label-error, #d33)' }, role: 'alert' }, error),
          h(
            'div',
            { style: footerStyle },
            h('button', { type: 'button', disabled: busy, onClick: close, style: buttonStyle(false, busy) }, t('cancel')),
            h(
              'button',
              {
                type: 'button',
                'data-autofocus': true,
                disabled: busy || selected === null,
                onClick: confirm,
                style: buttonStyle(true, busy || selected === null),
              },
              busy ? t('moving') : t('confirm'),
            ),
          ),
        ),
      )
    }

    /** 把 Host 的稳定错误码翻成人话。 */
    function localizeFailure(payload, t) {
      const code = typeof payload?.code === 'string' ? payload.code : ''
      if (code === 'session-running') return t('running')
      if (code === 'session-not-stored' || code === 'blank-session') return t('notStored')
      const detail = typeof payload?.message === 'string' && payload.message !== '' ? payload.message : code || 'unknown'
      return t('failed', { detail })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES))

        const uiWorkspace = ctx.get('uiWorkspace')
        const onMoved = (payload) => {
          if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') return
          try {
            uiWorkspace.openSession(payload.sessionId)
          } catch {
            // 侧栏自己会跟着归属变化刷新，跳转只是顺手。
          }
        }

        ctx.slots.inject(MENU_SLOT, () =>
          ctx.slots.register(
            { name: MENU_SLOT, id: 'session-rehome', order: MENU_ORDER, locale: NS },
            RelocateMenuItem,
          ),
        )

        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register(
            { name: OVERLAY_SLOT, id: 'session-rehome.dialog', locale: NS },
            (slotProps) => h(RelocateDialogEntry, { ...slotProps, onMoved }),
          ),
        )
      },
    }
  },
})
