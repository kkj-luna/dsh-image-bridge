window.__ModuleLoader__.load({
  id: '@local/dsh-image-bridge',
  factory(require) {
    /**
     * 生图桥 · Client 半。
     *
     * 两件事：
     *
     * 1. 为 `image_generate` / `image_edit` 注册自定义工具卡片。内置渲染没有为第三方
     *    生图留位置——富图片卡片在 `dsh-client-ui-tool` 里按工具名硬编码只认
     *    `read_image`，通用卡片又用 `flattenContent` 只取 text 块、直接丢弃 image 块。
     *    所以生图结果必须由本插件自己渲染：从工具结果的 `meta`
     *    （Host 侧 `output.presentationMeta`）取图片引用，再走宿主的 `tool.call.images`
     *    子插槽交给附件展示插件画出来。
     * 2. 在「设置」里注册一个配置页：接口地址、模型、尺寸、API Key，带保存与测试连接。
     *    API Key 走 `remote.credentials`（Host 端不回传、不写进 profile 的 YAML），
     *    其余字段走 `remote.settings`（写进本插件行的 volatile 配置）。
     *
     * 不导入任何 Harness 客户端包：React 由浏览器模块表提供，控件与样式全部自持，
     * 颜色只用 `--dsw-alias-*` 主题令牌。所有组件都保持全域可执行——宿主对渲染期抛错
     * 的插槽条目会永久弃用，所以任何字段缺失都退化成一行文本。
     */
    const React = require('react')
    const h = React.createElement

    /** 文案命名空间。 */
    const NS = 'dsh-image-bridge'
    /** settings 写入的命名空间 = 本插件在 profile patch 里的行 id。 */
    const SETTINGS_NS = 'image-bridge'
    /** API Key 在 credentials 服务里的引用名。 */
    const API_KEY_REF = 'DSH_IMAGE_BRIDGE_API_KEY'
    /** Host 半注册的测试通道。 */
    const RPC_CHANNEL = '/dsh-image-bridge'

    const MESSAGES = {
      zh: {
        'generate.title': '生图',
        'edit.title': '改图',
        'generate.running': '正在生成图片…',
        'edit.running': '正在修改图片…',
        'failed.title': '生图失败',
        'editFailed.title': '改图失败',
        'hint.noVision': '当前模型不能直接查看图片，已保存到工作区文件。',
        'hint.noGallery': '图片已生成，但当前界面未挂载图片展示能力。',
        'label.model': '模型',
        'label.file': '文件',
        'nav': '生图桥',
        'intro': '把外部生图模型接给当前模型使用：这里填好接口后，模型就能调用生图与改图能力。',
        'baseUrl': '接口地址',
        'baseUrl.hint': 'OpenAI 兼容地址，例如 https://api.openai.com/v1、https://open.bigmodel.cn/api/paas/v4。',
        'model': '生图模型',
        'model.hint': '例如 gpt-image-1、cogview-4、Kwai-Kolors/Kolors。',
        'size': '默认尺寸',
        'size.hint': '例如 1024x1024、1024x1536、1536x1024。',
        'apiKey': 'API Key',
        'apiKey.set': '已保存密钥；留空表示不修改。',
        'apiKey.unset': '尚未保存密钥。',
        'save': '保存',
        'saving': '保存中…',
        'saved': '已保存。',
        'test': '测试连接',
        'testing': '测试中…',
        'loading': '正在载入当前配置…',
        'unavailable': '配置界面暂时不可用（未能连上 Host 的配置服务）。',
        'savedKey': '密钥已保存。',
      },
      en: {
        'generate.title': 'Image generation',
        'edit.title': 'Image edit',
        'generate.running': 'Generating image…',
        'edit.running': 'Editing image…',
        'failed.title': 'Image generation failed',
        'editFailed.title': 'Image edit failed',
        'hint.noVision': 'The current model cannot view images; the result was saved to a workspace file.',
        'hint.noGallery': 'The image was generated, but no image gallery is mounted in this UI.',
        'label.model': 'Model',
        'label.file': 'File',
        'nav': 'Image Bridge',
        'intro': 'Bridges an external image model into the current model, so it can generate and edit images.',
        'baseUrl': 'API base URL',
        'baseUrl.hint': 'An OpenAI-compatible base URL, e.g. https://api.openai.com/v1.',
        'model': 'Image model',
        'model.hint': 'For example gpt-image-1, cogview-4, Kwai-Kolors/Kolors.',
        'size': 'Default size',
        'size.hint': 'For example 1024x1024, 1024x1536, 1536x1024.',
        'apiKey': 'API key',
        'apiKey.set': 'A key is stored; leave blank to keep it.',
        'apiKey.unset': 'No key stored yet.',
        'save': 'Save',
        'saving': 'Saving…',
        'saved': 'Saved.',
        'test': 'Test connection',
        'testing': 'Testing…',
        'loading': 'Loading current settings…',
        'unavailable': 'Configuration is unavailable (the Host configuration service is not reachable).',
        'savedKey': 'Key stored.',
      },
    }

    const CSS = [
      /* 工具卡片 */
      '.dib-row{display:flex;flex-direction:column;gap:6px;padding:6px 0;font-size:13px;line-height:1.5}',
      '.dib-head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dib-badge{color:var(--dsw-alias-label-secondary);font-weight:400}',
      '.dib-prompt{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
      '.dib-pending{color:var(--dsw-alias-state-idle-primary)}',
      '.dib-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-word}',
      '.dib-hint{color:var(--dsw-alias-state-warn-primary)}',
      '.dib-files{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dib-file{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dib-count{color:var(--dsw-alias-label-secondary)}',
      /* 设置页 */
      '.dib-cfg{display:flex;flex-direction:column;max-width:560px}',
      '.dib-cfg-intro{margin:0 0 4px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.dib-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
      '.dib-field+.dib-field{border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.dib-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dib-input{height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dib-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.dib-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dib-field-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dib-footer{display:flex;align-items:center;gap:8px;padding-top:16px;flex-wrap:wrap}',
      '.dib-btn{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dib-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dib-btn:disabled{opacity:0.4;cursor:default}',
      '.dib-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dib-btn-secondary{background:transparent;border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}',
      '.dib-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dib-status{flex:1 1 100%;margin:0;font-size:12px;line-height:1.6}',
      '.dib-status-ok{color:var(--dsw-alias-state-success-primary)}',
      '.dib-status-error{color:var(--dsw-alias-state-error-primary)}',
      '.dib-status-info{color:var(--dsw-alias-label-secondary)}',
    ].join('')

    /* ------------------------------------------------------------------ */
    /* 工具卡片                                                             */
    /* ------------------------------------------------------------------ */

    /** 取结果里所有 text 块的拼接文本；用于错误信息与兜底展示。 */
    function textOf(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('\n')
    }

    /**
     * 收集可展示的图片引用。
     *
     * 优先用 Host 的 `presentationMeta.images`（与模型视觉能力无关，纯文本模型下也在），
     * 缺失时退回工具结果内容里的 image 块。
     */
    function imagesOf(meta, content) {
      const out = []
      const declared = meta !== null && typeof meta === 'object' && Array.isArray(meta.images) ? meta.images : null
      if (declared !== null) {
        for (const image of declared) {
          if (image !== null && typeof image === 'object' && typeof image.attachmentId === 'string') {
            out.push({ attachment: image })
          }
        }
      }
      if (out.length === 0 && Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'image' && block.attachment && typeof block.attachment.attachmentId === 'string') {
            out.push({ attachment: block.attachment })
          }
        }
      }
      return out
    }

    function filesOf(meta) {
      const saved = meta !== null && typeof meta === 'object' && Array.isArray(meta.savedPaths) ? meta.savedPaths : []
      return saved.filter((path) => typeof path === 'string' && path !== '')
    }

    /** 运行中的调用：参数在调用节点上，结果节点还不存在。 */
    function argsOf(block) {
      if (block === null || typeof block !== 'object') return {}
      if (block.args !== null && typeof block.args === 'object') return block.args
      if (block.call !== null && typeof block.call === 'object' && block.call.args !== null && typeof block.call.args === 'object') return block.call.args
      return {}
    }

    /** 一次生图/改图调用的卡片。 */
    function ImageResultRow(props) {
      const tr = translate(props.t)
      const block = props.block
      const isEdit = props.toolName === 'image_edit'
      const settled = block !== null && typeof block === 'object' && block.kind !== undefined
      const meta = settled && block.meta !== null && typeof block.meta === 'object' ? block.meta : null
      const args = argsOf(block)
      const prompt = typeof meta?.prompt === 'string' ? meta.prompt : typeof args.prompt === 'string' ? args.prompt : ''
      const model = typeof meta?.model === 'string' ? meta.model : typeof args.model === 'string' ? args.model : ''

      if (!settled) {
        return h('div', { className: 'dib-row' }, [
          h('div', { key: 'head', className: 'dib-head' }, tr(isEdit ? 'edit.title' : 'generate.title')),
          h('div', { key: 'pending', className: 'dib-pending' }, tr(isEdit ? 'edit.running' : 'generate.running')),
          prompt === '' ? null : h('div', { key: 'prompt', className: 'dib-prompt' }, prompt),
        ])
      }

      const failed = block.isError === true
      const content = block.content
      const rows = [h('div', { key: 'head', className: 'dib-head' }, failed
        ? tr(isEdit ? 'editFailed.title' : 'failed.title')
        : [
          h('span', { key: 'title' }, tr(isEdit ? 'edit.title' : 'generate.title')),
          model === '' ? null : h('span', { key: 'model', className: 'dib-badge' }, `${tr('label.model')} ${model}`),
        ])]

      if (failed) {
        const message = textOf(content).trim()
        rows.push(h('div', { key: 'error', className: 'dib-error' }, message === '' ? 'unknown error' : message))
        return h('div', { className: 'dib-row' }, rows)
      }

      if (prompt !== '') rows.push(h('div', { key: 'prompt', className: 'dib-prompt' }, prompt))

      const images = imagesOf(meta, content)
      const files = filesOf(meta)

      if (images.length > 0) {
        if (props.renderSlot !== undefined && props.loadImage !== undefined) {
          rows.push(h('div', { key: 'gallery' }, props.renderSlot('tool.call.images', {
            images,
            loadImage: props.loadImage,
            align: 'start',
          })))
        } else {
          rows.push(h('div', { key: 'nogallery', className: 'dib-hint' }, tr('hint.noGallery')))
        }
      }

      if (meta !== null && meta.imageCapable === false) {
        rows.push(h('div', { key: 'novision', className: 'dib-hint' }, tr('hint.noVision')))
      }

      if (files.length > 0) {
        rows.push(h('div', { key: 'files', className: 'dib-files' }, files.map((path, index) => (
          h('div', { key: String(index), className: 'dib-file', title: path }, `${tr('label.file')} ${path}`)
        ))))
      } else if (images.length === 0) {
        const message = textOf(content).trim()
        rows.push(h('div', { key: 'empty', className: 'dib-prompt' }, message === '' ? tr('hint.noGallery') : message))
      }

      return h('div', { className: 'dib-row' }, rows)
    }

    /* ------------------------------------------------------------------ */
    /* 设置页                                                              */
    /* ------------------------------------------------------------------ */

    /** 取不到 locale 面时回退到中文文案，绝不让 `t` 缺失变成渲染崩溃。 */
    function translate(t) {
      return (key) => {
        if (typeof t === 'function') {
          const value = t(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        }
        return MESSAGES.zh[key] ?? key
      }
    }

    /**
     * 找一个远程命名空间。
     *
     * `remote` 既可能作为网关服务暴露（`ctx.get('remote').settings`），也可能直接
     * 注册成 `remote.settings`；两条路都试，任一可用即可，都不可用就让设置页
     * 退化成一行提示而不是抛错。
     */
    function remoteNamespace(ctx, name) {
      const gateway = ctx.get('remote')
      if (gateway !== undefined && gateway !== null && gateway[name] !== undefined) return gateway[name]
      const direct = ctx.get(`remote.${name}`)
      if (direct !== undefined) return direct
      try {
        const property = ctx.remote
        if (property !== undefined && property !== null && property[name] !== undefined) return property[name]
      } catch {
        /* 属性访问在未声明 inject 时可能被拒绝，忽略即可 */
      }
      return undefined
    }

    let rpcSeq = 0

    /** 调 Host 的测试通道，拆掉 {ok,value} 信封。 */
    async function callHost(endpoint, payload) {
      const response = await fetch(`${RPC_CHANNEL}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `image-bridge-${(rpcSeq += 1)}`, method: endpoint, payload }),
      })
      if (!response.ok) throw new Error(`测试通道返回 HTTP ${response.status}`)
      const envelope = await response.json()
      if (envelope === null || typeof envelope !== 'object' || envelope.type !== 'server-response') {
        throw new Error('测试通道响应格式不正确')
      }
      const result = envelope.result
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        throw new Error(result !== null && typeof result === 'object' && result.error !== undefined ? String(result.error.message) : '测试通道调用失败')
      }
      return result.value
    }

    /** 一个受控文本输入行。 */
    function field(id, label, hint, value, disabled, onChange, type) {
      return h('div', { className: 'dib-field', key: id }, [
        h('label', { key: 'label', className: 'dib-label', htmlFor: id }, label),
        h('input', {
          key: 'input',
          id,
          className: 'dib-input',
          type: type ?? 'text',
          value,
          disabled,
          spellCheck: false,
          autoComplete: 'off',
          'aria-describedby': `${id}-hint`,
          onChange: (event) => onChange(event.target.value),
        }),
        h('p', { key: 'hint', id: `${id}-hint`, className: 'dib-field-hint' }, hint),
      ])
    }

    function ConfigPage(props) {
      const tr = translate(props.t)
      const ctx = props.__ctx
      const [state, setState] = React.useState({
        phase: 'loading',
        writable: true,
        available: true,
        baseUrl: '',
        model: '',
        size: '',
        keyDraft: '',
        keyConfigured: false,
        status: '',
        statusKind: 'info',
      })

      const patch = React.useCallback((next) => setState((current) => ({ ...current, ...next })), [])

      const settings = React.useMemo(() => (ctx === undefined ? undefined : remoteNamespace(ctx, 'settings')), [ctx])
      const credentials = React.useMemo(() => (ctx === undefined ? undefined : remoteNamespace(ctx, 'credentials')), [ctx])

      React.useEffect(() => {
        if (settings === undefined) {
          patch({ phase: 'idle', available: false })
          return undefined
        }
        let live = true
        ;(async () => {
          try {
            const described = await settings.describe()
            if (!live) return
            if (described === null || typeof described !== 'object' || described.ok !== true) {
              patch({ phase: 'idle', available: false })
              return
            }
            const view = (described.value.namespaces ?? []).find((candidate) => candidate !== null && candidate.ns === SETTINGS_NS)
            const value = view !== undefined && view.value !== null && typeof view.value === 'object' ? view.value : {}
            let keyConfigured = false
            if (credentials !== undefined) {
              const stored = await credentials.describe([API_KEY_REF])
              if (!live) return
              if (stored !== null && typeof stored === 'object' && stored.ok === true) {
                const info = stored.value[API_KEY_REF]
                keyConfigured = info !== undefined && info !== null && info.configured === true
              }
            }
            patch({
              phase: 'idle',
              writable: described.value.writable === true,
              baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
              model: typeof value.model === 'string' ? value.model : '',
              size: typeof value.size === 'string' ? value.size : '',
              keyConfigured,
            })
          } catch (error) {
            if (!live) return
            patch({ phase: 'idle', available: false, status: error instanceof Error ? error.message : String(error), statusKind: 'error' })
          }
        })()
        return () => {
          live = false
        }
      }, [settings, credentials, patch])

      const save = React.useCallback(async () => {
        if (settings === undefined) return
        patch({ phase: 'saving', status: '', statusKind: 'info' })
        try {
          const written = await settings.update(SETTINGS_NS, { baseUrl: state.baseUrl, model: state.model, size: state.size }, undefined)
          if (written === null || typeof written !== 'object' || written.ok !== true) {
            throw new Error(written !== null && typeof written === 'object' && written.error !== undefined ? String(written.error.message) : '保存失败')
          }
          let status = tr('saved')
          if (state.keyDraft.length > 0) {
            if (credentials === undefined) throw new Error('凭据服务不可用，无法保存 API Key')
            const stored = await credentials.set(API_KEY_REF, state.keyDraft)
            if (stored === null || typeof stored !== 'object' || stored.ok !== true) {
              throw new Error(stored !== null && typeof stored === 'object' && stored.error !== undefined ? String(stored.error.message) : 'API Key 保存失败')
            }
            status = `${tr('saved')} ${tr('savedKey')}`
            patch({ keyDraft: '', keyConfigured: true })
          }
          patch({ phase: 'idle', status, statusKind: 'ok' })
        } catch (error) {
          patch({ phase: 'idle', status: error instanceof Error ? error.message : String(error), statusKind: 'error' })
        }
      }, [settings, credentials, state.baseUrl, state.model, state.size, state.keyDraft, patch, tr])

      const test = React.useCallback(async () => {
        patch({ phase: 'testing', status: '', statusKind: 'info' })
        try {
          const result = await callHost('test', { baseUrl: state.baseUrl, apiKey: state.keyDraft })
          const ok = result !== null && typeof result === 'object' && result.ok === true
          patch({
            phase: 'idle',
            status: result !== null && typeof result === 'object' && typeof result.message === 'string' ? result.message : '',
            statusKind: ok ? 'ok' : 'error',
          })
        } catch (error) {
          patch({ phase: 'idle', status: error instanceof Error ? error.message : String(error), statusKind: 'error' })
        }
      }, [state.baseUrl, state.keyDraft, patch])

      if (state.phase === 'loading') {
        return h('div', { className: 'dib-cfg' }, h('p', { className: 'dib-field-hint' }, tr('loading')))
      }
      if (!state.available) {
        return h('div', { className: 'dib-cfg' }, h('p', { className: 'dib-field-hint' }, tr('unavailable')))
      }

      const disabled = state.writable === false
      const busy = state.phase === 'saving' || state.phase === 'testing'
      const statusClass = state.statusKind === 'ok' ? 'dib-status dib-status-ok' : state.statusKind === 'error' ? 'dib-status dib-status-error' : 'dib-status dib-status-info'

      return h('div', { className: 'dib-cfg' }, [
        h('p', { key: 'intro', className: 'dib-cfg-intro' }, tr('intro')),
        h('form', {
          key: 'form',
          onSubmit: (event) => {
            event.preventDefault()
            if (!busy && !disabled) void save()
          },
        }, [
          field('dib-base-url', tr('baseUrl'), tr('baseUrl.hint'), state.baseUrl, disabled || busy, (value) => patch({ baseUrl: value })),
          field('dib-model', tr('model'), tr('model.hint'), state.model, disabled || busy, (value) => patch({ model: value })),
          field('dib-size', tr('size'), tr('size.hint'), state.size, disabled || busy, (value) => patch({ size: value })),
          field('dib-api-key', tr('apiKey'), state.keyConfigured ? tr('apiKey.set') : tr('apiKey.unset'), state.keyDraft, disabled || busy, (value) => patch({ keyDraft: value }), 'password'),
          h('div', { key: 'footer', className: 'dib-footer' }, [
            h('button', {
              key: 'save',
              className: 'dib-btn',
              type: 'submit',
              disabled: busy || disabled,
            }, state.phase === 'saving' ? tr('saving') : tr('save')),
            h('button', {
              key: 'test',
              className: 'dib-btn dib-btn-secondary',
              type: 'button',
              disabled: busy || disabled,
              onClick: () => {
                void test()
              },
            }, state.phase === 'testing' ? tr('testing') : tr('test')),
            state.status === '' ? null : h('p', { key: 'status', className: statusClass, role: 'status' }, state.status),
          ]),
        ]),
      ])
    }

    /** 两个工具名共用同一个视图。 */
    const TOOL_KEYS = ['image_generate', 'image_edit']

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: MESSAGES.zh, en: MESSAGES.en }), 'image-bridge: dictionaries')

        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-image-bridge'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'image-bridge: styles')

        ctx.slots.inject('tool.call.toolview', function* registerImageViews() {
          for (const key of TOOL_KEYS) {
            yield ctx.slots.register({
              name: 'tool.call.toolview',
              key,
              locale: NS,
              // 声明子插槽才被授权 dispatch 图片画廊。
              children: { 'tool.call.images': { kind: 'single', scope: 'session' } },
            }, ImageResultRow)
          }
        })

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-image-bridge-config',
          order: 120,
          label: () => t('nav'),
          locale: NS,
        }, (props) => h(ConfigPage, { ...props, __ctx: ctx })))
      },
    }
  },
})
