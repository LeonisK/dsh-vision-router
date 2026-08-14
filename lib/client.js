// dsh-vision-router browser half: the 设置 > 插件 > 插件配置 card that edits
// the `vision-router` settings section owned by the host half. Self-contained
// by hand (no bundler in this repo): the client module system wraps it in a
// CJS factory and the kernel adopts { apply, inject } as a client plugin.
window.__ModuleLoader__.load({
  id: 'dsh-vision-router',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const { useState, useSyncExternalStore } = React

    // ── field specs ──────────────────────────────────────────────────────────
    const TOGGLE_KEYS = ['routing', 'tool', 'rewriteImages', 'stealth']
    const TOGGLE_LABELS = {
      routing: '图片轮自动路由（发图自动走视觉模型链）',
      tool: '识图工具（vision_describe 等，关闭后调用会报错）',
      rewriteImages: '文字轮图片改写（把历史图片替换为文字记录）',
      stealth: '隐身模式（接管官方 DeepSeek 路由，模型选择器保持原样）',
    }
    const TOGGLE_HINTS = {
      stealth:
        '需在 profile 补丁层（cordis.patch.yml）禁用官方 llm-deepseek 行后才真正接管；' +
        '官方行还在时插件会自动回退为选择器里的「自动识图」包装路由。改动后需重启 dsh 生效。',
    }
    const TEXT_KEYS = ['wrapperRoute', 'chainRoute']
    const TEXT_LABELS = {
      wrapperRoute: '包装路由名（模型选择器里显示的“自动识图”入口）',
      chainRoute: '视觉链路由名',
    }

    function readValue(snapshot, key) {
      const value = snapshot && snapshot.value
      return value && typeof value === 'object' ? value[key] : undefined
    }
    function userHas(snapshot, key) {
      const user = snapshot && snapshot.user
      return user && typeof user === 'object' && key in user
    }

    function providersToText(value) {
      if (!Array.isArray(value)) return ''
      return value
        .map((pair) => (pair && pair.provider ? `${pair.provider}/${pair.model ?? ''}` : ''))
        .join('\n')
    }
    function parseProviders(text) {
      const list = []
      for (const raw of String(text ?? '').split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        const idx = line.indexOf('/')
        if (idx <= 0) return undefined
        const provider = line.slice(0, idx).trim()
        const model = line.slice(idx + 1).trim()
        if (provider === '' || model === '') return undefined
        list.push({ provider, model })
      }
      return list
    }
    function textProviderToText(value) {
      if (!value || typeof value !== 'object') return ''
      return `${value.provider ?? ''}/${value.model ?? ''}`
    }
    function parseTextProvider(text) {
      const idx = String(text ?? '').indexOf('/')
      if (idx <= 0) return undefined
      const provider = String(text).slice(0, idx).trim()
      const model = String(text).slice(idx + 1).trim()
      if (provider === '' || model === '') return undefined
      return { provider, model }
    }
    function parseNumber(text) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return { clear: true }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) && parsed >= 1000
        ? { value: parsed }
        : undefined
    }

    // ── tiny styled primitives ───────────────────────────────────────────────
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' },
      row: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 13, fontWeight: 600, color: 'var(--ds-color-text, #333)' },
      hint: { fontSize: 12, color: 'var(--ds-color-text-muted, #888)' },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13,
        borderRadius: 6, border: '1px solid var(--ds-color-border, #ccc)',
        background: 'var(--ds-color-bg-input, #fff)', color: 'var(--ds-color-text, #333)',
      },
      area: {
        width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 12,
        borderRadius: 6, border: '1px solid var(--ds-color-border, #ccc)', minHeight: 84,
        fontFamily: 'monospace', background: 'var(--ds-color-bg-input, #fff)',
        color: 'var(--ds-color-text, #333)',
      },
      toggleRow: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' },
      toggleLabel: { fontSize: 13, color: 'var(--ds-color-text, #333)', flex: 1 },
      check: { width: 18, height: 18, accentColor: 'var(--ds-color-accent, #4c8bf5)', cursor: 'pointer' },
      buttons: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
      btn: {
        padding: '7px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--ds-color-border, #ccc)',
        background: 'var(--ds-color-bg, #fff)', color: 'var(--ds-color-text, #333)',
      },
      btnPrimary: {
        padding: '7px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer', border: 'none',
        background: 'var(--ds-color-accent, #4c8bf5)', color: '#fff',
      },
      btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
      badge: {
        fontSize: 11, padding: '1px 6px', borderRadius: 999, color: '#b45309',
        background: 'rgba(245,158,11,0.15)',
      },
      status: { fontSize: 12, color: 'var(--ds-color-text-muted, #888)' },
      statusErr: { fontSize: 12, color: '#dc2626' },
      reset: { fontSize: 12, cursor: 'pointer', color: 'var(--ds-color-accent, #4c8bf5)', background: 'none', border: 'none', padding: 0 },
    }

    function VisionRouterCard(props) {
      const scope = props.scope
      const snapshot = useSyncExternalStore(scope.subscribe, scope.getSnapshot)
      const [drafts, setDrafts] = useState({})
      const [saving, setSaving] = useState(false)
      const [failed, setFailed] = useState(false)

      const status = snapshot.status
      if (status !== 'ready') {
        return React.createElement(
          'div', { style: S.status },
          status === 'loading' ? '加载配置中…' : 'vision-router 配置命名空间不可用（宿主未注册）。',
        )
      }
      const writable = snapshot.writable

      const format = (key) => {
        if (key in drafts) return drafts[key]
        const value = readValue(snapshot, key)
        if (key === 'providers') return providersToText(value)
        if (key === 'textProvider') return textProviderToText(value)
        if (key === 'timeoutMs') return typeof value === 'number' ? String(value) : ''
        if (TOGGLE_KEYS.includes(key)) return value === true
        return typeof value === 'string' ? value : ''
      }
      const parse = (key, text) => {
        if (TOGGLE_KEYS.includes(key)) return { value: text === true }
        if (key === 'providers') {
          const value = parseProviders(text)
          return value === undefined ? undefined : { value }
        }
        if (key === 'textProvider') {
          const value = parseTextProvider(text)
          return value === undefined ? undefined : { value }
        }
        if (key === 'timeoutMs') return parseNumber(text)
        const trimmed = String(text ?? '').trim()
        return trimmed === '' ? { clear: true } : { value: trimmed }
      }
      const plan = Object.keys(drafts)
        .map((key) => ({ key, run: parse(key, drafts[key]) }))
        .filter((item) => item.run !== undefined)
      const dirty = Object.keys(drafts).length > 0
      const invalid = plan.length !== Object.keys(drafts).length

      const setDraft = (key, text) => {
        setFailed(false)
        setDrafts((prev) => ({ ...prev, [key]: text }))
      }
      const clearDrafts = () => {
        setDrafts({})
        setFailed(false)
      }
      const save = async () => {
        if (!dirty || invalid || saving) return
        setSaving(true)
        setFailed(false)
        let landed = true
        for (const item of plan) {
          if (item.run.clear) {
            const ok = await scope.unset(item.key).then(() => true, () => false)
            landed = ok && landed
          } else {
            const ok = await scope.set(item.key, item.run.value).then(() => true, () => false)
            landed = ok && landed
          }
        }
        if (landed) setDrafts({})
        setSaving(false)
        setFailed(!landed)
      }
      const resetField = (key) => {
        setFailed(false)
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        scope.unset(key)
      }

      const toggleRow = (key) => React.createElement(
        'div', { key, style: S.row },
        React.createElement('div', { style: S.toggleRow },
          React.createElement('span', { style: S.toggleLabel },
            TOGGLE_LABELS[key],
            userHas(snapshot, key)
              ? React.createElement('span', { style: S.badge }, '已覆盖')
              : null,
          ),
          React.createElement('input', {
            type: 'checkbox', style: S.check, checked: format(key), disabled: !writable,
            onChange: (event) => setDraft(key, event.target.checked),
          }),
        ),
        TOGGLE_HINTS[key]
          ? React.createElement('span', { style: S.hint }, TOGGLE_HINTS[key])
          : null,
      )
      const textRow = (key, label, multi) => React.createElement(
        'div', { key, style: S.row },
        React.createElement('div', { style: S.toggleRow },
          React.createElement('span', { style: S.label },
            label,
            userHas(snapshot, key)
              ? React.createElement('span', { style: S.badge }, '已覆盖')
              : null,
          ),
          userHas(snapshot, key)
            ? React.createElement('button', {
                style: S.reset, disabled: saving,
                onClick: () => resetField(key), title: '恢复为组合配置默认值',
              }, '恢复默认')
            : null,
        ),
        React.createElement(multi ? 'textarea' : 'input', {
          style: multi ? S.area : S.input, value: format(key), disabled: !writable,
          placeholder: '',
          onChange: (event) => setDraft(key, event.target.value),
        }),
        key === 'providers'
          ? React.createElement('span', { style: S.hint },
              '每行一个「provider/model」，从上到下按失败顺序回退；留空清除用户覆盖。')
          : key === 'textProvider'
            ? React.createElement('span', { style: S.hint }, '文字轮的底层模型，格式「provider/model」。')
            : key === 'timeoutMs'
              ? React.createElement('span', { style: S.hint }, '单个视觉请求超时；默认 120000。')
              : null,
      )

      return React.createElement(
        'div', { style: S.wrap },
        TOGGLE_KEYS.map((key) => toggleRow(key)),
        textRow('timeoutMs', '视觉请求超时（毫秒）', false),
        TEXT_KEYS.map((key) => textRow(key, TEXT_LABELS[key], false)),
        textRow('providers', '视觉模型链', true),
        textRow('textProvider', '文本模型', false),
        React.createElement('div', { style: S.status },
          invalid ? '有字段格式不对（模型链每行需「provider/model」；超时需 ≥1000 的整数）' : '',
        ),
        React.createElement('div', { style: S.buttons },
          React.createElement('button', {
            style: { ...S.btn, ...(!dirty || saving ? S.btnDisabled : {}) },
            disabled: !dirty || saving, onClick: clearDrafts,
          }, '放弃修改'),
          React.createElement('button', {
            style: {
              ...S.btnPrimary,
              ...(!dirty || invalid || saving || !writable ? S.btnDisabled : {}),
            },
            disabled: !dirty || invalid || saving || !writable, onClick: save,
          }, saving ? '保存中…' : '保存'),
        ),
        failed
          ? React.createElement('div', { style: S.statusErr }, '保存失败：宿主拒绝了本次写入（可能配置被其他会话改动），请重试。')
          : null,
      )
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: 'vision-router' })
      ctx.effect(
        () =>
          ctx.slots.inject('settings.plugin.item', function* () {
            yield ctx.slots.register(
              {
                name: 'settings.plugin.item',
                id: 'vision-router',
                order: 30,
                label: '视觉路由（自动识图）',
                inject: () => ({ scope }),
              },
              VisionRouterCard,
            )
          }),
        'vision-router: settings card',
      )
    }

    exports.apply = apply
    exports.inject = ['settingsScope', 'slots']
    return module.exports
  },
})
