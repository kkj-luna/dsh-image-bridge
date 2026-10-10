/**
 * 生图桥 Client 半的进程外验证。
 *
 * 没有浏览器控制，所以这里不做真实 DOM 渲染，但可以：
 * 用桩 React + 假 slots/locale 上下文加载 client.js，检查注册形状，
 * 并直接调用两个组件函数以确认各状态下都不会抛错
 * （渲染期抛错会让宿主永久弃用该插槽条目）。
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const ROOT = '<workspace>/plugins/dsh-image-bridge-v4'
const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'ok   ' : 'FAIL '} ${name}${condition || detail === undefined ? '' : ` — ${detail}`}`)
}

/* ---------------------------------------------------------------- 桩 React */

let hookState = []
function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
}
/** React.Component 的最小实现；错误边界是类组件，必须在模块加载时就能 extends。 */
class StubComponent {
  constructor(props) {
    this.props = props
  }
}

const React = {
  createElement,
  Component: StubComponent,
  useState: (initial) => {
    const value = typeof initial === 'function' ? initial() : initial
    hookState.push(value)
    return [value, () => {}]
  },
  useRef: (initial) => ({ current: initial }),
  /** 真的执行 effect：否则配置页的加载逻辑（远程命名空间解析）永远测不到。 */
  useEffect: (fn) => {
    try {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : undefined
    } catch {
      return undefined
    }
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/* ---------------------------------------------------------------- 桩环境 */

let loaded
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }
const styles = []
globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild: (node) => styles.push(node) } }

await import(pathToFileURL(`${ROOT}/client.js`).href)

const packageName = JSON.parse(await readFile(`${ROOT}/package.json`, 'utf8')).name
check('模块以正确的 id 注册（必须等于包名）', loaded?.id === packageName, `id=${loaded?.id} 包名=${packageName}`)
check('导出 factory 函数', typeof loaded?.factory === 'function', typeof loaded?.factory)

const plugin = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`client.js 不应 require 其他模块，实际请求了 ${specifier}`)
})

check('插件声明 inject', Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('locale'), JSON.stringify(plugin.inject))

/* ---------------------------------------------------------------- 桩客户端 ctx */

const effects = []
const dictionaries = []
const registrations = []

const fakeCtx = {
  effect(fn, label) {
    effects.push(label)
    const cleanup = fn()
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  locale: {
    register(ns, dicts) { dictionaries.push({ ns, dicts }); return () => {} },
    bind: (ns) => (key) => `t:${ns}:${key}`,
  },
  slots: {
    inject(key, callback) {
      const list = []
      const iterator = callback()
      if (iterator !== undefined && typeof iterator[Symbol.iterator] === 'function') {
        for (const item of iterator) list.push(item)
      }
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  get(name) {
    return name === 'locale' ? this.locale : undefined
  },
}

plugin.apply(fakeCtx)

check('注册了样式与词典两个 effect', effects.length >= 2, effects.join(','))
check('词典覆盖 zh 与 en', dictionaries.length === 1 && Boolean(dictionaries[0].dicts.zh) && Boolean(dictionaries[0].dicts.en), JSON.stringify(dictionaries.map((d) => Object.keys(d.dicts))))

const toolviews = registrations.filter((entry) => entry.options.name === 'tool.call.toolview')
const sections = registrations.filter((entry) => entry.options.name === 'settings.section')

check('注册了 2 个工具视图', toolviews.length === 2, toolviews.map((t) => t.options.key).join(','))
check('工具视图键为 image_generate / image_edit', toolviews.map((t) => t.options.key).sort().join(',') === 'image_edit,image_generate', toolviews.map((t) => t.options.key).join(','))
check('工具视图**不**声明 tool.call.images 子插槽（它已被内置 read_image 卡片声明，重复声明会整条注册失败）', toolviews.every((t) => t.options.children === undefined), JSON.stringify(toolviews[0]?.options.children))
check('工具视图设置了 locale 命名空间', toolviews.every((t) => t.options.locale === 'dsh-image-bridge'), String(toolviews[0]?.options.locale))

check('注册了 1 个设置页', sections.length === 1, String(sections.length))
check('设置页 id 与 order 合法', sections[0]?.options.id === 'dsh-image-bridge-config' && typeof sections[0]?.options.order === 'number', JSON.stringify(sections[0]?.options))
check('设置页用负优先级遮蔽旧注册（列表插槽同 id 重复注册会抛错）', sections[0]?.options.priority === -1, String(sections[0]?.options.priority))
check('设置页 label 是函数（跟随语言切换）', typeof sections[0]?.options.label === 'function', typeof sections[0]?.options.label)
check('设置页声明 locale', sections[0]?.options.locale === 'dsh-image-bridge', String(sections[0]?.options.locale))

/* ---------------------------------------------------------------- 组件直接调用 */

/**
 * 注册体外面包了一层错误边界，这里拆开它，直接调用内部真正的组件函数。
 * 同时验证边界本身：子组件抛错时必须显示原因，而不是白屏。
 */
function invoke(component, props) {
  hookState = []
  const outer = component(props)
  const inner = outer !== null && typeof outer === 'object' && outer.props !== undefined ? outer.props.children : undefined
  if (inner !== null && typeof inner === 'object' && typeof inner.type === 'function') {
    hookState = []
    return { element: inner.type(inner.props), boundary: outer.type }
  }
  return { element: outer, boundary: undefined }
}

const ImageResultRow = toolviews[0].component
const loadedAttachments = []
const commonProps = {
  t: undefined,
  toolName: 'image_generate',
  loadImage: (attachment) => { loadedAttachments.push(attachment); return Promise.resolve('data:image/png;base64,AAAA') },
}

let crashed = null
let boundaryType
let successCardText = ''
try {
  // 运行中：块还没有 kind
  boundaryType = invoke(ImageResultRow, { ...commonProps, phase: 'start', block: { phase: 'start', args: { prompt: '一只猫' } } }).boundary
  // 已结算且成功：meta 带图片引用
  successCardText = JSON.stringify(invoke(ImageResultRow, {
    ...commonProps,
    phase: 'result',
    block: {
      kind: 'tool-result',
      isError: false,
      content: [{ type: 'text', text: '<generated_images/>' }],
      meta: { model: 'gpt-image-1', prompt: '一只猫', imageCapable: true, images: [{ attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }], savedPaths: ['E:\\w\\generated-images\\a.png'] },
    },
  }).element)
  // 失败
  invoke(ImageResultRow, { ...commonProps, phase: 'result', block: { kind: 'tool-result', isError: true, content: [{ type: 'text', text: '图片接口返回 401' }] } })
  // 结构异常：不应抛错
  invoke(ImageResultRow, { ...commonProps, phase: 'result', block: { kind: 'tool-result', isError: false, content: [] } })
  invoke(ImageResultRow, { toolName: 'image_edit' })
  invoke(ImageResultRow, { toolName: 'image_edit', phase: 'start', block: null })
} catch (error) {
  crashed = error
}
check('卡片组件在所有状态下都不抛错', crashed === null, crashed === null ? '' : String(crashed?.stack ?? crashed))
check('成功态渲染出图片元素（自带渲染，不走被占用的子插槽）', successCardText.includes('dib-gallery'), successCardText.slice(0, 200))

if (typeof boundaryType === 'function') {
  const healthy = new boundaryType({ children: 'child' })
  healthy.state = { error: null }
  const healthyOut = healthy.render()
  const broken = new boundaryType({ children: 'child' })
  broken.state = { error: new Error('boom') }
  const brokenOut = broken.render()
  const text = JSON.stringify(brokenOut)
  check('错误边界正常时透传子节点', healthyOut === 'child', String(healthyOut))
  check('错误边界在异常时显示原因而不是白屏', text.includes('boom') && text.includes('渲染失败'), text.slice(0, 200))
} else {
  check('取到了错误边界类型', false, '注册体外层不是边界')
}

const ConfigPage = sections[0].component
let pageElement
let pageCrash = null
try {
  pageElement = invoke(ConfigPage, { t: undefined, close: () => {}, __ctx: fakeCtx }).element
} catch (error) {
  pageCrash = error
}
check('设置页首屏不抛错', pageCrash === null, pageCrash === null ? '' : String(pageCrash?.stack ?? pageCrash))
check('设置页返回了元素', pageElement !== null && typeof pageElement === 'object', typeof pageElement)

/* 不可用的 Host 服务下必须退化成提示，而不是抛错 */
let degraded = null
try {
  const noRemote = { ...fakeCtx, get: () => undefined }
  degraded = invoke(ConfigPage, { t: undefined, close: () => {}, __ctx: noRemote }).element
} catch (error) {
  degraded = error
}
check('缺少 remote 服务时退化为提示而不是崩溃', degraded !== null && !(degraded instanceof Error), degraded instanceof Error ? String(degraded.message) : '')

/* ------------------------------------------------------------------ *
 * 远程命名空间解析：真实形状的守卫
 *
 * `ctx.get('remote')` 返回的对象受 Cordis 属性访问守卫保护——对未在 inject 里声明
 * 的服务取属性会抛 `cannot get property "remote.settings" without inject`。
 * 注册体在闭包里捕获 `apply(ctx)` 的 ctx，所以这里用指定的客户端 ctx 重新加载一次
 * 插件，再取出它注册的设置页组件。
 * ------------------------------------------------------------------ */

/** 用指定的客户端 ctx 加载插件，返回它注册的设置页组件。 */
function sectionComponentWith(clientCtx) {
  const records = []
  const ctx = {
    get: clientCtx.get,
    locale: fakeCtx.locale,
    effect: (fn) => {
      try {
        const cleanup = fn()
        return typeof cleanup === 'function' ? cleanup : undefined
      } catch {
        return undefined
      }
    },
    slots: {
      inject(_key, callback) {
        const iterator = callback()
        if (iterator !== undefined && typeof iterator[Symbol.iterator] === 'function') {
          for (const _item of iterator) { /* 只需要消费掉注册 */ }
        }
        return () => {}
      },
      register(options, component) {
        records.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  return records.find((entry) => entry.options.name === 'settings.section')?.component
}

function makeNamespace(label, calls) {
  return {
    describe: async () => {
      calls.push(`${label}:describe`)
      return {
        ok: true,
        value: {
          writable: true,
          namespaces: [{ ns: 'image-bridge-host', value: { baseUrl: 'http://127.0.0.1:8799/v1', model: 'mock-image', size: '512x512' }, revision: 1 }],
        },
      }
    },
    update: async () => { calls.push(`${label}:update`); return { ok: true, value: {} } },
  }
}

/* ① 服务直接以 "remote.settings" 为键：ctx.get() 不触发守卫。 */
{
  const calls = []
  const component = sectionComponentWith({
    get(name) {
      if (name === 'remote.settings') return makeNamespace('direct', calls)
      if (name === 'remote.credentials') return makeNamespace('cred', calls)
      return undefined
    },
  })
  hookState = []
  invoke(component, { t: undefined, close: () => {} })
  await new Promise((done) => setTimeout(done, 20))
  check('命名空间以服务名注册时可直接 get 到', calls.includes('direct:describe'), JSON.stringify(calls))
}

/* ② 只有网关对象、且属性访问被守卫拒绝：必须走 gateway.get()。 */
{
  const calls = []
  const gateway = {
    get: (name) => (name === 'settings' ? makeNamespace('viaGet', calls) : name === 'credentials' ? makeNamespace('cred', calls) : undefined),
    get settings() { throw new Error('cannot get property "remote.settings" without inject') },
    get credentials() { throw new Error('cannot get property "remote.credentials" without inject') },
  }
  const component = sectionComponentWith({
    get(name) {
      return name === 'remote' ? gateway : undefined
    },
  })
  hookState = []
  invoke(component, { t: undefined, close: () => {} })
  await new Promise((done) => setTimeout(done, 20))
  check('属性访问被守卫拒绝时仍能解析出命名空间（走 gateway.get）', calls.includes('viaGet:describe'), JSON.stringify(calls))
}

/* ------------------------------------------------------------------ *
 * 新 UI：提供商卡片列表 / 编辑面板 / 模型选择
 *
 * 桩 React 不会重渲染，所以这里用两个手段把状态摆到位：
 *   ① `__initial` 注入已载入的页面状态（生产代码里只有本脚本用它）；
 *   ② 直接调用元素树里按钮的 onClick / 表单的 onSubmit，再断言真实发出的请求。
 * ------------------------------------------------------------------ */

/** 记录插件发出的每一次 HTTP 调用：RPC 与诊断日志都在这里。 */
const rpcCalls = []

/*
 * 真实对照夹具：用户那把 Key 的 /models 里确实有这些名字。
 * 前 9 个是生图模型，后 11 个是语言 / 向量 / 语音模型——筛选规则必须把它们挡住。
 */
const IMAGE_MODELS = [
  'qwen-image-2.1-pro',
  'qwen-image-3.0-pro',
  'qwen-image-3.0',
  'qwen-image-2.0-pro',
  'qwen-image-2.0-2026-03-03',
  'qwen-image-2.0-pro-2026-04-22',
  'wan2.7-image',
  'wan2.7-image-pro',
  'z-image-turbo',
]
const NON_IMAGE_MODELS = [
  'qwen3.8-max-0902',
  'qwen3.8-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-pro',
  'kimi-k3',
  'glm-5.3',
  'qwen3.7-text-embedding-flash',
  'qwen3.7-text-rerank',
  'qwen-audio-3.1-realtime-plus',
  'qwen3.8-omni-flash-realtime',
  'qwen-mt-uni',
]
const ALL_MODELS = [...IMAGE_MODELS, ...NON_IMAGE_MODELS]

/** 下拉里「手动输入…」的保留取值（必须与 client.js 的 MANUAL_MODEL_VALUE 一致）。 */
const MANUAL_MODEL_VALUE = '__dib_manual__'

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  rpcCalls.push({ url: String(url), method: body.method, payload: body.payload ?? {} })
  // test 的返回体按 Host 的新契约带上 models（在 value.models 这一层）。
  const result = body.method === 'models'
    ? { ok: true, value: { models: ALL_MODELS } }
    : body.method === 'test'
      ? { ok: true, value: { ok: true, message: '连接成功：GET .../models → 200', models: ALL_MODELS } }
      : { ok: true, value: { ok: true, message: 'HTTP 200' } }
  return {
    ok: true,
    status: 200,
    json: async () => ({ type: 'server-response', rpcId: body.rpcId, result }),
  }
}
const logPayloads = () => JSON.stringify(rpcCalls.filter((call) => call.url.endsWith('/log')))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * 展开元素树。
 *
 * 函数组件（不是类组件）直接调用以展开，这样断言看到的是真正的 DOM 形状；
 * 类组件（错误边界）跳过——它的渲染另有断言。
 *
 * 传了 `session` 时（见 createSession）：函数组件与类组件都会用会话的持久化 hook
 * 展开，路径用于给每个组件实例定位状态槽。
 */
function walk(node, visit, depth, session, path) {
  const level = depth ?? 0
  const at = path ?? 'root'
  if (node === null || node === undefined || typeof node === 'boolean' || level > 40) return
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, visit, level + 1, session, session === undefined ? undefined : `${at}.${index}`))
    return
  }
  if (typeof node !== 'object') {
    visit(node)
    return
  }
  visit(node)
  if (typeof node.type === 'function') {
    const isClass = node.type.prototype !== undefined && typeof node.type.prototype.render === 'function'
    if (session === undefined) {
      if (isClass) return
      try {
        walk(node.type(node.props), visit, level + 1)
      } catch {
        /* 展开不了的组件跳过即可，别让断言自己崩掉 */
      }
      return
    }
    session.enter(node, at, () => {
      try {
        if (isClass) {
          const instance = new node.type(node.props)
          walk(instance.render(), visit, level + 1, session, at)
          return
        }
        walk(node.type(node.props), visit, level + 1, session, at)
      } catch {
        /* 展开失败的组件跳过即可 */
      }
    })
    return
  }
  if (node.props !== undefined) {
    const children = node.props.children
    if (Array.isArray(children)) children.forEach((child, index) => walk(child, visit, level + 1, session, session === undefined ? undefined : `${at}.${index}`))
    else walk(children, visit, level + 1, session, session === undefined ? undefined : `${at}.c`)
  }
}

function textOfElement(element) {
  let text = ''
  walk(element, (item) => {
    if (typeof item === 'string') text += `${item} `
  })
  return text.trim()
}

function treeOf(element, session) {
  const tree = { nodes: [], buttons: [], forms: [], classes: [], text: '', buttonTexts: [] }
  const texts = []
  const collect = (item) => {
    if (typeof item === 'string') {
      texts.push(item)
      return
    }
    if (item === null || typeof item !== 'object') return
    tree.nodes.push(item)
    if (typeof item.props?.className === 'string') tree.classes.push(item.props.className)
    if (item.type === 'button') tree.buttons.push(item)
    if (item.type === 'form') tree.forms.push(item)
  }
  if (session === undefined) walk(element, collect)
  else session.run(() => walk(element, collect, 0, session, 'root'))
  tree.text = texts.join(' ')
  tree.buttonTexts = tree.buttons.map((button) => textOfElement(button))
  return tree
}

/**
 * 一个极小的有状态渲染会话：点一下、界面真的会跟着变。
 *
 * 桩 React 的 `useState` 是无状态的（setState 是空函数），所以「点列表按钮 → 下拉同步」
 * 这类断言没法用一次性渲染证明。这里把 `useState` 临时换成按组件实例持久化的版本
 * （实例用「组件名 + key 或树内路径」定位），`useEffect` 换成**只在挂载那次执行**
 * （载入逻辑要把 remotes.current 填上，重渲染则不该重跑副作用），渲染完立刻还原。
 * 既有断言继续走 `invoke()`，完全不受影响。
 */
function createSession(component, props) {
  const stores = new Map()
  let cursor = null
  const session = {
    props,
    component,
    element: null,
    /** 在打了 hook 补丁的环境里执行一段代码。 */
    run(fn) {
      const savedState = React.useState
      const savedEffect = React.useEffect
      const savedRef = React.useRef
      React.useState = (initial) => {
        const store = cursor
        const index = store.index
        store.index += 1
        if (!(index in store.hooks)) store.hooks[index] = typeof initial === 'function' ? initial() : initial
        return [store.hooks[index], (next) => {
          store.hooks[index] = typeof next === 'function' ? next(store.hooks[index]) : next
        }]
      }
      // ref 也要跨渲染保留：remotes.current 就是靠它记住远程命名空间的。
      React.useRef = (initial) => {
        const store = cursor
        const index = store.index
        store.index += 1
        if (!(index in store.refs)) store.refs[index] = { current: initial }
        return store.refs[index]
      }
      React.useEffect = (effect) => {
        const store = cursor
        const index = store.index
        store.index += 1
        if (store.effects === undefined) store.effects = new Set()
        if (store.effects.has(index)) return undefined
        store.effects.add(index)
        try {
          return effect()
        } catch {
          return undefined
        }
      }
      try {
        return fn()
      } finally {
        React.useState = savedState
        React.useEffect = savedEffect
        React.useRef = savedRef
      }
    },
    /** 进入一个组件实例：定位/创建它的状态槽，重置 hook 游标。 */
    enter(node, path, fn) {
      const name = typeof node.type.name === 'string' && node.type.name !== '' ? node.type.name : 'anonymous'
      const key = `${name}#${node.props?.key ?? path}`
      let store = stores.get(key)
      if (store === undefined) {
        store = { hooks: [], index: 0, effects: new Set(), refs: {} }
        stores.set(key, store)
      }
      store.index = 0
      const saved = cursor
      cursor = store
      try {
        return fn()
      } finally {
        cursor = saved
      }
    },
    /** 渲染一次并展开成元素树（hook 状态跨调用保留）。 */
    tree() {
      return this.run(() => {
        this.element = this.component(this.props)
        return treeOf(this.element, this)
      })
    },
    /** 触发一个事件处理函数（onClick / onChange / onSubmit…）；缺失时返回 false，交给断言去报。 */
    fire(handler, event) {
      if (typeof handler !== 'function') return false
      handler(event ?? { preventDefault() {}, target: { value: '', checked: false } })
      return true
    },
    click(node) {
      this.fire(node?.props?.onClick)
    },
    change(node, value) {
      this.fire(node?.props?.onChange, { target: { value, checked: false } })
    },
    submit(form) {
      this.fire(form?.props?.onSubmit, { preventDefault() {} })
    },
  }
  return session
}

const selectById = (tree, id) => tree.nodes.find((node) => node.type === 'select' && node.props?.id === id)
const optionValuesOf = (select) => {
  if (select === undefined) return []
  const children = Array.isArray(select.props.children) ? select.props.children : [select.props.children]
  return children.filter((child) => child !== null && typeof child === 'object').map((child) => String(child.props?.value ?? ''))
}
const inputById = (tree, id) => tree.nodes.find((node) => node.type === 'input' && node.props?.id === id)
/** 下拉里除「空选项」与「手动输入…」之外的真实模型名。 */
const modelOptionsOf = (tree, id) => optionValuesOf(selectById(tree, id)).filter((value) => value !== '' && value !== MANUAL_MODEL_VALUE)

const buttonByText = (tree, label) => tree.buttons.find((button) => textOfElement(button).includes(label))
const hasClass = (tree, name) => tree.classes.some((value) => value.split(' ').includes(name))

/** 带记录的远程上下文：settings 记 update，credentials 记 set 与 describe。 */
function sectionWithRecording(settingsValue, options) {
  const opts = options ?? {}
  const updates = []
  const credentialSets = []
  const describedRefs = []
  const settings = {
    describe: async () => ({ ok: true, value: { writable: true, namespaces: [{ ns: 'image-bridge-v4', value: settingsValue, revision: 1 }] } }),
    update: async (ns, patch, revision) => { updates.push({ ns, patch, revision }); return { ok: true, value: {} } },
  }
  const credentials = {
    describe: async (refs) => {
      describedRefs.push(refs)
      const value = {}
      for (const ref of refs) value[ref] = { configured: (opts.configuredRefs ?? []).includes(ref), writable: true }
      return { ok: true, value }
    },
    set: async (ref, value) => { credentialSets.push({ ref, value }); return { ok: true } },
  }
  const component = sectionComponentWith({
    get(name) {
      if (name === 'remote.settings') return settings
      if (name === 'remote.credentials') return credentials
      return undefined
    },
  })
  return { component, updates, credentialSets, describedRefs }
}

const providerRecord = {
  id: 'zhipu',
  label: '智谱',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  keyRef: 'DSH_IMAGE_BRIDGE_KEY_ZHIPU',
  models: ['cogview-4'],
  imageModel: 'cogview-4',
  editModel: '',
}
const pageWith = (bundle, initial) => treeOf(invoke(bundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', ...initial },
}).element)

/* 空列表：虚线「添加」入口 */
const emptyBundle = sectionWithRecording({ size: '1024x1024' })
const emptyTree = pageWith(emptyBundle, { providers: [], activeProviderId: '' })
check(
  '未配置提供商时列表底部给出虚线「添加模型提供商」入口',
  hasClass(emptyTree, 'dib-add-btn') && emptyTree.text.includes('添加模型提供商'),
  emptyTree.classes.join(' | ').slice(0, 200),
)
check('未配置提供商时给出空态提示', emptyTree.text.includes('还没有配置模型提供商'), emptyTree.text.slice(0, 160))

/* 卡片列表：名称 / 当前模型 / 状态点 / 编辑 */
const cardBundle = sectionWithRecording({ size: '1024x1024' })
const cardTree = pageWith(cardBundle, { providers: [providerRecord], activeProviderId: 'zhipu', testState: { zhipu: 'ok' }, keyConfigured: { zhipu: true } })
const failTree = pageWith(cardBundle, { providers: [providerRecord], activeProviderId: 'zhipu', testState: { zhipu: 'fail' } })
const idleTree = pageWith(cardBundle, { providers: [providerRecord], activeProviderId: 'zhipu' })
check(
  '卡片显示名称、当前模型与编辑按钮',
  hasClass(cardTree, 'dib-card') && cardTree.text.includes('智谱') && cardTree.text.includes('cogview-4') && buttonByText(cardTree, '编辑') !== undefined,
  cardTree.text.slice(0, 200),
)
check(
  '连接状态点区分成功 / 失败 / 未测试',
  hasClass(cardTree, 'dib-dot-ok') && hasClass(failTree, 'dib-dot-fail')
    && hasClass(idleTree, 'dib-dot') && !hasClass(idleTree, 'dib-dot-ok') && !hasClass(idleTree, 'dib-dot-fail'),
  JSON.stringify({ ok: cardTree.classes, fail: failTree.classes, idle: idleTree.classes }).slice(0, 240),
)
check(
  '卡片标出当前使用的提供商与密钥状态',
  cardTree.text.includes('当前使用') && cardTree.text.includes('密钥已配置') && idleTree.text.includes('密钥未配置'),
  cardTree.text.slice(0, 200),
)

/* 编辑面板：字段 + 两个动作按钮 */
const editorInitial = {
  id: 'zhipu',
  keyRef: 'DSH_IMAGE_BRIDGE_KEY_ZHIPU',
  label: '智谱',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  models: ['m-alpha', 'm-beta'],
  imageModel: 'm-alpha',
  editModel: 'm-beta',
}
const editorTree = pageWith(cardBundle, {
  providers: [providerRecord],
  activeProviderId: 'zhipu',
  keyConfigured: { zhipu: true },
  editor: { mode: 'edit', initial: editorInitial },
})
check(
  '编辑面板同时给出「测试连接」与「获取可用模型」两个按钮',
  hasClass(editorTree, 'dib-editor') && buttonByText(editorTree, '测试连接') !== undefined && buttonByText(editorTree, '获取可用模型') !== undefined,
  editorTree.buttonTexts.join(','),
)
check(
  '编辑面板有保存 / 取消，并在已配置密钥时提示「已保存密钥」',
  editorTree.text.includes('已保存密钥') && buttonByText(editorTree, '保存') !== undefined && buttonByText(editorTree, '取消') !== undefined,
  editorTree.buttonTexts.join(','),
)

/* 模型选择列表 */
const modelRows = editorTree.nodes.filter((node) => node.props?.className === 'dib-model-row')
const rowButtons = (row) => (row === undefined ? [] : row.props.children.filter((child) => child !== null && typeof child === 'object' && child.type === 'button'))
const alphaRow = modelRows.find((row) => textOfElement(row).includes('m-alpha'))
const betaRow = modelRows.find((row) => textOfElement(row).includes('m-beta'))
check(
  '拉取到模型后以可选列表呈现，每个模型两个角色按钮',
  hasClass(editorTree, 'dib-model-list') && modelRows.length === 2 && rowButtons(alphaRow).length === 2 && rowButtons(betaRow).length === 2,
  `rows=${modelRows.length}`,
)
check(
  '列表标出当前生图 / 改图模型（aria-pressed 反映选择）',
  rowButtons(alphaRow)[0]?.props['aria-pressed'] === 'true'
    && rowButtons(alphaRow)[1]?.props['aria-pressed'] === 'false'
    && rowButtons(betaRow)[0]?.props['aria-pressed'] === 'false'
    && rowButtons(betaRow)[1]?.props['aria-pressed'] === 'true',
  JSON.stringify(rowButtons(alphaRow).map((button) => button.props['aria-pressed'])),
)

/* 两个动作按钮真的走 Host RPC */
rpcCalls.length = 0
buttonByText(editorTree, '获取可用模型').props.onClick()
await sleep(30)
const modelsCall = rpcCalls.find((call) => call.method === 'models')
check(
  '「获取可用模型」调用 Host 的 models RPC，payload 为 baseUrl/apiKey',
  modelsCall !== undefined && modelsCall.url.endsWith('/dsh-image-bridge/models')
    && modelsCall.payload.baseUrl === editorInitial.baseUrl && typeof modelsCall.payload.apiKey === 'string',
  JSON.stringify(modelsCall ?? null).slice(0, 200),
)
rpcCalls.length = 0
buttonByText(editorTree, '测试连接').props.onClick()
await sleep(30)
const testCall = rpcCalls.find((call) => call.method === 'test')
check(
  '「测试连接」调用 Host 的 test RPC',
  testCall !== undefined && testCall.payload.baseUrl === editorInitial.baseUrl,
  JSON.stringify(rpcCalls.map((call) => call.method)),
)
/*
 * 打开的不是当前生效的那张卡片时，输入框是空的：此时只能靠 keyRef 让 Host
 * 找到这张卡片自己的密钥，否则它会退回去用当前生效服务商的密钥，必然 401。
 */
check(
  'keyDraft 为空时 test / models 都带上卡片自己的 keyRef（否则会拿错服务商的密钥）',
  editorInitial.keyRef !== '' && editorInitial.keyDraft === undefined
    && testCall?.payload.keyRef === editorInitial.keyRef
    && testCall?.payload.apiKey === ''
    && modelsCall?.payload.keyRef === editorInitial.keyRef
    && modelsCall?.payload.apiKey === '',
  JSON.stringify({ test: testCall?.payload, models: modelsCall?.payload }).slice(0, 240),
)

/* ------------------------------------------------------------------ *
 * 浮层界面 + 测试连接自动带出模型 + 生图模型筛选（真实夹具逐条比对）
 * ------------------------------------------------------------------ */

/** 模型行里的模型名（span.dib-model-id 的文本）。 */
const rowIdOf = (row) => {
  const children = Array.isArray(row?.props?.children) ? row.props.children : []
  const span = children.find((child) => child !== null && typeof child === 'object' && child.props?.className === 'dib-model-id')
  return span === undefined ? '' : textOfElement(span).trim()
}
const modelIdsOf = (tree) => tree.nodes.filter((node) => node.props?.className === 'dib-model-row').map(rowIdOf)
/** 打开编辑浮层时带进去的记录（可覆盖任何字段）。 */
const editorInitialFor = (models, extra) => ({
  id: 'zhipu',
  keyRef: 'DSH_IMAGE_BRIDGE_KEY_ZHIPU',
  label: '智谱',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  models,
  imageModel: 'qwen-image-3.0-pro',
  editModel: '',
  ...(extra ?? {}),
})
/** 渲染一个打开着编辑浮层的设置页；`models` 与 `extra` 直接进 `initial`。 */
const editorWith = (models, extra) => pageWith(cardBundle, {
  providers: [providerRecord],
  activeProviderId: 'zhipu',
  editor: { mode: 'edit', initial: editorInitialFor(models, extra) },
})

/* ① 独立浮层：遮罩 + 居中卡片 + 标题 + 关闭/取消 */
check(
  '编辑界面是独立浮层：遮罩 + 居中卡片 + dialog 语义',
  hasClass(editorTree, 'dib-overlay') && hasClass(editorTree, 'dib-overlay-mask')
    && hasClass(editorTree, 'dib-editor')
    && editorTree.nodes.some((node) => node.props?.role === 'dialog' && node.props['aria-modal'] === 'true'),
  editorTree.classes.join(' | ').slice(0, 220),
)
check(
  '浮层有标题、右上角关闭按钮与取消/保存',
  editorTree.text.includes('编辑模型提供商')
    && editorTree.buttons.some((button) => button.props['aria-label'] === '关闭')
    && buttonByText(editorTree, '取消') !== undefined
    && buttonByText(editorTree, '保存') !== undefined,
  editorTree.buttonTexts.join(','),
)
check(
  '遮罩自身可点关闭',
  editorTree.nodes.some((node) => node.props?.className === 'dib-overlay-mask' && typeof node.props.onClick === 'function'),
)
rpcCalls.length = 0
editorTree.buttons.find((button) => button.props['aria-label'] === '关闭').props.onClick()
await sleep(20)
check(
  '点关闭会收起浮层（并留一条日志，回到卡片列表）',
  logPayloads().includes('编辑浮层已关闭'),
  logPayloads().slice(0, 200),
)
check(
  '未打开浮层时没有遮罩，卡片列表与「添加」入口照旧',
  !hasClass(cardTree, 'dib-overlay') && hasClass(cardTree, 'dib-card') && hasClass(cardTree, 'dib-add-btn'),
  cardTree.classes.join(' | ').slice(0, 180),
)
/* 配置行不可写时不能把关不掉的浮层盖在设置页上 */
const readOnlyTree = pageWith(cardBundle, {
  writable: false,
  providers: [providerRecord],
  activeProviderId: 'zhipu',
  editor: { mode: 'edit', initial: editorInitial },
})
const readOnlyClose = readOnlyTree.buttons.find((button) => button.props['aria-label'] === '关闭')
const readOnlyCancel = buttonByText(readOnlyTree, '取消')
const readOnlySave = readOnlyTree.buttons.find((button) => button.props.type === 'submit')
check(
  '配置行不可写时浮层仍关得掉（只有保存被禁用）',
  readOnlyClose !== undefined && readOnlyClose.props.disabled !== true
    && readOnlyCancel !== undefined && readOnlyCancel.props.disabled !== true
    && readOnlySave !== undefined && readOnlySave.props.disabled === true,
  JSON.stringify({
    close: readOnlyClose?.props?.disabled ?? null,
    cancel: readOnlyCancel?.props?.disabled ?? null,
    save: readOnlySave?.props?.disabled ?? null,
  }),
)

/* ② 测试连接成功即采用返回的模型（models 在 value.models 这一层） */
const autoTree = editorWith([], { imageModel: '', editModel: '' })
rpcCalls.length = 0
buttonByText(autoTree, '测试连接').props.onClick()
await sleep(30)
const autoTestCall = rpcCalls.find((call) => call.method === 'test')
const autoDetailCall = [...rpcCalls].reverse().find((entry) => entry.payload.message === '测试连接结果')
const autoDetail = autoDetailCall === undefined ? undefined : JSON.parse(String(autoDetailCall.payload.detail))
check(
  '测试连接成功后自动采用返回的模型列表（一次往返，不再需要点「获取可用模型」）',
  autoTestCall !== undefined && autoDetail?.returnedModels === 20 && autoDetail?.imageModels === 9
    && autoDetail?.adoptedModels === 20
    && rpcCalls.every((call) => call.method !== 'models'),
  JSON.stringify({ send: autoTestCall?.payload ?? null, detail: autoDetail ?? null }).slice(0, 300),
)

/* ③ 默认只显示生图模型：真实夹具逐条比对 */
const fixtureTree = editorWith(ALL_MODELS)
const shownIds = modelIdsOf(fixtureTree)
const missingImages = IMAGE_MODELS.filter((model) => !shownIds.includes(model))
const leakedNonImages = NON_IMAGE_MODELS.filter((model) => shownIds.includes(model))
check(
  '默认只显示生图模型：9 个生图模型全在，11 个语言/向量/语音模型一个都不在',
  shownIds.length === IMAGE_MODELS.length && missingImages.length === 0 && leakedNonImages.length === 0,
  JSON.stringify({ shown: shownIds.length, missingImages, leakedNonImages }).slice(0, 320),
)
check(
  '筛选后给出「已显示 / 总数」与「已隐藏」提示',
  fixtureTree.text.includes('可用模型（9 / 20）') && fixtureTree.text.includes('已隐藏非生图模型： 11'),
  fixtureTree.text.slice(0, 260),
)

/* ④ 「显示全部模型」开关 */
const fullTree = editorWith(ALL_MODELS, { showAll: true })
const fullIds = modelIdsOf(fullTree)
const toggleBox = fullTree.nodes.find((node) => node.props?.type === 'checkbox')
check(
  '打开「显示全部模型」后完整列表出现（20 个，语言模型也在）',
  fullIds.length === ALL_MODELS.length
    && NON_IMAGE_MODELS.every((model) => fullIds.includes(model))
    && IMAGE_MODELS.every((model) => fullIds.includes(model)),
  JSON.stringify({ shown: fullIds.length }).slice(0, 200),
)
check(
  '开关是受控复选框，勾选状态来自界面状态',
  toggleBox !== undefined && toggleBox.props.checked === true && typeof toggleBox.props.onChange === 'function',
  JSON.stringify(toggleBox?.props?.checked ?? null),
)
check(
  '已有模型时按钮变成「重新获取可用模型」',
  (() => {
    const button = fullTree.buttons.find((entry) => entry.props['data-dib-action'] === 'fetch-models')
    return button !== undefined && textOfElement(button).trim() === '重新获取可用模型'
  })(),
  fullTree.buttonTexts.join(','),
)

/* ------------------------------------------------------------------ *
 * 生图 / 改图模型字段：下拉选择 + 手动输入 + 与列表同步
 * ------------------------------------------------------------------ */

const IMAGE_SELECT = 'dib-provider-image-model-select'
const EDIT_SELECT = 'dib-provider-edit-model-select'

/* ① 下拉选项就是筛选后的生图模型 */
const dropTree = editorWith(ALL_MODELS)
const dropImageOptions = modelOptionsOf(dropTree, IMAGE_SELECT)
const dropEditOptions = modelOptionsOf(dropTree, EDIT_SELECT)
check(
  '两个下拉的选项等于筛选后的生图模型（9 个，11 个语言/向量/语音模型不在里面）',
  dropImageOptions.length === IMAGE_MODELS.length
    && IMAGE_MODELS.every((model) => dropImageOptions.includes(model))
    && NON_IMAGE_MODELS.every((model) => !dropImageOptions.includes(model))
    && dropEditOptions.length === IMAGE_MODELS.length
    && NON_IMAGE_MODELS.every((model) => !dropEditOptions.includes(model)),
  JSON.stringify({ image: dropImageOptions.length, edit: dropEditOptions.length, leaked: NON_IMAGE_MODELS.filter((m) => dropImageOptions.includes(m)) }).slice(0, 260),
)
check(
  '下拉自带空选项与「手动输入…」，选中值来自同一份状态',
  optionValuesOf(selectById(dropTree, IMAGE_SELECT)).includes('')
    && optionValuesOf(selectById(dropTree, IMAGE_SELECT)).includes(MANUAL_MODEL_VALUE)
    && optionValuesOf(selectById(dropTree, EDIT_SELECT)).includes(MANUAL_MODEL_VALUE)
    && selectById(dropTree, IMAGE_SELECT)?.props.value === 'qwen-image-3.0-pro'
    && selectById(dropTree, EDIT_SELECT)?.props.value === ''
    && selectById(dropTree, IMAGE_SELECT)?.props.disabled === false,
  JSON.stringify({
    image: selectById(dropTree, IMAGE_SELECT)?.props.value,
    edit: selectById(dropTree, EDIT_SELECT)?.props.value,
    imageOptions: optionValuesOf(selectById(dropTree, IMAGE_SELECT)).length,
  }).slice(0, 240),
)

/* ② 勾「显示全部模型」后下拉选项扩展为全部 */
const fullDropTree = editorWith(ALL_MODELS, { showAll: true })
const fullDropOptions = modelOptionsOf(fullDropTree, IMAGE_SELECT)
check(
  '勾上「显示全部模型」后下拉选项扩展为全部 20 个',
  fullDropOptions.length === ALL_MODELS.length && NON_IMAGE_MODELS.every((model) => fullDropOptions.includes(model)),
  JSON.stringify({ options: fullDropOptions.length }).slice(0, 160),
)

/* ③ 没获取过模型时下拉禁用、给提示，手填通道仍在 */
const noModelsDropTree = editorWith([], { imageModel: '', editModel: '' })
check(
  '还没获取到模型时两个下拉禁用、给一行提示，手动输入仍然可用',
  selectById(noModelsDropTree, IMAGE_SELECT)?.props.disabled === true
    && selectById(noModelsDropTree, EDIT_SELECT)?.props.disabled === true
    && noModelsDropTree.text.includes('还没有获取到模型列表')
    && inputById(noModelsDropTree, 'dib-provider-image-model') !== undefined
    && inputById(noModelsDropTree, 'dib-provider-edit-model') !== undefined,
  JSON.stringify({
    imageDisabled: selectById(noModelsDropTree, IMAGE_SELECT)?.props.disabled ?? null,
    hint: noModelsDropTree.text.includes('还没有获取到模型列表'),
  }).slice(0, 200),
)

/* ④ 选「手动输入…」→ 出现文本框 → 手填的值真的写进 imageModel（走保存落盘验证） */
const manualBundle = sectionWithRecording({ size: '1024x1024' })
const manualSession = createSession(manualBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', providers: [providerRecord], activeProviderId: 'zhipu', editor: { mode: 'edit', initial: editorInitialFor(ALL_MODELS) } },
})
let manualTree = manualSession.tree()
manualSession.change(selectById(manualTree, IMAGE_SELECT), MANUAL_MODEL_VALUE)
manualTree = manualSession.tree()
const manualInput = inputById(manualTree, 'dib-provider-image-model')
check(
  '选「手动输入…」后下拉切到保留值，并出现手填文本框',
  selectById(manualTree, IMAGE_SELECT)?.props.value === MANUAL_MODEL_VALUE && manualInput !== undefined,
  JSON.stringify({ value: selectById(manualTree, IMAGE_SELECT)?.props.value ?? null, input: manualInput !== undefined }),
)
manualSession.change(manualInput, 'my-own-image-model')
manualTree = manualSession.tree()
manualSession.submit(manualTree.forms[0])
await sleep(30)
const manualSaved = manualBundle.updates[0]?.patch?.providers?.[0]
check(
  '手填的模型名写进 imageModel（保存的 providers 里就是它）',
  manualSaved !== undefined && manualSaved.imageModel === 'my-own-image-model',
  JSON.stringify(manualSaved ?? null).slice(0, 240),
)

/* ⑤ 点列表行的「生图」按钮 → 上方下拉同步（两处不分裂） */
const syncBundle = sectionWithRecording({ size: '1024x1024' })
const syncSession = createSession(syncBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', providers: [providerRecord], activeProviderId: 'zhipu', editor: { mode: 'edit', initial: editorInitialFor(ALL_MODELS, { imageModel: '' }) } },
})
let syncTree = syncSession.tree()
syncSession.change(selectById(syncTree, IMAGE_SELECT), MANUAL_MODEL_VALUE)
syncTree = syncSession.tree()
const wasManual = inputById(syncTree, 'dib-provider-image-model') !== undefined
const targetRow = syncTree.nodes
  .filter((node) => node.props?.className === 'dib-model-row')
  .find((row) => rowIdOf(row) === 'qwen-image-3.0')
const rowImageButton = targetRow?.props?.children.find((child) => child !== null && typeof child === 'object' && child.type === 'button' && textOfElement(child).trim() === '生图')
syncSession.click(rowImageButton)
const syncedTree = syncSession.tree()
check(
  '点列表行的「生图」后，上方生图下拉同步为该模型（并从手动输入切回来）',
  wasManual
    && rowImageButton !== undefined
    && selectById(syncedTree, IMAGE_SELECT)?.props.value === 'qwen-image-3.0'
    && inputById(syncedTree, 'dib-provider-image-model') === undefined,
  JSON.stringify({
    wasManual,
    value: selectById(syncedTree, IMAGE_SELECT)?.props.value ?? null,
    manualStillOpen: inputById(syncedTree, 'dib-provider-image-model') !== undefined,
  }),
)

/* 非法 keyRef（手改 profile 塞进来的）不能进 payload，按空处理并留一条 warn */
const badRefBundle = sectionWithRecording({ size: '1024x1024' })
const badRefProvider = { ...providerRecord, keyRef: 'bad ref!' }
const badRefTree = pageWith(badRefBundle, {
  providers: [badRefProvider],
  activeProviderId: 'zhipu',
  editor: { mode: 'edit', initial: { ...editorInitial, keyRef: 'bad ref!' } },
})
rpcCalls.length = 0
buttonByText(badRefTree, '获取可用模型').props.onClick()
await sleep(30)
const badRefModelsCall = rpcCalls.find((call) => call.method === 'models')
check(
  '非法 keyRef 不进 models payload（按空处理）并回报 warn',
  badRefModelsCall !== undefined && badRefModelsCall.payload.keyRef === ''
    && logPayloads().includes('凭据引用名不合法') && logPayloads().includes('"level":"warn"'),
  JSON.stringify({ call: badRefModelsCall?.payload ?? null, log: logPayloads().slice(0, 160) }).slice(0, 280),
)
rpcCalls.length = 0
buttonByText(badRefTree, '测试连接').props.onClick()
await sleep(30)
const badRefTestCall = rpcCalls.find((call) => call.method === 'test')
check(
  '非法 keyRef 不进 test payload（按空处理）',
  badRefTestCall !== undefined && badRefTestCall.payload.keyRef === '',
  JSON.stringify(badRefTestCall?.payload ?? null).slice(0, 200),
)
rpcCalls.length = 0
const badCardTree = pageWith(badRefBundle, { providers: [badRefProvider], activeProviderId: 'zhipu' })
buttonByText(badCardTree, '测试').props.onClick()
await sleep(30)
const badCardTestCall = rpcCalls.find((call) => call.method === 'test')
check(
  '卡片上的「测试」同样拦下非法 keyRef（按空处理）',
  badCardTestCall !== undefined && badCardTestCall.payload.keyRef === '',
  JSON.stringify(badCardTestCall?.payload ?? null).slice(0, 200),
)

/* 保存时归零非法 keyRef → 这张卡片不必删掉重建就能自愈（F-4 的最后一环） */
const healBundle = sectionWithRecording({ size: '1024x1024' })
const healTree = pageWith(healBundle, {
  providers: [badRefProvider],
  activeProviderId: 'zhipu',
  editor: {
    mode: 'edit',
    initial: { id: 'zhipu', label: '智谱', baseUrl: providerRecord.baseUrl, keyRef: 'bad ref!', models: [], imageModel: 'cogview-4', editModel: '' },
  },
})
healTree.forms[0].props.onSubmit({ preventDefault() {} })
await sleep(30)
const healedProvider = healBundle.updates[0]?.patch?.providers?.[0]
check(
  '保存一次即自愈：非法 keyRef 被改写为按 id 派生的合法引用名',
  healedProvider !== undefined && healedProvider.keyRef === 'DSH_IMAGE_BRIDGE_KEY_ZHIPU' && healedProvider.id === 'zhipu',
  JSON.stringify(healedProvider ?? null).slice(0, 240),
)

/* 保存：settings 写 providers/activeProviderId，credentials 写密钥 */
const saveBundle = sectionWithRecording({ size: '1024x1024' })
const secret = 'sk-unit-test-secret-value'
const saveTree = pageWith(saveBundle, {
  providers: [],
  activeProviderId: '',
  editor: {
    mode: 'add',
    initial: {
      label: 'My Provider',
      baseUrl: 'https://api.example.com/v1',
      keyRef: '',
      models: ['m-alpha'],
      imageModel: 'm-alpha',
      editModel: '',
      keyDraft: secret,
    },
  },
})
rpcCalls.length = 0
saveTree.forms[0].props.onSubmit({ preventDefault() {} })
await sleep(30)
const savedPatch = saveBundle.updates.length === 1 ? saveBundle.updates[0].patch : {}
const savedProvider = Array.isArray(savedPatch.providers) && savedPatch.providers.length === 1 ? savedPatch.providers[0] : {}
check(
  '保存把 providers 与 activeProviderId 写进 settings.update',
  saveBundle.updates.length === 1 && saveBundle.updates[0].ns === 'image-bridge-v4'
    && Array.isArray(savedPatch.providers) && savedPatch.providers.length === 1,
  JSON.stringify(saveBundle.updates).slice(0, 240),
)
check(
  'provider.id 由名称生成小写 slug，keyRef 按规则派生',
  savedProvider.id === 'my-provider' && savedProvider.keyRef === 'DSH_IMAGE_BRIDGE_KEY_MY_PROVIDER',
  JSON.stringify(savedProvider).slice(0, 240),
)
check('第一个提供商自动成为当前使用', savedPatch.activeProviderId === 'my-provider', JSON.stringify(savedPatch.activeProviderId))
check(
  'API Key 走 credentials.set，且不落进 settings patch',
  saveBundle.credentialSets.length === 1
    && saveBundle.credentialSets[0].ref === 'DSH_IMAGE_BRIDGE_KEY_MY_PROVIDER'
    && saveBundle.credentialSets[0].value === secret
    && !JSON.stringify(savedPatch).includes(secret),
  JSON.stringify(saveBundle.credentialSets).slice(0, 240),
)
check(
  '诊断日志只记密钥长度 / 是否配置，不含密钥明文',
  !logPayloads().includes(secret) && logPayloads().includes('keyLength'),
  logPayloads().slice(0, 240),
)

/* 切换当前使用的提供商 */
const switchBundle = sectionWithRecording({ size: '1024x1024' })
const secondProvider = {
  id: 'openai',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  keyRef: 'DSH_IMAGE_BRIDGE_KEY_OPENAI',
  models: [],
  imageModel: 'gpt-image-1',
  editModel: '',
}
const switchTree = pageWith(switchBundle, { providers: [providerRecord, secondProvider], activeProviderId: 'zhipu' })
const useButton = buttonByText(switchTree, '设为当前')
check(
  '非当前提供商的卡片上有「设为当前」按钮',
  useButton !== undefined && switchTree.text.includes('当前使用'),
  switchTree.buttonTexts.join(','),
)
useButton?.props.onClick()
await sleep(30)
check(
  '「设为当前」把 activeProviderId 落盘，且不动 providers',
  switchBundle.updates.length === 1 && switchBundle.updates[0].patch.activeProviderId === 'openai'
    && switchBundle.updates[0].patch.providers === undefined,
  JSON.stringify(switchBundle.updates).slice(0, 240),
)

/* 卡片上的「测试」同样要带这张卡片自己的 keyRef */
rpcCalls.length = 0
const cardTestButtons = switchTree.buttons.filter((button) => textOfElement(button) === '测试')
cardTestButtons[1]?.props.onClick()
await sleep(30)
const cardTestCall = rpcCalls.find((call) => call.method === 'test')
check(
  '卡片上的「测试」带上该卡片自己的 keyRef（第二张卡不会借第一张的密钥）',
  cardTestButtons.length === 2 && cardTestCall?.payload.keyRef === 'DSH_IMAGE_BRIDGE_KEY_OPENAI'
    && cardTestCall?.payload.baseUrl === secondProvider.baseUrl && cardTestCall?.payload.apiKey === '',
  JSON.stringify({ buttons: cardTestButtons.length, call: cardTestCall?.payload ?? null }).slice(0, 240),
)

/* 载入路径：桩 React 不重渲染，所以只看插件回报到 Host 日志的载入快照 */
function loadedReport() {
  const call = [...rpcCalls].reverse().find((entry) => entry.url.endsWith('/log') && entry.payload.message === '配置已载入')
  return call === undefined ? undefined : JSON.parse(String(call.payload.detail))
}

rpcCalls.length = 0
const legacyBundle = sectionWithRecording(
  { baseUrl: 'https://api.example.com/v1', model: 'cogview-4', editModel: '', size: '512x512' },
  { configuredRefs: ['DSH_IMAGE_BRIDGE_API_KEY'] },
)
invoke(legacyBundle.component, { t: undefined, close: () => {} })
await sleep(30)
const legacyLoaded = loadedReport()
check(
  '没有 providers 时把旧配置合成一张卡片（既有配置不丢，仍是当前使用）',
  legacyLoaded?.providers === 1 && legacyLoaded?.activeProviderId === 'default' && legacyLoaded?.keyConfigured === 1,
  JSON.stringify(legacyLoaded),
)
check(
  '凭据状态按 provider.keyRef 一次批量 describe（旧配置沿用旧引用名）',
  Array.isArray(legacyBundle.describedRefs[0]) && legacyBundle.describedRefs[0].includes('DSH_IMAGE_BRIDGE_API_KEY'),
  JSON.stringify(legacyBundle.describedRefs),
)

rpcCalls.length = 0
const storedBundle = sectionWithRecording({
  providers: [
    { id: 'Zhipu AI', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['cogview-4'], imageModel: 'cogview-4', editModel: '' },
    { label: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [], imageModel: '', editModel: '' },
  ],
  activeProviderId: 'not-there',
  size: '1024x1024',
})
invoke(storedBundle.component, { t: undefined, close: () => {} })
await sleep(30)
const storedLoaded = loadedReport()
check(
  '载入时按规则归一 provider.id，activeProviderId 失效时回退到第一个',
  storedLoaded?.providers === 2 && storedLoaded?.activeProviderId === 'zhipu-ai',
  JSON.stringify(storedLoaded),
)
check(
  '每个 provider 的凭据引用名由 id 派生（大小写 / 非字母数字都按规则转换）',
  JSON.stringify(storedBundle.describedRefs).includes('DSH_IMAGE_BRIDGE_KEY_ZHIPU_AI')
    && JSON.stringify(storedBundle.describedRefs).includes('DSH_IMAGE_BRIDGE_KEY_OPEN_BIGMODEL_CN'),
  JSON.stringify(storedBundle.describedRefs),
)

/* 载入时非法 keyRef 归零 → 回退到按 id 派生（保存一次即可自愈） */
const badStoredBundle = sectionWithRecording({
  providers: [{ id: 'zhipu', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyRef: 'bad ref!', models: [], imageModel: 'cogview-4', editModel: '' }],
  activeProviderId: 'zhipu',
  size: '',
})
invoke(badStoredBundle.component, { t: undefined, close: () => {} })
await sleep(30)
const badStoredRefs = JSON.stringify(badStoredBundle.describedRefs)
check(
  '载入时非法 keyRef 被归零并回退到按 id 派生（查询用的引用名合法）',
  badStoredRefs.includes('DSH_IMAGE_BRIDGE_KEY_ZHIPU') && !badStoredRefs.includes('bad ref!'),
  badStoredRefs.slice(0, 240),
)

/* 删除：两段式确认，确认后落盘 */
const removeBundle = sectionWithRecording({ size: '1024x1024' })
const removeTree = pageWith(removeBundle, { providers: [providerRecord], activeProviderId: 'zhipu', confirmDelete: 'zhipu' })
const confirmButton = buttonByText(removeTree, '确认删除')
check(
  '删除是两段式确认（确认删除 + 取消）',
  confirmButton !== undefined && buttonByText(removeTree, '取消') !== undefined,
  removeTree.buttonTexts.join(','),
)
confirmButton?.props.onClick()
await sleep(30)
check(
  '确认删除把 providers 清空并同时清掉 activeProviderId',
  removeBundle.updates.length === 1 && Array.isArray(removeBundle.updates[0].patch.providers)
    && removeBundle.updates[0].patch.providers.length === 0 && removeBundle.updates[0].patch.activeProviderId === '',
  JSON.stringify(removeBundle.updates).slice(0, 240),
)

/* 硬约束：主题令牌与双语文案 */
const cssText = styles.map((style) => style.textContent).join('')
check(
  '样式只用主题令牌，没有硬编码颜色',
  !/#[0-9a-fA-F]{3,8}/u.test(cssText) && !/rgba?\(/u.test(cssText) && !/hsla?\(/u.test(cssText),
  cssText.slice(0, 160),
)
const zhKeys = Object.keys(dictionaries[0].dicts.zh).sort()
const enKeys = Object.keys(dictionaries[0].dicts.en).sort()
check('新增文案 zh 与 en 一一对应', zhKeys.join(',') === enKeys.join(','), `zh=${zhKeys.length} en=${enKeys.length}`)

const failed = results.filter((entry) => !entry.ok)
console.log(`\nSUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
process.exitCode = failed.length === 0 ? 0 : 1
