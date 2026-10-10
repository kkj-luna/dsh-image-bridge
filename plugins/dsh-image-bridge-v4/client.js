window.__ModuleLoader__.load({
  id: '@local/image-bridge-v4',
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
     *    （Host 侧 `output.presentationMeta`）取图片引用，再用调用方给的 `loadImage`
     *    把附件画成 `<img>`。
     * 2. 在「设置」里注册一个配置页，形态对齐官方的「设置 → 模型」页：
     *    提供商卡片列表（名称 / 当前所用模型 / 连接状态点 / 编辑按钮）+ 列表底部虚线
     *    「+ 添加模型提供商」按钮；点开后在页内展开编辑面板——名称、接口地址、
     *    API Key、**测试连接**、**获取可用模型**，拉到的模型以可选列表呈现，分别
     *    指定生图模型与改图模型（改图留空表示沿用生图）。
     *
     * 配置分两处存：`providers` / `activeProviderId` 走 `remote.settings`（写进本插件
     * 行的 volatile 配置），每个提供商的 API Key 走 `remote.credentials`（引用名由
     * `provider.id` 派生，Host 端不回传、不写进 profile 的 YAML）。
     *
     * 不导入任何 Harness 客户端包：React 由浏览器模块表提供，控件与样式全部自持，
     * 颜色只用 `--dsw-alias-*` 主题令牌。所有组件都保持全域可执行——宿主对渲染期抛错
     * 的插槽条目会永久弃用，所以任何字段缺失都退化成一行文本。
     */
    /**
     * 诊断回报。
     *
     * 客户端半跑在浏览器里，它在加载或渲染期出的问题 Host 侧完全看不到——只能由
     * 客户端主动回报。这里把关键信息 POST 给本插件的 Host 路由，由它落盘到
     * `$DSH_HOME/dsh-image-bridge-client.log`。
     * 回报本身绝不能引发新问题：全程 try/catch，且不等待结果。
     */
    function report(level, message, detail) {
      try {
        void fetch('/dsh-image-bridge/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: `log-${String(Date.now())}`,
            method: 'log',
            payload: { level, message, detail: detail === undefined ? '' : String(detail) },
          }),
        }).catch(() => {})
      } catch {
        /* 诊断通道自身失败时保持沉默 */
      }
    }

    /*
     * React 解析。
     *
     * 模块表给出的可能是 React 模块本身，也可能是一个命名空间对象（钩子挂在
     * `.default` 上）。按「有没有 useState」判定并取正确的那一个——否则
     * `React.useState` 会是 undefined，组件在首屏第一行就抛错，宿主随即把该
     * 插槽条目永久弃用（页面只剩一个空的占位 div）。
     */
    let reactModule
    try {
      reactModule = require('react')
    } catch (error) {
      report('fatal', 'require("react") 失败', error instanceof Error ? error.stack : String(error))
      throw error
    }

    const React = reactModule !== null && typeof reactModule === 'object' && typeof reactModule.useState !== 'function'
      && reactModule.default !== undefined && reactModule.default !== null && typeof reactModule.default.useState === 'function'
      ? reactModule.default
      : reactModule
    const h = React !== undefined && React !== null && typeof React.createElement === 'function' ? React.createElement : undefined

    /**
     * React 的真实形状。
     *
     * 同时用于两条诊断路径：上报到 Host 日志，以及——万一界面仍然渲染失败——
     * 直接显示在错误边界里，让一张截图就能说明问题。
     */
    const reactShape = JSON.stringify({
      moduleType: typeof reactModule,
      moduleKeys: reactModule !== null && typeof reactModule === 'object' ? Object.keys(reactModule).slice(0, 40) : [],
      moduleCreateElement: typeof reactModule?.createElement,
      moduleUseState: typeof reactModule?.useState,
      moduleComponent: typeof reactModule?.Component,
      defaultType: typeof reactModule?.default,
      defaultUseState: typeof reactModule?.default?.useState,
      picked: React === reactModule ? 'module' : 'default',
      h: typeof h,
    })

    // 把 React 的真实形状回报一次：钩子到底可不可用、要不要走 .default。
    report('info', 'react shape', reactShape)

    /**
     * 自己的错误边界。
     *
     * 宿主对渲染期抛错的插槽条目会永久弃用，界面上只留一个空的 `data-slot-error`
     * 占位——对用户就是「白屏且不知道为什么」。这里兜一层：即使真的出错，也把原因
     * 显示成文字，而不是继续沉默。
     */
    /*
     * 类组件基类。
     *
     * `class X extends React.Component` 是在模块加载期求值的：万一 React 对象不完整，
     * 抛在这里会让整个客户端模块加载失败（连导航项都不会出现）。用一个最小基类兜底，
     * 保证模块永远能加载——最坏情况只是失去错误边界的兜底能力。
     */
    const ComponentBase = typeof React.Component === 'function'
      ? React.Component
      : class { constructor(props) { this.props = props } }

    class SectionBoundary extends ComponentBase {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        report('error', `插槽条目渲染失败：${String(error?.message ?? error)}`, `${String(error?.stack ?? '')} | ${String(info?.componentStack ?? '')}`)
      }

      render() {
        if (this.state.error !== null) {
          return h('div', { className: 'dib-cfg' }, [
            h('p', { key: 'title', className: 'dib-status dib-status-error' }, '生图桥界面渲染失败'),
            h('p', { key: 'detail', className: 'dib-field-hint' }, String(this.state.error?.message ?? this.state.error)),
            h('p', { key: 'shape', className: 'dib-field-hint' }, `react=${reactShape}`),
          ])
        }
        return this.props.children
      }
    }

    /** 把任意失败值整理成一行可读文字。 */
    function messageOf(value) {
      if (value instanceof Error) return value.message
      if (value !== null && typeof value === 'object' && value.error !== undefined) {
        const error = value.error
        if (error !== null && typeof error === 'object' && error.message !== undefined) return String(error.message)
        try {
          return JSON.stringify(error)
        } catch {
          return String(error)
        }
      }
      return String(value)
    }

    /** 文案命名空间。 */
    const NS = 'dsh-image-bridge'
    /** settings 写入的命名空间 = 本插件在 profile patch 里的行 id。 */
    const SETTINGS_NS = 'image-bridge-v4'
    /** 旧配置（单提供商时代）的 API Key 引用名；同时作为新记录的兼容回退。 */
    const API_KEY_REF = 'DSH_IMAGE_BRIDGE_API_KEY'
    /** 每个提供商的凭据引用前缀：keyRef = 前缀 + id 大写、非字母数字转下划线。 */
    const KEY_REF_PREFIX = 'DSH_IMAGE_BRIDGE_KEY_'
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
        'intro': '把外部生图模型接给当前模型使用：先添加模型提供商（测试连接、获取模型），再在下面的「模型」区块里为生图与修图各指定一个模型。',
        'loading': '正在载入当前配置…',
        'unavailable': '配置界面暂时不可用（未能连上 Host 的配置服务）。',
        'loadFailed': '读取配置失败：',
        'empty': '还没有配置模型提供商。',
        'add': '添加模型提供商',
        'edit': '编辑',
        'remove': '删除',
        'removeConfirm': '确认删除',
        'cancel': '取消',
        'legacyTag': '现有配置',
        'legacyProviderName': '默认提供商',
        'test': '测试连接',
        'testShort': '测试',
        'testing': '测试中…',
        'testOk': '连接正常。',
        'testFail': '连接失败。',
        'dot.ok': '最近一次测试连接成功',
        'dot.fail': '最近一次测试连接失败',
        'dot.untested': '尚未测试连接',
        'dot.connected': '已获取到可用模型列表',
        'editorAdd': '添加模型提供商',
        'editorEdit': '编辑模型提供商',
        'keyNote': 'API Key 保存在凭据服务里，不会写进配置文件，也不会回传浏览器。',
        'name': '名称',
        'name.hint': '用于在列表里区分，例如 智谱、OpenAI。',
        'name.placeholder': '例如 智谱',
        'baseUrl': '接口地址',
        'baseUrl.hint': 'OpenAI 兼容地址，例如 https://api.openai.com/v1、https://open.bigmodel.cn/api/paas/v4。',
        'baseUrl.placeholder': 'https://api.openai.com/v1',
        'apiKey': 'API Key',
        'apiKey.set': '已保存密钥；留空表示不修改。',
        'apiKey.unset': '尚未保存密钥。',
        'apiKey.placeholder': '留空表示不修改已保存的密钥',
        'fetchModels': '获取可用模型',
        'fetching': '获取中…',
        'modelsFetched': '已获取模型：',
        'modelsEmpty': '接口没有返回可用模型，请直接填写模型名。',
        'noModelsHint': '没取到模型列表，可点「获取可用模型」，或直接填写模型名。',
        'availableModels': '可用模型',
        'showAll': '显示全部模型',
        'hiddenModels': '已隐藏非生图模型：',
        'close': '关闭',
        'refetchModels': '重新获取可用模型',
        'pickedImage': '当前生图模型',
        'pickedEdit': '当前改图模型',
        'imageModel': '生图模型',
        'imageModel.placeholder': '例如 gpt-image-1',
        'editModel': '改图模型',
        'editModel.placeholder': '留空表示沿用生图模型',
        'manualOption': '手动输入…',
        'noModelsYet': '还没有获取到模型列表：先点「测试连接」或「获取可用模型」，也可以直接填写模型名。',
        'none': '未选择',
        'inheritImage': '沿用生图模型',
        'keyUnavailable': '凭据服务不可用，无法保存 API Key。',
        'needBaseUrl': '请先填写接口地址。',
        'size': '默认尺寸',
        'size.hint': '对所有提供商生效；列表里没有的尺寸选「自定义…」自己填。',
        'size.custom': '自定义…',
        'size.preset.1024x1024': '1024x1024（1:1 默认）',
        'size.preset.1024x1536': '1024x1536（2:3 竖版）',
        'size.preset.1536x1024': '1536x1024（3:2 横版）',
        'size.preset.768x1024': '768x1024（3:4 竖版）',
        'size.preset.1024x768': '1024x768（4:3 横版）',
        'size.preset.512x512': '512x512（1:1 小图）',
        'size.preset.1792x1024': '1792x1024（16:9 横版）',
        'size.preset.1024x1792': '1024x1792（9:16 竖版）',
        'saveSize': '保存尺寸',
        'routes.title': '模型',
        'routes.hint': '生图与修图各有一个主模型和一个备用模型：选项来自所有已获取过模型列表的服务商（按服务商分组）。备用模型在主模型超时或连接失败时自动接管。',
        'routes.none': '先添加并测试连接一个模型提供商。',
        'routes.showAll': '显示全部模型',
        'route.generate.primary': '生图模型',
        'route.generate.fallback': '生图备用模型',
        'route.edit.primary': '修图模型',
        'route.edit.fallback': '修图备用模型',
        'route.unset': '主模型',
        'route.noFallback': '备用模型',
        'route.primaryHint': '工具调用时优先使用。',
        'route.fallbackHint': '主模型超时仍未返回或连接失败，自动改用。',
        'route.manualHint': '手动填写的模型走当前生效服务商',
        'route.noActive': '当前没有生效的服务商',
        'routes.save': '保存模型设置',
        'routes.saved': '模型设置已保存。',
        'fallbackAfterMs': '主模型超时(毫秒)',
        'fallbackAfterMs.hint': '主模型超过这个时间仍未返回响应，或连接失败，就自动改用备用模型；留空表示用默认 15000。',
        'fallbackAfterMs.placeholder': '15000',
        'fallbackInvalid': '主模型超时必须是正整数毫秒数（也可以留空用默认值）。',
        'save': '保存',
        'saving': '保存中…',
        'saved': '已保存。',
        'savedKey': '密钥已保存。',
        'removed': '已删除该提供商。',
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
        'intro': 'Bridges an external image model into the current model: add a provider (test the connection, fetch its models), then pick the models for generation and editing in the "Models" block below.',
        'loading': 'Loading current settings…',
        'unavailable': 'Configuration is unavailable (the Host configuration service is not reachable).',
        'loadFailed': 'Reading the configuration failed: ',
        'empty': 'No model provider configured yet.',
        'add': 'Add model provider',
        'edit': 'Edit',
        'remove': 'Delete',
        'removeConfirm': 'Confirm delete',
        'cancel': 'Cancel',
        'legacyTag': 'Existing config',
        'legacyProviderName': 'Default provider',
        'test': 'Test connection',
        'testShort': 'Test',
        'testing': 'Testing…',
        'testOk': 'Connection is fine.',
        'testFail': 'Connection failed.',
        'dot.ok': 'The last connection test succeeded',
        'dot.fail': 'The last connection test failed',
        'dot.untested': 'Not tested yet',
        'dot.connected': 'Model list already fetched',
        'editorAdd': 'Add model provider',
        'editorEdit': 'Edit model provider',
        'keyNote': 'The API key lives in the credential service: it is never written to the config file and never sent back to the browser.',
        'name': 'Name',
        'name.hint': 'Shown in the list, for example OpenAI or Zhipu.',
        'name.placeholder': 'e.g. OpenAI',
        'baseUrl': 'API base URL',
        'baseUrl.hint': 'An OpenAI-compatible base URL, e.g. https://api.openai.com/v1.',
        'baseUrl.placeholder': 'https://api.openai.com/v1',
        'apiKey': 'API key',
        'apiKey.set': 'A key is stored; leave blank to keep it.',
        'apiKey.unset': 'No key stored yet.',
        'apiKey.placeholder': 'Leave blank to keep the stored key',
        'fetchModels': 'Fetch models',
        'fetching': 'Fetching…',
        'modelsFetched': 'Models fetched:',
        'modelsEmpty': 'The endpoint returned no models; type a model name instead.',
        'noModelsHint': 'No model list was returned; use "Fetch models", or type a model name.',
        'availableModels': 'Available models',
        'showAll': 'Show all models',
        'hiddenModels': 'Hidden non-image models:',
        'close': 'Close',
        'refetchModels': 'Refetch available models',
        'pickedImage': 'Current image model',
        'pickedEdit': 'Current edit model',
        'imageModel': 'Image model',
        'imageModel.placeholder': 'e.g. gpt-image-1',
        'editModel': 'Edit model',
        'editModel.placeholder': 'Blank reuses the image model',
        'manualOption': 'Type a model name…',
        'noModelsYet': 'No model list yet: run "Test connection" or "Fetch models" first — you can also type a model name.',
        'none': 'not selected',
        'inheritImage': 'reuse the image model',
        'keyUnavailable': 'The credential service is unavailable, so the API key cannot be stored.',
        'needBaseUrl': 'Fill in the API base URL first.',
        'size': 'Default size',
        'size.hint': 'Applies to every provider; pick "Custom…" to type a size that is not listed.',
        'size.custom': 'Custom…',
        'size.preset.1024x1024': '1024x1024 (1:1, default)',
        'size.preset.1024x1536': '1024x1536 (2:3 portrait)',
        'size.preset.1536x1024': '1536x1024 (3:2 landscape)',
        'size.preset.768x1024': '768x1024 (3:4 portrait)',
        'size.preset.1024x768': '1024x768 (4:3 landscape)',
        'size.preset.512x512': '512x512 (1:1 small)',
        'size.preset.1792x1024': '1792x1024 (16:9 wide)',
        'size.preset.1024x1792': '1024x1792 (9:16 tall)',
        'saveSize': 'Save size',
        'routes.title': 'Models',
        'routes.hint': 'Generation and editing each have a primary and a fallback model. Options come from every provider whose model list has been fetched, grouped by provider; the fallback takes over when the primary times out or fails to connect.',
        'routes.none': 'Add a model provider and test the connection first.',
        'routes.showAll': 'Show all models',
        'route.generate.primary': 'Image model',
        'route.generate.fallback': 'Image fallback model',
        'route.edit.primary': 'Edit model',
        'route.edit.fallback': 'Edit fallback model',
        'route.unset': 'Primary model',
        'route.noFallback': 'Fallback model',
        'route.primaryHint': 'Used first when the tools call the API.',
        'route.fallbackHint': 'Used when the primary times out or fails to connect.',
        'route.manualHint': 'A manually typed model goes through the active provider',
        'route.noActive': 'there is no active provider right now',
        'routes.save': 'Save model settings',
        'routes.saved': 'Model settings saved.',
        'fallbackAfterMs': 'Primary model timeout (ms)',
        'fallbackAfterMs.hint': 'Switch to the fallback model when the primary takes longer than this or fails to connect; blank means the default 15000.',
        'fallbackAfterMs.placeholder': '15000',
        'fallbackInvalid': 'The timeout must be a positive whole number of milliseconds (or blank for the default).',
        'save': 'Save',
        'saving': 'Saving…',
        'saved': 'Saved.',
        'savedKey': 'Key stored.',
        'removed': 'Provider deleted.',
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
      '.dib-gallery{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}',
      '.dib-image{max-width:100%;max-height:320px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l2);display:block}',
      /* 设置页骨架 */
      '.dib-cfg{display:flex;flex-direction:column;max-width:640px}',
      '.dib-cfg-intro{margin:0 0 4px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.dib-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
      '.dib-field+.dib-field{border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.dib-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dib-input{height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dib-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.dib-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dib-input-narrow{width:150px}',
      '.dib-select{width:100%;max-width:320px;padding-right:8px;cursor:pointer}',
      '.dib-select:disabled{cursor:default;background:var(--dsw-alias-bg-layer-2)}',
      /* 分组标题更粗更大（font-size 未必被认，所以文本层还加了破折号与大写） */
      '.dib-select optgroup{font-weight:700;font-style:normal;color:var(--dsw-alias-label-primary)}',
      '.dib-select option{font-weight:400}',
      '.dib-field-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
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
      /* 提供商卡片列表 */
      '.dib-list{display:flex;flex-direction:column;gap:8px;margin:12px 0 0;padding:0;list-style:none}',
      '.dib-card{border:0.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));border-radius:var(--dsw-radius-xl);display:flex;flex-direction:column;gap:10px;padding:12px 14px}',
      '.dib-card-head{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dib-card-name{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dib-card-tag{flex:none;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);padding:1px 6px;font-size:11px;line-height:16px;white-space:nowrap}',
      '.dib-card-tag-on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dib-card-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}',
      '.dib-dot{flex:none;display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.dib-dot-ok{background:var(--dsw-alias-state-success-primary)}',
      '.dib-dot-fail{background:var(--dsw-alias-state-error-primary)}',
      /* 卡片内的小按钮 */
      '.dib-mini{appearance:none;flex:none;height:26px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dib-mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
      '.dib-mini:disabled{opacity:0.4;cursor:default}',
      '.dib-mini:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dib-mini-on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dib-mini-danger{color:var(--dsw-alias-state-error-primary)}',
      /* 虚线添加入口 */
      '.dib-add-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;height:44px;margin-top:12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}',
      '.dib-add-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dib-add-btn:disabled{opacity:0.4;cursor:default}',
      '.dib-add-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      /* 编辑浮层：遮罩 + 居中面板卡片
       *
       * 层级取 1200：宿主自己的浮层分别是 1000（Modal / 图片灯箱）、1100（Toast、
       * 挂了 portal 的 Tooltip）、100/101（菜单），1200 稳压它们一头，又不会离谱到
       * 盖住浏览器原生 UI。遮罩与卡片样式对着宿主 Modal 的令牌抄，深浅色都跟着主题走。
       */
      '.dib-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dib-overlay-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur,none)}',
      '.dib-editor{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;gap:0;width:min(560px,100%);max-height:100%;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel,var(--dsw-radius-lg));background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}',
      '.dib-editor-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:20px 14px 12px 24px}',
      '.dib-editor-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.dib-editor-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}',
      '.dib-editor-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dib-editor-close:disabled{opacity:0.4;cursor:default}',
      '.dib-editor-close:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dib-editor-body{display:flex;flex-direction:column;gap:12px;min-height:0;overflow-y:auto;padding:0 24px}',
      '.dib-editor-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dib-editor-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dib-editor-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:16px 24px 20px}',
      '.dib-editor-footer .dib-status{flex:1 1 auto;text-align:right}',
      '.dib-picker{display:flex;flex-direction:column;gap:6px}',
      '.dib-picker-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.dib-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dib-toggle input{cursor:pointer}',
      '.dib-model-list{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto;margin:0;padding:0;list-style:none}',
      '.dib-model-row{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:var(--dsw-radius-md)}',
      '.dib-model-row:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
      '.dib-model-id{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      /* 主页的模型区块 */
      '.dib-routes{display:flex;flex-direction:column;gap:4px;margin-top:16px;padding-top:16px;border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.dib-section-title{margin:0 0 4px;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}',
      /* 主用与备用是紧邻的一对：对内几乎不留缝、也不画分隔线，对与对之间照旧留出段落间距。 */
      '.dib-route-pair{display:flex;flex-direction:column}',
      '.dib-route-pair+.dib-route-pair{margin-top:14px;padding-top:6px;border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.dib-routes .dib-field{padding:4px 0}',
      '.dib-route-pair .dib-field+.dib-field{border-top:none}',
      /* 备用那行没有可见标签，上内边距一并收掉，主用的说明小字与它紧邻。 */
      '.dib-routes .dib-route-fallback{padding-top:0}',
      '.dib-toggle-row{display:flex;align-items:center;gap:8px;padding:8px 0}',
      /* 全局默认值 */
      '.dib-defaults{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:16px;border-top:0.5px solid var(--dsw-alias-border-l2)}',
      '.dib-defaults .dib-field-hint{flex:1 1 100%}',
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

    /**
     * 一张已生成图片。
     *
     * 不走宿主的 `tool.call.images` 画廊（那个子插槽已被内置 read_image 卡片声明），
     * 改用调用方传入的 `loadImage(attachment)`：它返回可直接放进 `src` 的地址，
     * 并带有可选的同步 `peek` 缓存。加载失败只影响这一张，不会波及卡片。
     */
    function GeneratedImage(props) {
      const { attachment, loadImage } = props
      const peek = () => {
        try {
          const cached = typeof loadImage.peek === 'function' ? loadImage.peek(attachment) : undefined
          return cached === undefined ? null : cached
        } catch {
          return null
        }
      }
      const [url, setUrl] = React.useState(peek)
      const [failed, setFailed] = React.useState(false)

      React.useEffect(() => {
        let live = true
        setFailed(false)
        const cached = peek()
        if (cached !== null) {
          setUrl(cached)
          return () => { live = false }
        }
        Promise.resolve()
          .then(() => loadImage(attachment))
          .then((next) => { if (live) setUrl(next) })
          .catch(() => { if (live) setFailed(true) })
        return () => { live = false }
      }, [attachment, loadImage])

      if (failed) return h('div', { className: 'dib-hint' }, '图片加载失败')
      if (url === null || url === undefined) return h('div', { className: 'dib-pending' }, '图片加载中…')
      return h('img', {
        className: 'dib-image',
        src: url,
        alt: typeof attachment?.name === 'string' ? attachment.name : 'generated image',
        loading: 'lazy',
      })
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
        if (typeof props.loadImage === 'function') {
          rows.push(h('div', { key: 'gallery', className: 'dib-gallery' }, images.map((image, index) => (
            h(GeneratedImage, { key: String(index), attachment: image.attachment, loadImage: props.loadImage })
          ))))
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
    /* 基础设施                                                             */
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
     * 关键点：`ctx.get('remote')` 返回的对象受 Cordis 的属性访问守卫保护——
     * 对**未在 `inject` 里声明的服务**做属性访问会抛
     * `cannot get property "remote.settings" without inject`。
     * 所以这里一律走"查找"而不是"取属性"：
     *   ① 服务本身就以 `remote.<ns>` 为键注册，`ctx.get()` 不触发守卫；
     *   ② 退一步调用网关自己的 `get()` 方法（方法调用同样不是属性访问）；
     *   ③ 最后才试属性访问，并接受它可能被守卫拒绝。
     * 三条路都失败时返回 undefined，由调用方降级成一行提示。
     */
    function remoteNamespace(ctx, name) {
      const tried = []
      try {
        const direct = ctx.get(`remote.${name}`)
        if (direct !== undefined && direct !== null) {
          report('info', '远程命名空间解析', `${name} → ctx.get("remote.${name}")`)
          return direct
        }
        tried.push('get:undefined')
      } catch (error) {
        tried.push(`get:throw(${String(error?.message ?? error)})`)
      }
      try {
        const gateway = ctx.get('remote')
        if (gateway !== undefined && gateway !== null && typeof gateway.get === 'function') {
          const nested = gateway.get(name)
          if (nested !== undefined && nested !== null) {
            report('info', '远程命名空间解析', `${name} → ctx.get("remote").get("${name}")`)
            return nested
          }
          tried.push('gateway.get:undefined')
        } else {
          tried.push('gateway:no-get')
        }
      } catch (error) {
        tried.push(`gateway.get:throw(${String(error?.message ?? error)})`)
      }
      try {
        const property = ctx.remote
        if (property !== undefined && property !== null && property[name] !== undefined) {
          report('info', '远程命名空间解析', `${name} → ctx.remote.${name}`)
          return property[name]
        }
        tried.push('property:undefined')
      } catch (error) {
        tried.push(`property:throw(${String(error?.message ?? error)})`)
      }
      report('warn', '远程命名空间解析失败', `${name} tried=${tried.join(' | ')}`)
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

    /* ------------------------------------------------------------------ */
    /* 提供商记录                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * 生成 provider.id：小写、非 [a-z0-9] 折叠成 '-'。
     *
     * 中文名会折叠成空串，调用方再用接口地址的主机名兜底。
     */
    function slugify(value) {
      return String(value === null || value === undefined ? '' : value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 40)
    }

    /** 接口地址里的主机名，作为 id 的兜底来源。 */
    function hostSlugOf(baseUrl) {
      const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/iu.exec(String(baseUrl === null || baseUrl === undefined ? '' : baseUrl))
      if (match === null) return ''
      return slugify(match[1].replace(/^[^@]*@/u, '').replace(/:[0-9]+$/u, ''))
    }

    /** provider.id → 凭据引用名：前缀 + id 大写、非字母数字转下划线（与 Host 半同规则）。 */
    function keyRefOf(id) {
      return `${KEY_REF_PREFIX}${String(id === null || id === undefined ? '' : id).toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`
    }

    /** 凭据引用的语法：与 Host 半的守卫一致，形状不对的引用一律不能发给 Host。 */
    const KEY_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

    /**
     * 校验一个凭据引用名；不合法就按"没有引用"处理并回报一条 warn。
     *
     * 非法值（例如手改 profile 塞进来的）发给 Host 只会被它忽略，界面却会一直显示
     * "密钥未配置"、保存也不会自愈——所以这里就地把它归零，让两侧行为一致。
     * 空值不算异常，静默返回空串；合法值原样返回。
     */
    function safeKeyRef(value) {
      if (typeof value !== 'string' || value === '') return ''
      if (KEY_REF_PATTERN.test(value)) return value
      report('warn', '凭据引用名不合法，按未配置处理', JSON.stringify({
        length: value.length,
        // 只记形状，不把整条值抄进日志（引用名不该承载密钥，但手改的配置里什么都可能有）。
        sample: value.slice(0, 6).replace(/[^A-Za-z0-9_]/gu, '?'),
      }))
      return ''
    }

    /** 列表内唯一的 id：重复时追加 -2、-3…（凭据引用由 id 派生，撞了就会串密钥）。 */
    function uniqueId(seed, taken) {
      const base = seed === '' ? 'provider' : seed
      if (!taken.includes(base)) return base
      let index = 2
      while (taken.includes(`${base}-${index}`)) index += 1
      return `${base}-${index}`
    }

    /** 把配置里的任意形状归一成卡片记录；id 缺失时由 label / baseUrl 派生。 */
    function normalizeProvider(raw, taken) {
      const value = raw !== null && typeof raw === 'object' ? raw : {}
      const label = typeof value.label === 'string' ? value.label.trim() : ''
      const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : ''
      const declaredId = typeof value.id === 'string' ? slugify(value.id) : ''
      const seed = declaredId !== '' ? declaredId : slugify(label) !== '' ? slugify(label) : hostSlugOf(baseUrl)
      const id = uniqueId(seed, taken)
      taken.push(id)
      const declaredRef = safeKeyRef(value.keyRef)
      const keyRef = declaredRef !== '' ? declaredRef : keyRefOf(id)
      const models = Array.isArray(value.models) ? value.models.filter((model) => typeof model === 'string' && model !== '') : []
      const imageModel = typeof value.imageModel === 'string' ? value.imageModel : ''
      const editModel = typeof value.editModel === 'string' ? value.editModel : ''
      return { id, label: label === '' ? id : label, baseUrl, keyRef, models, imageModel, editModel }
    }

    /**
     * 旧配置合成一张卡片。
     *
     * 单提供商时代只有 baseUrl/model/editModel，它们仍然是 Host 的回退来源。
     * 升级后如果这里不显示出来，用户会以为自己的配置丢了——所以没有 providers 时
     * 把它合成一张「现有配置」卡片，且沿用旧的凭据引用名，密钥不会失联。
     */
    function legacyProviderOf(value) {
      const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : ''
      const model = typeof value.model === 'string' ? value.model : ''
      const editModel = typeof value.editModel === 'string' ? value.editModel : ''
      if (baseUrl === '' && model === '' && editModel === '') return null
      return { id: 'default', label: '', baseUrl, keyRef: API_KEY_REF, models: [], imageModel: model, editModel, legacy: true }
    }

    /** 写回配置的精简记录：只保留契约里的 7 个字段（legacy 之类的界面状态不落盘）。 */
    function plainProvider(provider) {
      return {
        id: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        keyRef: provider.keyRef,
        models: Array.isArray(provider.models) ? provider.models : [],
        imageModel: provider.imageModel,
        editModel: provider.editModel,
      }
    }

    /** 远程调用统一返回 {ok,value} / {ok:false,error} 信封；出错给文案，成功给 null。 */
    function failureOf(value) {
      if (value === null || typeof value !== 'object') return null
      if (value.ok === true) return null
      if (value.ok === false) return messageOf(value)
      return null
    }

    /** settings.describe() 的两种形状：{writable,namespaces:[…]} 与行数组。 */
    function namespacesOf(described) {
      const value = described !== null && typeof described === 'object' && 'value' in described ? described.value : described
      if (Array.isArray(value)) return value
      if (value !== null && typeof value === 'object' && Array.isArray(value.namespaces)) return value.namespaces
      return []
    }

    /** 同上，取可写标记；读不到时按可写处理，让真正的错误从写入路径暴露。 */
    function writableOf(described) {
      const value = described !== null && typeof described === 'object' && 'value' in described ? described.value : described
      return !(value !== null && typeof value === 'object' && value.writable === false)
    }

    /** models RPC 的返回：callHost 已拆过一层信封，这里再容忍一次没拆的。 */
    function modelsOfResult(result) {
      let value = result
      if (value !== null && typeof value === 'object' && value.ok === true && 'value' in value) value = value.value
      const list = Array.isArray(value)
        ? value
        : value !== null && typeof value === 'object' && Array.isArray(value.models) ? value.models : []
      return list.filter((model) => typeof model === 'string' && model !== '')
    }

    /**
     * test 返回体里的模型列表；没有这个字段时返回 null。
     *
     * 与「返回了空数组」区分开：前者说明服务商这一侧根本没给列表（别把用户已经拉到
     * 的列表清空），后者说明确实一个模型都没有。
     */
    function modelsFieldOf(value) {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.models)) return null
      return value.models.filter((model) => typeof model === 'string' && model !== '')
    }

    /**
     * test RPC 的返回：{ok,message,models} 或 {ok:true,value:{ok,message,models}} 都要能读。
     *
     * `models` 是 host-core 新加的字段：测试连接成功时顺带把服务商的模型列表带回来，
     * 用户就不必再点一次「获取可用模型」。取不到时为 null（见 modelsFieldOf）。
     */
    function testOutcomeOf(result) {
      let value = result
      if (value !== null && typeof value === 'object' && value.ok === true && 'value' in value) value = value.value
      if (value !== null && typeof value === 'object') {
        return {
          ok: value.ok !== false,
          message: typeof value.message === 'string' ? value.message : '',
          models: modelsFieldOf(value),
        }
      }
      return { ok: true, message: typeof value === 'string' ? value : '', models: null }
    }

    /*
     * 生图模型的判定。
     *
     * 用户的 Key 实测有 176 个模型，绝大多数是语言/语音/向量模型；把整张表铺出来
     * 等于没有列表。这里只挑生图模型，规则刻意做得**窄**：
     *
     *   ① 按 `[^a-z0-9]+` 切成 token，再逐 token 比对——绝不做整名子串匹配。
     *      `qwen-mt-uni`、`qwen3.7-text-embedding-flash`、`glm-5.3` 这类名字里同样
     *      有 qwen/text/uni/glm 这些词，宽松的正则会成片误判。
     *   ② token 里含 `image` 即判为生图：image / imagen / imagegen / text2image /
     *      z-image / qwen-image-3.0 / wan2.7-image 全覆盖。
     *   ③ 再认一组生图专有词（精确命中，或带版本号前缀）：t2i、i2i、flux、kolors、
     *      dall(e)、seedream、cogview、diffusion、sdxl、wanx、midjourney、imagen。
     *
     * 语言模型名里不会出现 `image` 这个词，因此 ①+② 已足够；③ 只是把其它家系的
     * 生图模型（名字里不含 image）也放进来。
     */
    const IMAGE_MODEL_TOKENS = ['t2i', 'i2i', 'flux', 'kolors', 'dall', 'dalle', 'seedream', 'cogview', 'diffusion', 'sdxl', 'sd3', 'wanx', 'midjourney', 'imagen']
    const IMAGE_MODEL_STEMS = ['flux', 'kolors', 'dall', 'seedream', 'cogview', 'sdxl', 'wanx', 'midjourney', 'imagen']

    /** 这个模型名看起来是不是生图模型（见上面的规则说明）。 */
    function isImageModel(modelId) {
      const text = String(modelId === null || modelId === undefined ? '' : modelId).toLowerCase()
      if (text === '') return false
      for (const token of text.split(/[^a-z0-9]+/gu)) {
        if (token === '') continue
        if (token.includes('image')) return true
        if (IMAGE_MODEL_TOKENS.includes(token)) return true
        if (IMAGE_MODEL_STEMS.some((stem) => token.startsWith(stem))) return true
      }
      return false
    }

    /** 去重后的模型列表：同一行重复出现会让 React 的 key 冲突。 */
    function uniqueModels(list) {
      const seen = []
      for (const model of list) {
        if (typeof model === 'string' && model !== '' && !seen.includes(model)) seen.push(model)
      }
      return seen
    }

    /**
     * 卡片的连接状态灯。
     *
     * - `fail`：**本次会话**里测试/获取失败过（只记在内存里，不写进配置）；
     * - `ok`：本次会话测过且成功，或者这家 provider **已经保存过模型列表**
     *   （`models` 非空 = 曾经成功拉到过），所以重新载入页面之后绿灯依然成立；
     * - `idle`：从未成功、也没测过——灰灯。
     */
    function providerSignalOf(provider, testState) {
      const tested = testState !== null && typeof testState === 'object' ? testState[provider?.id] : undefined
      if (tested === 'fail') return 'fail'
      if (tested === 'ok') return 'ok'
      return Array.isArray(provider?.models) && provider.models.length > 0 ? 'ok' : 'idle'
    }

    /**
     * 分组标题（optgroup label）。
     *
     * 原生 select 对 optgroup 的样式支持有限（font-weight 多数浏览器认、font-size 未必），
     * 只靠 CSS 不足以让人一眼分清「这是服务商、不是模型」——英文服务商名（`other`）和模型名
     * （`gemini-3.1-flash-image`）在界面上几乎一样。所以除了 CSS，再做一个**文本层面的标记**：
     * 名字两侧加破折号包裹，ASCII 字母整体大写（中文名不受影响）。
     *
     * 只动分组标题，**模型名一个字都不改写**（它们是真实 id）。
     */
    function groupLabelOf(name) {
      const text = typeof name === 'string' ? name.trim() : ''
      if (text === '') return ''
      return `— ${text.replace(/[a-z]+/gu, (part) => part.toUpperCase())} —`
    }

    /**
     * 「手动输入…」在下拉里的取值。
     *
     * 用一个不可能与模型名混淆的保留值：它只活在下拉里，永远不会被写进配置——选中它只是
     * 把文本框露出来。
     */
    const MANUAL_MODEL_VALUE = '__dib_manual__'

    /** 主模型超时的默认值（毫秒），与 Host 侧 Config 的默认值一致。 */
    const DEFAULT_FALLBACK_MS = 15000

    /**
     * 默认尺寸的常用预设。
     *
     * 比例只写进**界面文案**（词典键 `size.preset.<值>`），不塞进 option 的 value——value
     * 必须是能直接发给服务商的尺寸字符串。当前值不在这个列表里时自动进入自定义模式并
     * 回显原值，绝不显示空白、也绝不改写。
     */
    const SIZE_PRESETS = ['1024x1024', '1024x1536', '1536x1024', '768x1024', '1024x768', '512x512', '1792x1024', '1024x1792']
    /** 尺寸的默认值：配置里没写时按它显示（也是 Host 侧 Config 的默认值）。 */
    const DEFAULT_SIZE = '1024x1024'
    /** 「自定义…」在尺寸下拉里的保留取值。 */
    const CUSTOM_SIZE_VALUE = '__dib_custom_size__'

    /** 四个模型槽位。`modelRoutes` 就是按这个结构写进配置的。 */
    const ROUTE_IDS = ['generate.primary', 'generate.fallback', 'edit.primary', 'edit.fallback']

    /** 下拉里「服务商 + 模型」的合成取值：同一模型名可能出现在两家服务商上。 */
    function routeValueOf(providerId, model) {
      return providerId === '' || model === '' ? '' : `${providerId}::${model}`
    }

    /** 拆开合成取值；形状不对时返回空，等价于「未设置」。 */
    function splitRouteValue(value) {
      const text = typeof value === 'string' ? value : ''
      const at = text.indexOf('::')
      if (at <= 0) return { providerId: '', model: '' }
      return { providerId: text.slice(0, at), model: text.slice(at + 2) }
    }

    /** 一个槽位的记录：从配置里读到的任意形状都归一成同一套字段。 */
    function normalizeRouteItem(raw) {
      const value = raw !== null && typeof raw === 'object' ? raw : {}
      return {
        providerId: typeof value.providerId === 'string' ? value.providerId : '',
        model: typeof value.model === 'string' ? value.model : '',
        manual: false,
        manualText: '',
      }
    }

    /** 从配置里读四个槽位。 */
    function routesOf(value) {
      const source = value !== null && typeof value === 'object' && value.modelRoutes !== null && typeof value.modelRoutes === 'object' ? value.modelRoutes : {}
      const routes = {}
      for (const id of ROUTE_IDS) {
        const [role, slot] = id.split('.')
        const branch = source[role] !== null && typeof source[role] === 'object' ? source[role] : {}
        routes[id] = normalizeRouteItem(branch[slot])
      }
      return routes
    }

    /** 超时输入框里的初始文本：读不到或不是正整数就用默认值。 */
    function fallbackDraftOf(value) {
      const raw = value !== null && typeof value === 'object' ? value.fallbackAfterMs : undefined
      return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? String(raw) : String(DEFAULT_FALLBACK_MS)
    }

    /** 校验超时输入：空串用默认值；非法返回 undefined（调用方据此拒绝保存）。 */
    function parseFallbackMs(draft) {
      const text = typeof draft === 'string' ? draft.trim() : ''
      if (text === '') return DEFAULT_FALLBACK_MS
      if (!/^[0-9]+$/u.test(text)) return undefined
      const value = Number(text)
      return Number.isInteger(value) && value > 0 ? value : undefined
    }

    /**
     * 把四个槽位的界面状态折算成配置里的 `modelRoutes`。
     *
     * 手动输入的槽位只记了模型名，服务商取**当前生效的那一家**——界面旁边也写明了这一点，
     * 免得用户以为手填的名字会自己找服务商。
     */
    function modelRoutesOf(routes, activeProviderId) {
      const source = routes !== null && typeof routes === 'object' ? routes : {}
      const item = (id) => {
        const route = source[id] !== null && typeof source[id] === 'object' ? source[id] : {}
        if (route.manual === true) {
          const model = typeof route.manualText === 'string' ? route.manualText.trim() : ''
          return model === '' ? { providerId: '', model: '' } : { providerId: activeProviderId, model }
        }
        return {
          providerId: typeof route.providerId === 'string' ? route.providerId : '',
          model: typeof route.model === 'string' ? route.model : '',
        }
      }
      return {
        generate: { primary: item('generate.primary'), fallback: item('generate.fallback') },
        edit: { primary: item('edit.primary'), fallback: item('edit.fallback') },
      }
    }

    /** 状态文案的样式类。 */
    function statusClassOf(kind) {
      return kind === 'ok' ? 'dib-status dib-status-ok' : kind === 'error' ? 'dib-status dib-status-error' : 'dib-status dib-status-info'
    }

    /**
     * 一个受控字段行。
     *
     * `options`：`type`（默认 text）、`placeholder`、`autoFocus`。所有可见文案都由
     * 调用方从词典里取，这里只负责结构。
     */
    function field(id, label, hint, value, disabled, onChange, options) {
      const opts = options !== null && options !== undefined ? options : {}
      return h('div', { className: 'dib-field', key: id }, [
        h('label', { key: 'label', className: 'dib-label', htmlFor: id }, label),
        h('input', {
          key: 'input',
          id,
          className: 'dib-input',
          type: typeof opts.type === 'string' ? opts.type : 'text',
          placeholder: typeof opts.placeholder === 'string' ? opts.placeholder : '',
          value,
          disabled,
          spellCheck: false,
          autoComplete: 'off',
          autoFocus: opts.autoFocus === true,
          'aria-describedby': `${id}-hint`,
          onChange: (event) => onChange(event.target.value),
        }),
        h('p', { key: 'hint', id: `${id}-hint`, className: 'dib-field-hint' }, hint),
      ])
    }

    /* ------------------------------------------------------------------ */
    /* 提供商编辑面板                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * 提供商编辑浮层。
     *
     * 固定定位的遮罩 + 居中面板卡片：标题在左、关闭在右，底部取消/保存；点遮罩或按
     * Esc 也能关。不依赖宿主的基础组件包，所以没有 portal 可用来把它挂到 body 上——
     * 这里就用 `position:fixed` 就地铺满视口，层级取 1200 压过宿主的浮层（Modal /
     * 灯箱 1000、Toast 与挂了 portal 的 Tooltip 1100、菜单 100）。遮罩与卡片用的是
     * 宿主 Modal 那一套主题令牌，深浅色都跟着主题走。
     *
     * 它是**额外的**一层：卡片列表与「＋ 添加模型提供商」始终在原地，开浮层不会把
     * 设置页那棵树卸载重建，也就不存在 hook 顺序问题；浮层自己则在打开时挂载、
     * 关闭时卸载。
     *
     * 这里只负责**服务商本身**：名称、接口地址、API Key、测试连接、获取可用模型。
     * 「用哪个模型」已经搬到设置页主页的模型区块（`modelRoutes`），浮层不再持有那份
     * 状态——测试连接/获取模型拿到的列表在这里只作展示：让用户确认 Key 能用、看到这
     * 一家有哪些模型，顺带标出哪些正被主页选为生图/修图模型。
     *
     * `initial` 是打开时带进来的记录（也是进程外验证的注入点）：运行时的提供商记录里
     * 永远不含 API Key，`keyDraft` 只可能来自用户在输入框里的输入。
     */
    function ProviderEditor(props) {
      const tr = translate(props.t)
      const initial = props.initial !== null && props.initial !== undefined && typeof props.initial === 'object' ? props.initial : {}
      const locked = props.disabled === true || props.busy === true
      const [state, setState] = React.useState({
        label: typeof initial.label === 'string' ? initial.label : '',
        baseUrl: typeof initial.baseUrl === 'string' ? initial.baseUrl : '',
        models: uniqueModels(Array.isArray(initial.models) ? initial.models : []),
        keyDraft: typeof initial.keyDraft === 'string' ? initial.keyDraft : '',
        testState: typeof initial.testState === 'string' ? initial.testState : 'untested',
        // 「显示全部模型」：默认只列生图模型，打开后连语言模型一起列出来。
        showAll: initial.showAll === true,
        phase: 'idle',
        status: '',
        statusKind: 'info',
      })
      const patch = React.useCallback((next) => setState((current) => ({ ...current, ...next })), [])
      const busy = state.phase !== 'idle'

      /**
       * 关掉浮层：关闭按钮 / 取消 / 遮罩 / Esc 四条路都走这里。
       *
       * 刻意**不**看 `disabled`（配置行不可写）也不看 `busy`：关闭不是写操作，而一个
       * 关不掉的浮层会把整个设置页挡住——宁可让用户关掉，也不要让他被困在里面。
       */
      const close = React.useCallback(() => {
        props.onCancel()
      }, [props])

      /*
       * Esc 关闭。
       *
       * 用 document 上的监听而不是给浮层加 tabIndex：焦点可能还在输入框里，键盘事件
       * 不保证冒泡到浮层节点。effect 里任何一步失败都只是失去 Esc（还有关闭/取消/
       * 遮罩三条路），绝不能让监听把自己拖崩。
       */
      React.useEffect(() => {
        try {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onKeyDown = (event) => {
            if (event !== null && typeof event === 'object' && event.key === 'Escape') close()
          }
          document.addEventListener('keydown', onKeyDown)
          return () => {
            try {
              document.removeEventListener('keydown', onKeyDown)
            } catch {
              /* 卸载期失败无所谓 */
            }
          }
        } catch {
          return undefined
        }
      }, [close])

      /*
       * 这条记录自己的凭据引用名（形状校验见 safeKeyRef）。
       *
       * 必须随 test / models 一起发给 Host：用户点开的可能是**不是当前生效**的那张卡片，
       * 此时输入框是空的，只能靠 keyRef 让 Host 找到这张卡片自己的密钥——Host 的解析
       * 顺序是 payload.apiKey → payload.keyRef → 当前生效服务商。
       * 空 keyRef 表示**这张卡片还没有已保存的密钥**：Host 连请求都不发，直接返回
       * "没有可用的 API Key，请先填写密钥并保存"，**绝不会**沿用其他服务商的凭据。
       */
      const declaredKeyRef = typeof initial.keyRef === 'string' ? initial.keyRef : ''

      /**
       * 测试连接：结果同时写进面板状态与 Host 日志（绝不记录密钥本身）。
       *
       * 成功时 Host 会把该服务商的模型列表一起带回来（`value.models`），这里直接采用
       * ——用户点一次「测试连接」就能看到可选模型，不用再点一次「获取可用模型」。
       * 返回体里没有 models 字段（服务商不提供列表）时保留已有列表，不要把它清空。
       */
      const test = React.useCallback(async () => {
        patch({ phase: 'testing', status: '', statusKind: 'info' })
        try {
          const keyRef = safeKeyRef(declaredKeyRef)
          const result = await callHost('test', { baseUrl: state.baseUrl, apiKey: state.keyDraft, keyRef })
          const outcome = testOutcomeOf(result)
          const returned = outcome.models
          const adopted = returned !== null && returned.length > 0 ? uniqueModels(returned) : null
          report(outcome.ok ? 'info' : 'warn', '测试连接结果', JSON.stringify({
            baseUrl: state.baseUrl,
            keyRef,
            ok: outcome.ok,
            message: outcome.message,
            // 顺手记下返回的模型规模与其中判为生图的数量，便于对着真实 /models 核对筛选规则。
            returnedModels: returned === null ? null : returned.length,
            imageModels: returned === null ? null : uniqueModels(returned).filter(isImageModel).length,
            adoptedModels: adopted === null ? null : adopted.length,
            keyProvided: state.keyDraft.length > 0,
            keyLength: state.keyDraft.length,
          }))
          const message = outcome.message === '' ? (outcome.ok ? tr('testOk') : tr('testFail')) : outcome.message
          /*
           * 成功但没带模型列表（服务商不提供 /models、返回体不是合法 JSON、或 404 软提示）
           * 时，如果手上一个模型都没有，就明确告诉用户还有哪两条路可走。
           */
          const hint = adopted !== null
            ? `${tr('modelsFetched')} ${adopted.length}`
            : outcome.ok && state.models.length === 0 ? tr('noModelsHint') : ''
          patch({
            phase: 'idle',
            testState: outcome.ok ? 'ok' : 'fail',
            ...(adopted === null ? {} : { models: adopted }),
            status: hint === '' ? message : `${message} ${hint}`,
            statusKind: outcome.ok ? 'ok' : 'error',
          })
        } catch (error) {
          report('error', '测试连接失败', error instanceof Error ? `${error.message} | ${error.stack}` : String(error))
          patch({ phase: 'idle', testState: 'fail', status: messageOf(error), statusKind: 'error' })
        }
      }, [state.baseUrl, state.keyDraft, declaredKeyRef, patch, tr])

      /** 取可用模型：GET {baseUrl}/models 由 Host 代理，客户端只拿模型名。 */
      const fetchModels = React.useCallback(async () => {
        patch({ phase: 'fetching', status: '', statusKind: 'info' })
        try {
          const keyRef = safeKeyRef(declaredKeyRef)
          const result = await callHost('models', { baseUrl: state.baseUrl, apiKey: state.keyDraft, keyRef })
          const models = uniqueModels(modelsOfResult(result))
          report(models.length > 0 ? 'info' : 'warn', '获取可用模型结果', JSON.stringify({
            baseUrl: state.baseUrl,
            keyRef,
            count: models.length,
            imageModels: models.filter(isImageModel).length,
            models: models.slice(0, 12),
            keyProvided: state.keyDraft.length > 0,
            keyLength: state.keyDraft.length,
          }))
          patch({
            phase: 'idle',
            models,
            status: models.length === 0 ? tr('modelsEmpty') : `${tr('modelsFetched')} ${models.length}`,
            statusKind: models.length === 0 ? 'error' : 'ok',
          })
        } catch (error) {
          report('error', '获取可用模型失败', error instanceof Error ? `${error.message} | ${error.stack}` : String(error))
          patch({ phase: 'idle', status: messageOf(error), statusKind: 'error' })
        }
      }, [state.baseUrl, state.keyDraft, declaredKeyRef, patch, tr])

      /** 交给上层落盘：settings 写记录，credentials 写密钥（两者互相独立）。 */
      const submit = (event) => {
        if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        if (locked) return
        const baseUrl = state.baseUrl.trim()
        if (baseUrl === '') {
          patch({ status: tr('needBaseUrl'), statusKind: 'error' })
          return
        }
        props.onSubmit({
          id: typeof initial.id === 'string' ? initial.id : '',
          label: state.label.trim(),
          baseUrl,
          keyRef: typeof initial.keyRef === 'string' ? initial.keyRef : '',
          models: state.models,
          // 模型选择已经搬到主页的 modelRoutes；这里原样保留记录上的两个字段（它们是
          // 没有配 route 时的回退来源），不要因为浮层改版把已有值抹掉。
          imageModel: typeof initial.imageModel === 'string' ? initial.imageModel : '',
          editModel: typeof initial.editModel === 'string' ? initial.editModel : '',
        }, state.keyDraft)
      }

      const rows = []
      const titleId = `dib-editor-title-${initial.id === undefined || initial.id === '' ? 'new' : initial.id}`
      rows.push(h('div', { key: 'head', className: 'dib-editor-head' }, [
        h('h3', { key: 'title', id: titleId, className: 'dib-editor-title' }, initial.id === undefined || initial.id === '' ? tr('editorAdd') : tr('editorEdit')),
        h('button', {
          key: 'close',
          type: 'button',
          className: 'dib-editor-close',
          title: tr('close'),
          'aria-label': tr('close'),
          onClick: close,
        }, '×'),
      ]))
      rows.push(field('dib-provider-label', tr('name'), tr('name.hint'), state.label, locked, (value) => patch({ label: value }), { placeholder: tr('name.placeholder'), autoFocus: true }))
      rows.push(field('dib-provider-base-url', tr('baseUrl'), tr('baseUrl.hint'), state.baseUrl, locked, (value) => patch({ baseUrl: value }), { placeholder: tr('baseUrl.placeholder') }))
      rows.push(field(
        'dib-provider-key',
        tr('apiKey'),
        props.keyConfigured === true ? tr('apiKey.set') : tr('apiKey.unset'),
        state.keyDraft,
        locked,
        (value) => patch({ keyDraft: value }),
        { type: 'password', placeholder: tr('apiKey.placeholder') },
      ))
      rows.push(h('div', { key: 'actions', className: 'dib-editor-actions' }, [
        h('button', {
          key: 'test',
          type: 'button',
          className: 'dib-btn dib-btn-secondary',
          'data-dib-action': 'test',
          disabled: locked,
          onClick: () => { void test() },
        }, state.phase === 'testing' ? tr('testing') : tr('test')),
        h('button', {
          key: 'models',
          type: 'button',
          className: 'dib-btn dib-btn-secondary',
          'data-dib-action': 'fetch-models',
          disabled: locked,
          onClick: () => { void fetchModels() },
        }, state.phase === 'fetching' ? tr('fetching') : state.models.length > 0 ? tr('refetchModels') : tr('fetchModels')),
      ]))
      rows.push(h('p', { key: 'note', className: 'dib-editor-note' }, tr('keyNote')))

      /*
       * 这一家的模型列表：**只作展示**。
       *
       * 用户要的是"确认这个 Key 能用、能看到有哪些模型"，选择用哪个模型的活儿已经搬到
       * 设置页主页的模型区块。所以这里没有「生图 / 改图」按钮，只在被主页选中的模型上
       * 打一个标记——同一个 `modelRoutes`，两处显示不会互相矛盾。
       *
       * 过滤规则与主页一致（默认只列生图模型），勾「显示全部模型」看全部。
       */
      const routed = props.routed !== null && props.routed !== undefined && typeof props.routed === 'object' ? props.routed : {}
      const isRouted = (role, model) => {
        const item = routed[role]
        return item !== null && typeof item === 'object' && item.providerId === initial.id && item.model === model
      }
      const imageModels = state.models.filter((model) => isImageModel(model) || isRouted('generate', model) || isRouted('edit', model))
      const visibleModels = state.showAll ? state.models : imageModels
      const hiddenCount = state.models.length - imageModels.length

      if (state.models.length > 0) {
        const countText = visibleModels.length === state.models.length
          ? `${tr('availableModels')}（${state.models.length}）`
          : `${tr('availableModels')}（${visibleModels.length} / ${state.models.length}）`
        rows.push(h('div', { key: 'picker', className: 'dib-picker' }, [
          h('div', { key: 'head', className: 'dib-picker-head' }, [
            h('p', { key: 'title', className: 'dib-label' }, countText),
            h('label', { key: 'toggle', className: 'dib-toggle' }, [
              h('input', {
                key: 'box',
                id: 'dib-editor-showall',
                type: 'checkbox',
                checked: state.showAll,
                disabled: locked,
                onChange: (event) => patch({ showAll: event !== null && event.target !== null && event.target.checked === true }),
              }),
              h('span', { key: 'text' }, tr('showAll')),
            ]),
          ]),
          hiddenCount > 0 ? h('p', { key: 'hidden', className: 'dib-field-hint' }, `${tr('hiddenModels')} ${hiddenCount}`) : null,
          h('ul', { key: 'list', className: 'dib-model-list' }, visibleModels.map((model) => h('li', { key: model, className: 'dib-model-row' }, [
            h('span', { key: 'id', className: 'dib-model-id', title: model }, model),
            isRouted('generate', model) ? h('span', { key: 'picked-image', className: 'dib-card-tag dib-card-tag-on' }, tr('pickedImage')) : null,
            isRouted('edit', model) ? h('span', { key: 'picked-edit', className: 'dib-card-tag dib-card-tag-on' }, tr('pickedEdit')) : null,
          ]))),
        ]))
      } else {
        rows.push(h('p', { key: 'nomodels', className: 'dib-field-hint' }, tr('noModelsYet')))
      }

      const body = h('div', { key: 'body', className: 'dib-editor-body' }, rows)
      const footer = h('div', { key: 'footer', className: 'dib-editor-footer' }, [
        state.status === '' ? null : h('p', { key: 'status', className: statusClassOf(state.statusKind), role: 'status' }, state.status),
        h('button', {
          key: 'cancel',
          type: 'button',
          className: 'dib-btn dib-btn-secondary',
          onClick: close,
        }, tr('cancel')),
        h('button', { key: 'save', type: 'submit', className: 'dib-btn', disabled: locked }, tr('save')),
      ])

      /*
       * 浮层结构：遮罩（点它关闭）+ 居中卡片。
       *
       * 卡片是 `<form>`，所以回车就能保存；遮罩单独挂在卡片下面的兄弟节点上，
       * 点卡片内部不会触发关闭。
       */
      return h('div', { className: 'dib-overlay' }, [
        h('div', { key: 'mask', className: 'dib-overlay-mask', onClick: close }),
        h('form', {
          key: 'dialog',
          className: 'dib-editor',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          onSubmit: submit,
        }, [body, footer]),
      ])
    }

    /* ------------------------------------------------------------------ */
    /* 设置页                                                               */
    /* ------------------------------------------------------------------ */

    /** 设置页首屏状态；`__initial` 是进程外验证（verify-client.mjs）的注入点。 */
    function initialStateOf(injected) {
      const base = {
        phase: 'loading',
        available: true,
        writable: true,
        providers: [],
        activeProviderId: '',
        size: '',
        // 「自定义…」：尺寸不在预设里（或用户主动选了它）时露出文本框。
        sizeCustom: false,
        keyConfigured: {},
        testState: {},
        legacy: { baseUrl: '', model: '', editModel: '' },
        // 四个模型槽位（生图/修图 × 主/备）与主模型超时。
        routes: routesOf({}),
        routesShowAll: false,
        fallbackDraft: String(DEFAULT_FALLBACK_MS),
        editor: null,
        confirmDelete: '',
        busyId: '',
        status: '',
        statusKind: 'info',
      }
      if (injected === null || injected === undefined || typeof injected !== 'object') return base
      const merged = { ...base, ...injected }
      // 渲染路径绝不能因为一个字段形状不对而抛错，注入的状态同样如此。
      if (!Array.isArray(merged.providers)) merged.providers = base.providers
      if (merged.keyConfigured === null || typeof merged.keyConfigured !== 'object') merged.keyConfigured = base.keyConfigured
      if (merged.testState === null || typeof merged.testState !== 'object') merged.testState = base.testState
      if (merged.legacy === null || typeof merged.legacy !== 'object') merged.legacy = base.legacy
      if (merged.routes === null || typeof merged.routes !== 'object') merged.routes = base.routes
      if (typeof merged.fallbackDraft !== 'string') merged.fallbackDraft = base.fallbackDraft
      return merged
    }

    function ConfigBody(props) {
      const tr = translate(props.t)
      const ctx = props.__ctx
      const [state, setState] = React.useState(() => initialStateOf(props.__initial))

      const patch = React.useCallback((next) => setState((current) => ({ ...current, ...next })), [])

      /** 只改四个模型槽位里的一个，其余三个原样保留。 */
      const patchRoute = React.useCallback((id, next) => {
        setState((current) => {
          const routes = { ...(current.routes ?? {}) }
          const route = routes[id] !== null && typeof routes[id] === 'object' ? routes[id] : {}
          routes[id] = { ...route, ...next }
          return { ...current, routes }
        })
      }, [])

      /*
       * 文案函数每次渲染都是新的：把它放进 ref，effect 就能安全地用它，
       * 又不必把它写进依赖数组（否则每次渲染都会重跑载入逻辑）。
       */
      const trRef = React.useRef(tr)
      trRef.current = tr

      /*
       * 远程命名空间只在 effect 里解析：渲染路径保持纯粹，不会因为服务发现失败
       * 而把整个插槽条目拖进「渲染抛错」的处理路径。
       */
      const remotes = React.useRef(null)

      React.useEffect(() => {
        let live = true
        ;(async () => {
          try {
            const settings = remoteNamespace(ctx, 'settings')
            const credentials = remoteNamespace(ctx, 'credentials')
            remotes.current = { settings, credentials }
            if (settings === undefined) {
              if (live) patch({ phase: 'idle', available: false, status: trRef.current('unavailable'), statusKind: 'error' })
              return
            }
            const described = await settings.describe()
            if (!live) return
            if (described !== null && typeof described === 'object' && described.ok === false) {
              patch({ phase: 'idle', available: false, status: `${trRef.current('loadFailed')}${messageOf(described)}`, statusKind: 'error' })
              return
            }
            const views = namespacesOf(described)
            const view = views.find((candidate) => candidate !== null && typeof candidate === 'object' && candidate.ns === SETTINGS_NS)
            const value = view !== undefined && view.value !== null && typeof view.value === 'object' ? view.value : {}
            const taken = []
            const stored = Array.isArray(value.providers) ? value.providers : []
            const configured = stored.map((raw) => normalizeProvider(raw, taken))
            const legacy = legacyProviderOf(value)
            // 没有 providers 时把旧配置合成一张卡片，让既有配置在界面上看得见。
            const providers = configured.length > 0 ? configured : legacy === null ? [] : [legacy]
            const declaredActive = typeof value.activeProviderId === 'string' ? value.activeProviderId : ''
            const activeProviderId = providers.some((provider) => provider.id === declaredActive)
              ? declaredActive
              : providers.length > 0 ? providers[0].id : ''

            // 一次 describe 拿到所有引用名的配置状态（凭据值本身永远不过线）。
            const refToId = {}
            for (const provider of providers) refToId[provider.keyRef] = provider.id
            const refs = Object.keys(refToId)
            const keyConfigured = {}
            if (credentials !== undefined && refs.length > 0) {
              // 凭据服务一次最多描述 64 个引用；分批只为不撞上那条线（正常用不到）。
              for (let start = 0; start < refs.length; start += 32) {
                const batch = refs.slice(start, start + 32)
                const credentialView = await credentials.describe(batch)
                if (!live) return
                if (credentialView === null || typeof credentialView !== 'object' || credentialView.ok !== true
                  || credentialView.value === null || typeof credentialView.value !== 'object') {
                  report('warn', '凭据描述失败', JSON.stringify({
                    ok: credentialView === null || typeof credentialView !== 'object' ? null : credentialView.ok,
                    error: messageOf(credentialView),
                  }))
                  continue
                }
                for (const ref of batch) {
                  const info = credentialView.value[ref]
                  keyConfigured[refToId[ref]] = info !== null && typeof info === 'object' && info.configured === true
                }
                // 记下凭据视图的真实形状，省得下次还要猜（CredentialInfo 里没有值可泄露）。
                report('info', '凭据视图', JSON.stringify({
                  refs: batch.length,
                  keys: Object.keys(credentialView.value).slice(0, 8),
                  sample: credentialView.value[batch[0]] === undefined ? null : credentialView.value[batch[0]],
                }))
              }
            }

            report('info', '配置已载入', JSON.stringify({
              ns: SETTINGS_NS,
              namespaceFound: view !== undefined,
              writable: writableOf(described),
              providers: providers.length,
              activeProviderId,
              models: providers.map((provider) => provider.models.length),
              keyConfigured: Object.keys(keyConfigured).filter((id) => keyConfigured[id] === true).length,
              fallbackAfterMs: value.fallbackAfterMs === undefined ? null : value.fallbackAfterMs,
            }))
            patch({
              phase: 'idle',
              writable: writableOf(described),
              providers,
              activeProviderId,
              size: typeof value.size === 'string' ? value.size : '',
              keyConfigured,
              routes: routesOf(value),
              fallbackDraft: fallbackDraftOf(value),
              legacy: {
                baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
                model: typeof value.model === 'string' ? value.model : '',
                editModel: typeof value.editModel === 'string' ? value.editModel : '',
              },
            })
          } catch (error) {
            if (!live) return
            patch({ phase: 'idle', available: false, status: messageOf(error), statusKind: 'error' })
          }
        })()
        return () => {
          live = false
        }
      }, [ctx, patch])

      /** 打开编辑面板：`null` 表示新增，其余为编辑已有记录。 */
      const openEditor = React.useCallback((provider) => {
        if (provider === null || provider === undefined) {
          patch({
            editor: {
              mode: 'add',
              initial: {
                label: '',
                baseUrl: state.legacy.baseUrl,
                keyRef: '',
                models: [],
                imageModel: state.legacy.model,
                editModel: '',
              },
            },
            status: '',
            statusKind: 'info',
            confirmDelete: '',
          })
          return
        }
        patch({
          editor: {
            mode: 'edit',
            initial: {
              id: provider.id,
              keyRef: provider.keyRef,
              label: provider.label !== '' ? provider.label : provider.legacy === true ? trRef.current('legacyProviderName') : provider.id,
              baseUrl: provider.baseUrl,
              models: provider.models,
              imageModel: provider.imageModel,
              editModel: provider.editModel,
              testState: state.testState[provider.id],
            },
          },
          status: '',
          statusKind: 'info',
          confirmDelete: '',
        })
      }, [state.legacy, state.testState, patch])

      /*
       * 卡片上不再有「设为当前」入口：主用/备用模型已经按角色带上了 providerId，
       * "当前生效服务商"对用户不再有意义。**`activeProviderId` 本身不删**——Host 的
       * 三级回退（activeProviderId → providers[0] → 旧字段）仍然依赖它，只是界面不再提供
       * 切换入口；保存时依旧原样写回。
       */

      /** 删除提供商：从列表里移除并落盘；密钥留在凭据服务里（不替用户做破坏性清理）。 */
      const removeProvider = React.useCallback(async (provider) => {
        const current = remotes.current
        const settings = current === null || current === undefined ? undefined : current.settings
        const next = state.providers.filter((item) => item.id !== provider.id).map(plainProvider)
        const activeProviderId = state.activeProviderId === provider.id ? (next.length > 0 ? next[0].id : '') : state.activeProviderId
        if (settings === undefined) {
          patch({ confirmDelete: '' })
          return
        }
        patch({ phase: 'saving', status: '', statusKind: 'info' })
        try {
          const written = await settings.update(SETTINGS_NS, { providers: next, activeProviderId }, undefined)
          const failure = failureOf(written)
          if (failure !== null) throw new Error(failure)
          patch({ phase: 'idle', providers: next, activeProviderId, confirmDelete: '', status: trRef.current('removed'), statusKind: 'ok' })
          report('info', '提供商已删除', JSON.stringify({ id: provider.id, keyRef: provider.keyRef, remaining: next.length, activeProviderId, keyKept: true }))
        } catch (error) {
          report('error', '删除提供商失败', error instanceof Error ? `${error.message} | ${error.stack}` : String(error))
          patch({ phase: 'idle', confirmDelete: '', status: messageOf(error), statusKind: 'error' })
        }
      }, [state.providers, state.activeProviderId, patch])

      /**
       * 保存编辑面板的内容。
       *
       * 两处写入互相独立：`settings.update` 落 providers/activeProviderId，
       * `credentials.set` 只在用户真的输入了密钥时才写。密钥本身绝不进日志、
       * 绝不进 settings patch。
       */
      const submitProvider = React.useCallback(async (draft, keyDraft) => {
        const current = remotes.current
        const settings = current === null || current === undefined ? undefined : current.settings
        const credentials = current === null || current === undefined ? undefined : current.credentials
        if (settings === undefined) {
          patch({ editor: null, status: trRef.current('unavailable'), statusKind: 'error' })
          return
        }
        patch({ phase: 'saving', status: '', statusKind: 'info' })
        try {
          const taken = state.providers.filter((item) => item.id !== draft.id).map((item) => item.id)
          const seed = slugify(draft.label) !== '' ? slugify(draft.label) : hostSlugOf(draft.baseUrl)
          const id = draft.id !== '' ? draft.id : uniqueId(seed, taken)
          // 声明了引用名就沿用（过形状校验），否则按 id 派生——非法值正好借这次保存自愈。
          const declaredRef = safeKeyRef(draft.keyRef)
          const keyRef = declaredRef !== '' ? declaredRef : keyRefOf(id)
          const record = {
            id,
            label: draft.label === '' ? id : draft.label,
            baseUrl: draft.baseUrl,
            keyRef,
            models: Array.isArray(draft.models) ? draft.models : [],
            imageModel: draft.imageModel,
            editModel: draft.editModel,
          }
          const next = state.providers.map(plainProvider)
          const index = state.providers.findIndex((item) => item.id === id)
          if (index >= 0) next[index] = record
          else next.push(record)
          const activeProviderId = state.activeProviderId === '' ? id : state.activeProviderId

          // 模型设置与提供商一起落盘：一次 patch 里带上完整的四项，避免只写一半把
          // 已经配好的路由/超时留在旧值上。非法超时按默认值写，绝不写非法数据。
          const written = await settings.update(SETTINGS_NS, {
            providers: next,
            activeProviderId,
            modelRoutes: modelRoutesOf(state.routes, activeProviderId),
            fallbackAfterMs: parseFallbackMs(state.fallbackDraft) ?? DEFAULT_FALLBACK_MS,
          }, undefined)
          const failure = failureOf(written)
          if (failure !== null) throw new Error(failure)

          let keyConfigured = state.keyConfigured
          let keySaved = false
          if (keyDraft !== '') {
            if (credentials === undefined) throw new Error(trRef.current('keyUnavailable'))
            const stored = await credentials.set(keyRef, keyDraft)
            const keyFailure = failureOf(stored)
            if (keyFailure !== null) throw new Error(keyFailure)
            keyConfigured = { ...state.keyConfigured, [id]: true }
            keySaved = true
          }

          patch({
            phase: 'idle',
            providers: next,
            activeProviderId,
            keyConfigured,
            editor: null,
            status: keySaved ? `${trRef.current('saved')} ${trRef.current('savedKey')}` : trRef.current('saved'),
            statusKind: 'ok',
          })
          // 只记长度与是否保存，绝不记密钥本身。
          report('info', '提供商已保存', JSON.stringify({
            id,
            keyRef,
            providers: next.length,
            activeProviderId,
            models: record.models.length,
            imageModel: record.imageModel,
            editModel: record.editModel,
            keySaved,
            keyLength: keyDraft.length,
          }))
        } catch (error) {
          report('error', '提供商保存失败', error instanceof Error ? `${error.message} | ${error.stack}` : String(error))
          patch({ phase: 'idle', status: messageOf(error), statusKind: 'error' })
        }
      }, [state.providers, state.activeProviderId, state.keyConfigured, state.routes, state.fallbackDraft, patch])

      /**
       * 保存主页的模型设置：四个槽位 + 主模型超时。
       *
       * 超时非法时**直接拒绝保存**（界面给出原因），不会把非法值写进配置——空串则按
       * 默认 15000 写。
       */
      const saveRoutes = React.useCallback(async () => {
        const current = remotes.current
        const settings = current === null || current === undefined ? undefined : current.settings
        if (settings === undefined) return
        const fallbackAfterMs = parseFallbackMs(state.fallbackDraft)
        if (fallbackAfterMs === undefined) {
          patch({ status: trRef.current('fallbackInvalid'), statusKind: 'error' })
          report('warn', '模型设置未保存：超时不是正整数', JSON.stringify({ length: state.fallbackDraft.length }))
          return
        }
        patch({ phase: 'saving', status: '', statusKind: 'info' })
        try {
          const modelRoutes = modelRoutesOf(state.routes, state.activeProviderId)
          const written = await settings.update(SETTINGS_NS, {
            providers: state.providers.map(plainProvider),
            activeProviderId: state.activeProviderId,
            modelRoutes,
            fallbackAfterMs,
          }, undefined)
          const failure = failureOf(written)
          if (failure !== null) throw new Error(failure)
          patch({ phase: 'idle', fallbackDraft: String(fallbackAfterMs), status: trRef.current('routes.saved'), statusKind: 'ok' })
          report('info', '模型设置已保存', JSON.stringify({ modelRoutes, fallbackAfterMs }))
        } catch (error) {
          report('error', '模型设置保存失败', error instanceof Error ? `${error.message} | ${error.stack}` : String(error))
          patch({ phase: 'idle', status: messageOf(error), statusKind: 'error' })
        }
      }, [state.routes, state.fallbackDraft, state.providers, state.activeProviderId, patch])

      /** 全局默认尺寸：对所有提供商生效，单独保存。 */
      const saveSize = React.useCallback(async () => {
        const current = remotes.current
        const settings = current === null || current === undefined ? undefined : current.settings
        if (settings === undefined) return
        patch({ phase: 'saving', status: '', statusKind: 'info' })
        try {
          const written = await settings.update(SETTINGS_NS, { size: state.size }, undefined)
          const failure = failureOf(written)
          if (failure !== null) throw new Error(failure)
          patch({ phase: 'idle', status: trRef.current('saved'), statusKind: 'ok' })
          report('info', '默认尺寸已保存', JSON.stringify({ size: state.size }))
        } catch (error) {
          report('error', '默认尺寸保存失败', error instanceof Error ? `${error.message} | ${error.stack}` : String(error))
          patch({ phase: 'idle', status: messageOf(error), statusKind: 'error' })
        }
      }, [state.size, patch])

      /** 卡片上的「测试」：用这张卡片自己的密钥打一次 test，结果决定状态点的颜色。 */
      const testProvider = React.useCallback(async (provider) => {
        patch({ busyId: provider.id, status: '', statusKind: 'info' })
        try {
          // 同样带上 keyRef（先过形状校验）：卡片上的测试多半就发生在"不是当前生效"的那张卡上。
          const keyRef = safeKeyRef(provider.keyRef)
          const result = await callHost('test', { baseUrl: provider.baseUrl, apiKey: '', keyRef })
          const outcome = testOutcomeOf(result)
          report(outcome.ok ? 'info' : 'warn', '测试连接结果', JSON.stringify({
            id: provider.id,
            baseUrl: provider.baseUrl,
            keyRef,
            ok: outcome.ok,
            message: outcome.message,
            keyProvided: false,
          }))
          patch({
            busyId: '',
            testState: { ...state.testState, [provider.id]: outcome.ok ? 'ok' : 'fail' },
            status: outcome.message === '' ? (outcome.ok ? trRef.current('testOk') : trRef.current('testFail')) : outcome.message,
            statusKind: outcome.ok ? 'ok' : 'error',
          })
        } catch (error) {
          report('error', '测试连接失败', `${provider.id}: ${messageOf(error)}`)
          patch({
            busyId: '',
            testState: { ...state.testState, [provider.id]: 'fail' },
            status: messageOf(error),
            statusKind: 'error',
          })
        }
      }, [state.testState, patch])

      if (state.phase === 'loading') {
        return h('div', { className: 'dib-cfg' }, h('p', { className: 'dib-field-hint' }, tr('loading')))
      }
      if (state.available === false) {
        return h('div', { className: 'dib-cfg' }, [
          h('p', { key: 'msg', className: 'dib-field-hint' }, tr('unavailable')),
          state.status === '' ? null : h('p', { key: 'why', className: 'dib-status dib-status-error' }, state.status),
        ])
      }

      const disabled = state.writable === false
      const busy = state.phase !== 'idle'

      /**
       * 一张提供商卡片：**单行** —— [状态灯] 名称 [测试/编辑/删除]。
       *
       * 卡片正文（生图/改图模型、接口地址、密钥状态）已经去掉：那些信息在「编辑」浮层里
       * 仍可看可改，主页只保留一眼能扫完的一行（对齐官方「设置 → 模型」页的观感）。
       * 纯函数：不持有状态，出错只会影响这张。
       */
      const cardOf = (provider) => {
        const signal = providerSignalOf(provider, state.testState)
        const dotClass = signal === 'ok' ? 'dib-dot dib-dot-ok' : signal === 'fail' ? 'dib-dot dib-dot-fail' : 'dib-dot'
        const dotTitle = signal === 'ok'
          ? state.testState[provider.id] === 'ok' ? tr('dot.ok') : tr('dot.connected')
          : signal === 'fail' ? tr('dot.fail') : tr('dot.untested')
        const confirming = state.confirmDelete === provider.id
        const name = provider.label !== '' ? provider.label : provider.legacy === true ? tr('legacyProviderName') : provider.id
        return h('li', { key: provider.id, className: 'dib-card' }, [
          h('div', { key: 'head', className: 'dib-card-head' }, [
            h('span', { key: 'dot', className: dotClass, title: dotTitle, 'aria-label': dotTitle, role: 'img' }),
            h('span', { key: 'name', className: 'dib-card-name', title: provider.id }, name),
            provider.legacy === true ? h('span', { key: 'legacy', className: 'dib-card-tag' }, tr('legacyTag')) : null,
            h('div', { key: 'actions', className: 'dib-card-actions' }, [
              h('button', {
                key: 'test',
                type: 'button',
                className: 'dib-mini',
                disabled: disabled || busy,
                onClick: () => { void testProvider(provider) },
              }, state.busyId === provider.id ? tr('testing') : tr('testShort')),
              h('button', {
                key: 'edit',
                type: 'button',
                className: 'dib-mini',
                disabled,
                onClick: () => openEditor(provider),
              }, tr('edit')),
              confirming
                ? h('button', {
                  key: 'confirm',
                  type: 'button',
                  className: 'dib-mini dib-mini-danger',
                  disabled: disabled || busy,
                  onClick: () => { void removeProvider(provider) },
                }, tr('removeConfirm'))
                : h('button', {
                  key: 'remove',
                  type: 'button',
                  className: 'dib-mini dib-mini-danger',
                  disabled,
                  onClick: () => patch({ confirmDelete: provider.id }),
                }, tr('remove')),
              confirming ? h('button', {
                key: 'abort',
                type: 'button',
                className: 'dib-mini',
                disabled,
                onClick: () => patch({ confirmDelete: '' }),
              }, tr('cancel')) : null,
            ]),
          ]),
        ])
      }

      const editor = state.editor
      const editorTarget = editor === null || editor === undefined || editor.initial === null || editor.initial === undefined
        ? undefined
        : editor.initial
      const editorId = editorTarget !== null && editorTarget !== undefined && typeof editorTarget.id === 'string' ? editorTarget.id : ''

      /*
       * 尺寸下拉的两个派生值。
       *
       * `sizeIsCustom`：用户主动选了「自定义…」，或配置里存着一个不在预设里的尺寸。
       * `sizeSelectValue`：预设命中就选它；配置里没写尺寸时显示默认值——Host 读取时
       * 也是把空值当归一到 1024x1024（`nonEmptyString(value.size, '1024x1024')`），两边一致。
       */
      const sizeIsPreset = SIZE_PRESETS.includes(state.size)
      const sizeIsCustom = state.sizeCustom === true || (state.size !== '' && !sizeIsPreset)
      const sizeSelectValue = sizeIsPreset ? state.size : DEFAULT_SIZE

      /*
       * 模型区块：四个槽位（生图/修图 × 主/备）+ 主模型超时。
       *
       * 选项是**所有已获取过模型列表的服务商的并集**（每个 provider 记录里存着它的
       * models），按服务商分组（optgroup 标签用服务商名）。每一项写进配置时同时带上
       * providerId 与 model——跨服务商选模型必须知道用哪家的地址与凭据。
       */
      const routeItemOf = (id) => modelRoutesOf(state.routes, state.activeProviderId)[id.split('.')[0]][id.split('.')[1]]
      const connected = state.providers.filter((provider) => Array.isArray(provider.models) && provider.models.length > 0)
      const hasConnected = connected.length > 0
      /*
       * 「手动输入…」提示里的服务商名。
       *
       * `activeProviderId` 没命中时按 Host 的同一套回退取 `providers[0]`——所以只要还留着
       * 至少一家服务商，这个名字就不会是空的（Host 那边解析手动输入的凭据也是这么回退的）。
       */
      const activeProvider = state.providers.find((provider) => provider.id === state.activeProviderId) ?? state.providers[0]
      const activeName = activeProvider === undefined
        ? ''
        : activeProvider.label !== '' ? activeProvider.label : activeProvider.id
      const activeLabel = activeName === '' ? tr('route.noActive') : activeName
      const routed = { generate: routeItemOf('generate.primary'), edit: routeItemOf('edit.primary') }

      /** 某个槽位的选项分组：只列有模型的服务商，当前值一定补进去（受控下拉不能空白）。 */
      const groupsFor = (id) => {
        const selected = routeItemOf(id)
        const groups = []
        for (const provider of state.providers) {
          const models = Array.isArray(provider.models) ? provider.models : []
          if (models.length === 0) continue
          const visible = models.filter((model) => state.routesShowAll || isImageModel(model))
          if (selected.providerId === provider.id && selected.model !== '' && !visible.includes(selected.model)) visible.push(selected.model)
          const unique = uniqueModels(visible)
          if (unique.length > 0) groups.push({ provider, models: unique })
        }
        return groups
      }

      const routeField = (id) => {
        const route = state.routes[id] !== null && typeof state.routes[id] === 'object' ? state.routes[id] : {}
        const manual = route.manual === true || !hasConnected
        const selectId = `dib-route-${id.replace('.', '-')}`
        const inputId = `${selectId}-manual`
        const selected = routeItemOf(id)
        const fallbackSlot = id.endsWith('.fallback')
        /*
         * 备用那一行的可见标签被去掉了（下拉的空选项本身就写着「备用模型」，标签是重复的），
         * 因此它必须带一个等价的 aria-label——**视觉上删掉、语义上保留**，读屏依旧能把
         * 两个备用下拉和主用下拉区分开。文案照旧走语言包。
         */
        const fieldNodes = []
        if (!fallbackSlot) fieldNodes.push(h('label', { key: 'label', className: 'dib-label', htmlFor: selectId }, tr(`route.${id}`)))
        fieldNodes.push(h('select', {
          key: 'select',
          id: selectId,
          className: 'dib-input dib-select',
          'data-dib-route': id,
          ...(fallbackSlot ? { 'aria-label': tr(`route.${id}`) } : {}),
          'aria-describedby': `${selectId}-hint`,
          value: manual ? MANUAL_MODEL_VALUE : routeValueOf(route.providerId, route.model),
          disabled: disabled || !hasConnected,
          onChange: (event) => {
            const next = event !== null && event.target !== null && typeof event.target.value === 'string' ? event.target.value : ''
            if (next === MANUAL_MODEL_VALUE) {
              patchRoute(id, { manual: true })
              return
            }
            const picked = splitRouteValue(next)
            patchRoute(id, { manual: false, providerId: picked.providerId, model: picked.model })
          },
        }, [
          /*
           * 占位条目：`hidden` 让它在展开的列表里不出现，`disabled` 保证点不中，而当这个
           * 槽位还没选模型时（受控 value 为空）浏览器仍然显示这行文案——**显示的占位与状态
           * 一致**，不会静默跳到第一个模型（那会造成"显示某个模型、状态却是空"的错位）。
           */
          h('option', {
            key: 'unset',
            value: '',
            hidden: true,
            disabled: true,
          }, fallbackSlot ? tr('route.noFallback') : tr('route.unset')),
          ...groupsFor(id).map((group) => h('optgroup', {
            key: `g:${group.provider.id}`,
            label: groupLabelOf(group.provider.label !== '' ? group.provider.label : group.provider.id),
          }, group.models.map((model) => h('option', {
            key: `${group.provider.id}:${model}`,
            value: routeValueOf(group.provider.id, model),
            'data-provider': group.provider.id,
            'data-model': model,
          }, model)))),
          h('option', { key: 'manual', value: MANUAL_MODEL_VALUE }, tr('manualOption')),
        ]))
        fieldNodes.push(h('p', { key: 'hint', id: `${selectId}-hint`, className: 'dib-field-hint' }, manual
          ? `${tr('route.manualHint')}：${activeLabel}`
          : fallbackSlot ? tr('route.fallbackHint') : tr('route.primaryHint')))
        const nodes = [h('div', {
          key: 'field',
          // 备用行少了一行标签，上内边距一并收掉，免得留出突兀的空隙。
          className: fallbackSlot ? 'dib-field dib-route-fallback' : 'dib-field',
        }, fieldNodes)]
        if (manual) {
          nodes.push(field(inputId, tr('manualOption'), `${tr('route.manualHint')}：${activeLabel}`, typeof route.manualText === 'string' ? route.manualText : '', disabled, (value) => patchRoute(id, { manualText: value }), {
            placeholder: id.startsWith('generate') ? tr('imageModel.placeholder') : tr('editModel.placeholder'),
          }))
        }
        return h('div', { key: id, className: 'dib-route-group', 'data-route-slot': id }, nodes)
      }

      /** 一个角色（生图 / 修图）：主用 + 备用紧邻成组。 */
      const routePair = (role) => h('div', { key: role, className: 'dib-route-pair', 'data-route-pair': role }, [
        routeField(`${role}.primary`),
        routeField(`${role}.fallback`),
      ])

      const routesBlock = h('div', { key: 'routes', className: 'dib-routes' }, [
        h('h3', { key: 'title', className: 'dib-section-title' }, tr('routes.title')),
        h('p', { key: 'hint', className: 'dib-field-hint' }, tr('routes.hint')),
        hasConnected ? null : h('p', { key: 'none', className: 'dib-field-hint' }, tr('routes.none')),
        routePair('generate'),
        routePair('edit'),
        h('div', { key: 'showall', className: 'dib-toggle-row' }, [
          h('label', { key: 'toggle', className: 'dib-toggle' }, [
            h('input', {
              key: 'box',
              id: 'dib-routes-showall',
              type: 'checkbox',
              checked: state.routesShowAll,
              disabled,
              onChange: (event) => patch({ routesShowAll: event !== null && event.target !== null && event.target.checked === true }),
            }),
            h('span', { key: 'text' }, tr('routes.showAll')),
          ]),
        ]),
        h('div', { key: 'timeout', className: 'dib-field' }, [
          h('label', { key: 'label', className: 'dib-label', htmlFor: 'dib-fallback-ms' }, tr('fallbackAfterMs')),
          h('input', {
            key: 'input',
            id: 'dib-fallback-ms',
            className: 'dib-input dib-input-narrow',
            type: 'text',
            inputMode: 'numeric',
            placeholder: tr('fallbackAfterMs.placeholder'),
            value: state.fallbackDraft,
            disabled,
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => patch({ fallbackDraft: event.target.value }),
          }),
          h('p', { key: 'hint', className: 'dib-field-hint' }, tr('fallbackAfterMs.hint')),
        ]),
        h('div', { key: 'footer', className: 'dib-footer' }, [
          h('button', {
            key: 'save',
            type: 'button',
            className: 'dib-btn',
            'data-dib-action': 'save-routes',
            disabled: disabled || busy,
            onClick: () => { void saveRoutes() },
          }, tr('routes.save')),
        ]),
      ])

      return h('div', { className: 'dib-cfg' }, [
        h('p', { key: 'intro', className: 'dib-cfg-intro' }, tr('intro')),
        state.providers.length === 0 ? null : h('ul', { key: 'list', className: 'dib-list' }, state.providers.map(cardOf)),
        state.providers.length === 0 ? h('p', { key: 'empty', className: 'dib-field-hint' }, tr('empty')) : null,
        editor === null || editor === undefined
          ? h('button', {
            key: 'add',
            type: 'button',
            className: 'dib-add-btn',
            disabled,
            onClick: () => openEditor(null),
          }, `＋ ${tr('add')}`)
          : h(ProviderEditor, {
            key: `editor:${editor.mode}:${editorId === '' ? 'new' : editorId}`,
            t: props.t,
            initial: editorTarget,
            keyConfigured: editorId !== '' && state.keyConfigured[editorId] === true,
            // 浮层只展示模型、不再选择；把主页的路由结果传进去，让列表能标出"正被用"的那几个。
            routed,
            disabled,
            busy: state.phase === 'saving',
            onCancel: () => {
              // 关浮层是个会改变界面的动作，留一行日志便于事后对齐"我明明点了取消"这类反馈。
              report('info', '编辑浮层已关闭', JSON.stringify({ mode: editor.mode, id: editorId }))
              patch({ editor: null, status: '', statusKind: 'info' })
            },
            onSubmit: (draft, keyDraft) => { void submitProvider(draft, keyDraft) },
          }),
        routesBlock,
        h('div', { key: 'defaults', className: 'dib-defaults' }, [
          h('label', { key: 'label', className: 'dib-label', htmlFor: 'dib-size' }, tr('size')),
          /*
           * 尺寸：常用预设 + 「自定义…」。
           *
           * 与四个模型下拉同一条不变量——当前值一定出现在选项里：配置里存着预设之外的
           * 尺寸（例如以前手填的 `1280*720`）时自动进入自定义模式、把原值回显到文本框，
           * 既不显示空白，也不改写它。比例只写在选项文案里，value 始终是尺寸本身。
           */
          h('select', {
            key: 'select',
            id: 'dib-size',
            className: 'dib-input dib-select',
            value: sizeIsCustom ? CUSTOM_SIZE_VALUE : sizeSelectValue,
            disabled: disabled || busy,
            onChange: (event) => {
              const next = event !== null && event.target !== null && typeof event.target.value === 'string' ? event.target.value : ''
              if (next === CUSTOM_SIZE_VALUE) {
                patch({ sizeCustom: true })
                return
              }
              patch({ sizeCustom: false, size: next })
            },
          }, [
            ...SIZE_PRESETS.map((preset) => {
              const key = `size.preset.${preset}`
              const label = tr(key)
              return h('option', { key: preset, value: preset }, label === key ? preset : label)
            }),
            h('option', { key: 'custom', value: CUSTOM_SIZE_VALUE }, tr('size.custom')),
          ]),
          sizeIsCustom ? h('input', {
            key: 'custom-input',
            id: 'dib-size-custom',
            className: 'dib-input dib-input-narrow',
            type: 'text',
            value: state.size,
            disabled: disabled || busy,
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => patch({ size: event.target.value }),
          }) : null,
          h('button', {
            key: 'save',
            type: 'button',
            className: 'dib-btn dib-btn-secondary',
            disabled: disabled || busy,
            onClick: () => { void saveSize() },
          }, tr('saveSize')),
          h('p', { key: 'hint', className: 'dib-field-hint' }, tr('size.hint')),
        ]),
        state.status === '' ? null : h('p', { key: 'status', className: statusClassOf(state.statusKind), role: 'status' }, state.status),
      ])
    }

    /** 两个工具名共用同一个视图。 */
    const TOOL_KEYS = ['image_generate', 'image_edit']

    /**
     * 注册体：外层只做一次 createElement，不用任何钩子，因此自身不会抛错；
     * 真正的渲染在错误边界之内，出错也只是显示一行原因。
     */
    function ImageToolview(props) {
      return h(SectionBoundary, null, h(ImageResultRow, props))
    }

    function ImageBridgeSection(props) {
      return h(SectionBoundary, null, h(ConfigBody, props))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        report('info', 'client apply 开始', '')

        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh: MESSAGES.zh, en: MESSAGES.en })
          } catch (error) {
            // HMR 重载时命名空间可能已经注册过，重复注册会抛错；
            // 绝不能让它带崩整个 apply（那会让两个插槽注册一起消失）。
            report('warn', 'locale 词典注册失败', error instanceof Error ? error.message : String(error))
            return () => {}
          }
        }, 'image-bridge: dictionaries')

        let t = (key) => MESSAGES.zh[key] ?? key
        try {
          const bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') t = bound
        } catch (error) {
          report('warn', 'locale.bind 失败，改用内置文案', error instanceof Error ? error.message : String(error))
        }

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-image-bridge'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'image-bridge: styles')

        /*
         * 启动即探测一次远程命名空间。
         *
         * 配置页里的解析只在组件挂载时才跑，所以页面没被打开时无法判断解析路径是否
         * 可用。这里在 apply 期先探一次并写进日志——这样"设置页到底能不能连上 Host
         * 配置服务"这个问题，不必等用户点开页面就有答案。
         */
        try {
          const probeSettings = remoteNamespace(ctx, 'settings')
          const probeCredentials = remoteNamespace(ctx, 'credentials')
          report('info', 'apply 期探测远程命名空间', JSON.stringify({
            settings: probeSettings !== undefined,
            credentials: probeCredentials !== undefined,
          }))
        } catch (error) {
          report('warn', 'apply 期探测远程命名空间抛错', String(error?.message ?? error))
        }

        /* 临时诊断：把本插件那一行的设置快照打进日志，确认配置是否真的落到行上。 */
        try {
          const snapshotClient = remoteNamespace(ctx, 'settings')
          if (snapshotClient !== undefined && typeof snapshotClient.describe === 'function') {
            Promise.resolve(snapshotClient.describe())
              .then((result) => {
                const payload = result !== null && typeof result === 'object' && 'value' in result ? result.value : result
                const list = Array.isArray(payload) ? payload : []
                const mine = list.filter((row) => row !== null && typeof row === 'object' && row.ns === SETTINGS_NS)
                report('info', '设置行快照', JSON.stringify({
                  total: list.length,
                  namespaces: list.slice(0, 12).map((row) => (row !== null && typeof row === 'object' ? row.ns : null)),
                  mine: mine.slice(0, 2),
                }).slice(0, 900))
              })
              .catch((error) => report('warn', '设置行快照失败', String(error?.message ?? error)))
          }
        } catch (error) {
          report('warn', '设置行快照抛错', String(error?.message ?? error))
        }

        try {
          ctx.slots.inject('tool.call.toolview', function* registerImageViews() {
            for (const key of TOOL_KEYS) {
              yield ctx.slots.register({
                name: 'tool.call.toolview',
                key,
                locale: NS,
                /*
                 * 这里**不能**声明 `tool.call.images` 子插槽：内置的 read_image 卡片
                 * （read-image-toolview）已经声明了它，而一个子插槽只允许有一个声明者，
                 * 再声明会抛 "already declared"，导致本条目整个注册失败。
                 * 图片改由本插件自己用 loadImage 渲染。
                 */
              }, ImageToolview)
            }
          })
        } catch (error) {
          report('fatal', 'tool.call.toolview 注册失败', error instanceof Error ? error.stack : String(error))
        }

        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-image-bridge-config',
            order: 120,
            /*
             * 用负优先级：列表插槽里同一个 id 重复注册会抛错，而热重载时上一代模块的
             * 注册尚未释放。优先级更低者渲染，于是新的一次注册遮住旧的那一条，
             * 既不会抛错，界面上也只会看到一份。
             */
            priority: -1,
            label: () => t('nav'),
            locale: NS,
          }, (props) => h(SectionBoundary, null, h(ConfigBody, { ...props, __ctx: ctx }))))
        } catch (error) {
          report('fatal', 'settings.section 注册失败', error instanceof Error ? error.stack : String(error))
        }

        report('info', 'client apply 完成', '')
      },
    }
  },
})
