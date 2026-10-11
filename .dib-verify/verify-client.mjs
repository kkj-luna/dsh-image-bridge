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
import { PLUGIN_DIR } from './dsh-paths.mjs'

const ROOT = PLUGIN_DIR
const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'ok   ' : 'FAIL '} ${name}${condition || detail === undefined ? '' : ` — ${detail}`}`)
}

/* ---------------------------------------------------------------- 桩 React */

let hookState = []
/** 桩 ref / DOM 调用的记录：断言"焦点回到触发器""当前项滚入视野"靠它。 */
const domCalls = { focus: [], scrollIntoView: [], listeners: new Map(), outsideTarget: null }
const makeRefStub = (type) => ({
  focus() { domCalls.focus.push(String(type)); navDom.document.activeElement = this },
  scrollIntoView(options) { domCalls.scrollIntoView.push({ type: String(type), options }) },
  // 默认"点在容器内部"；外部点击测试把 domCalls.outsideTarget 设成一个哨兵对象。
  contains(target) { return target !== domCalls.outsideTarget },
  /*
   * 浮层表单的 `querySelectorAll`：真实浏览器返回浮层内的可聚焦控件，焦点陷阱靠它算 Tab 的
   * 落点。桩 DOM 没有真实节点树，这里给一个**固定的两项列表**（等价于"浮层里有两个可聚焦
   * 控件"），让循环逻辑（末项 Tab 回第一项、首项 Shift+Tab 回末项）可以被真验，
   * 而不是只断言"代码写了"。
   */
  ...(String(type) === 'form'
    ? {
        querySelectorAll() {
          return [
            { focus() { domCalls.focus.push('dialog-item-1'); navDom.document.activeElement = this } },
            { focus() { domCalls.focus.push('dialog-item-2'); navDom.document.activeElement = this } },
          ]
        },
      }
    : {}),
})
function createElement(type, props, ...children) {
  if (props !== null && props !== undefined && typeof props.ref === 'object' && props.ref !== null) {
    props.ref.current = makeRefStub(type)
  }
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
  /** createSession 的渲染器用它把 effect 的依赖数组记下来（见 session 实现）。 */
  useEffectWithDeps: null,
}

/* ---------------------------------------------------------------- 桩环境 */

let loaded
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }

/** 注入过的样式表（<style> 被 appendChild 到这里，remove() 会把它摘掉）。 */
const styles = []

/*
 * 桩 DOM：认领导航行要用 document / MutationObserver。
 *
 * 只实现外壳真实用到的那点能力：`[role="dialog"] nav button` 这一个选择器、元素属性、
 * 以及由测试手动触发的 MutationObserver —— 足以覆盖"认领自己那一行 / 语言切换重新认领 /
 * 匹配不到时静默降级 / 卸载清理"这些边界。
 */
const navDom = (() => {
  const observerCallbacks = []
  const selectorCalls = []
  const element = (tagName) => {
    const node = {
      tagName: String(tagName).toUpperCase(),
      dataset: {},
      children: [],
      parent: null,
      ownText: '',
      attributes: new Map(),
      appendChild(child) {
        child.parent = node
        node.children.push(child)
        return child
      },
      setAttribute(name, value) { node.attributes.set(name, String(value)) },
      getAttribute(name) { return node.attributes.has(name) ? node.attributes.get(name) : null },
      hasAttribute(name) { return node.attributes.has(name) },
      removeAttribute(name) { node.attributes.delete(name) },
      remove() {
        const parent = node.parent
        if (parent !== null) parent.children = parent.children.filter((child) => child !== node)
        node.parent = null
        const index = styles.indexOf(node)
        if (index >= 0) styles.splice(index, 1)
      },
      get textContent() {
        return node.children.length === 0 ? node.ownText : `${node.ownText}${node.children.map((child) => child.textContent).join('')}`
      },
      set textContent(value) { node.ownText = String(value) },
    }
    return node
  }
  const dialog = element('div')
  dialog.setAttribute('role', 'dialog')
  const nav = element('nav')
  dialog.appendChild(nav)
  const rows = []
  /** 用给定的标签重建整排导航行（模拟打开对话框 / 切换语言之后的 DOM）。 */
  const setRows = (labels) => {
    nav.children = []
    rows.length = 0
    for (const label of labels) {
      const button = element('button')
      button.textContent = label
      nav.appendChild(button)
      rows.push(button)
    }
  }
  const state = { brokenSelector: false }
  /** 文档级事件监听（自绘下拉"点面板外关闭"就靠它）与手动派发。 */
  const listeners = new Map()
  const documentStub = {
    createElement: (tagName) => element(tagName),
    head: { appendChild: (node) => { styles.push(node); return node } },
    body: element('body'),
    /*
     * 焦点管理：真实浏览器里 `activeElement` 与 `focus()` 是一对，浮层的"进来先聚焦、
     * 关掉回到原处"全靠它。桩里给一个可写的当前焦点，测试据此断言焦点去了哪。
     */
    activeElement: null,
    /** 测试用来把焦点放到某个桩节点上（模拟"打开浮层前焦点在这里"）。 */
    focusOn(node) { documentStub.activeElement = node },
    /**
     * 浮层节点的兜底查询：真实浏览器返回那个 `<form data-dib-editor="dialog">`。
     * 桩里返回一个等价的假节点（有 focus 与两项可聚焦子节点），让焦点管理可被真验。
     */
    querySelector(selector) {
      if (selector !== '[data-dib-editor="dialog"]') return null
      return {
        focus() { domCalls.focus.push('form'); documentStub.activeElement = this },
        querySelectorAll() {
          return [
            { focus() { domCalls.focus.push('dialog-item-1'); documentStub.activeElement = this } },
            { focus() { domCalls.focus.push('dialog-item-2'); documentStub.activeElement = this } },
          ]
        },
      }
    },
    querySelectorAll(selector) {
      selectorCalls.push(selector)
      if (state.brokenSelector || selector !== '[role="dialog"] nav button') return []
      return rows.slice()
    },
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== handler))
    },
    /** 滚入视野用的元素查询：返回带 scrollIntoView 的桩节点并把调用记进 domCalls。 */
    getElementById(id) {
      return {
        id,
        scrollIntoView(options) { domCalls.scrollIntoView.push({ id, options }) },
      }
    },
  }
  return {
    document: documentStub,
    element,
    setRows,
    rows,
    state,
    selectorCalls,
    observerCallbacks,
    listenerCount: (type) => (listeners.get(type) ?? []).length,
    /** 手动派发一个文档级事件（例如 mousedown）。 */
    dispatch(type, event) { for (const handler of (listeners.get(type) ?? []).slice()) handler(event) },
    /** 测试手动触发 MutationObserver（真实浏览器里由 DOM 变更触发）。 */
    fire() { for (const callback of observerCallbacks.slice()) callback([]) },
    observerCount: () => observerCallbacks.length,
  }
})()

globalThis.document = navDom.document

/*
 * 全局**桩时钟**：把 setInterval / clearInterval 换成可以手动推进的桩。
 *
 * 两个理由，都是踩出来的：
 *  ① 「生成中」的秒级计时用的是真实 setInterval；一次性渲染（invoke）没有卸载动作，
 *     于是定时器留在事件循环里，脚本跑完 SUMMARY 也**不退出**（第一版就是这样被拖住 3 分钟）；
 *  ② 断言要"时间推进后秒数递增"，真等 2 秒既慢又脆——手动 tick 才是确定性做法。
 * 需要推进时间的地方用 `stubClock.tick()`，要查清理情况用 `stubClock.cleared` / `stubClock.timers`。
 */
const stubClock = {
  timers: new Map(),
  cleared: [],
  nextId: 1,
  tick() {
    for (const entry of [...this.timers.values()]) entry.fn()
    return this.timers.size
  },
}
globalThis.setInterval = (fn, ms) => {
  const id = stubClock.nextId
  stubClock.nextId += 1
  stubClock.timers.set(id, { fn, ms })
  return id
}
globalThis.clearInterval = (id) => {
  stubClock.cleared.push(id)
  stubClock.timers.delete(id)
}

globalThis.MutationObserver = class {
  constructor(callback) {
    this.callback = callback
    navDom.observerCallbacks.push(callback)
  }

  observe() {}

  disconnect() {
    const index = navDom.observerCallbacks.indexOf(this.callback)
    if (index >= 0) navDom.observerCallbacks.splice(index, 1)
  }
}

/* 认领前的导航行：既有官方 section，也有我们这一行；再放一个"包含我们标签"的诱饵行
   （别的插件完全可能叫「生图桥插件」），用来证明认领是**相等**匹配而不是包含匹配。 */
navDom.setRows(['账户', '模型', '插件市场', '生图桥', '生图桥插件', '其他'])

await import(pathToFileURL(`${ROOT}/client.js`).href)

const packageName = JSON.parse(await readFile(`${ROOT}/package.json`, 'utf8')).name
check('模块以正确的 id 注册（必须等于包名）', loaded?.id === packageName, `id=${loaded?.id} 包名=${packageName}`)
check('导出 factory 函数', typeof loaded?.factory === 'function', typeof loaded?.factory)

/*
 * 一次性排查脚手架不许回到源码里。
 *
 * 「设置行快照」那条临时诊断用朴素解包，在真实信封下恒打印 total:0，会把排查者带向
 * "配置丢了"的错误结论（live 日志里就是这个现象）。已删除，这里留一道闸。
 */
const clientSource = await readFile(`${ROOT}/client.js`, 'utf8')
check(
  '临时诊断「设置行快照」已从源码里清除（不留恒打印 total:0 的误导日志）',
  !clientSource.includes('设置行快照'),
  clientSource.includes('设置行快照') ? '源码里仍有 设置行快照' : '',
)

/*
 * 「连接超时」的默认值（**秒**）：**从 client.js 源码读**，不在这里写死。
 * 写死过一次的代价：Host 把默认值从 15000 改成 90000（同步生图实测 42–61 秒，15 秒会把正常
 * 的慢生成误判成失败），这里仍在断言 15000，于是套件报红——测试该跟着实现走，而不是反着来。
 * 现在两边都只算"请求有没有发出去"，而且**用户按秒填**（Host 侧 `DEFAULT_CONNECT_TIMEOUT_S`），
 * 所以这里读的是 client.js 的秒常量，断言写"秒"。
 */
const CLIENT_DEFAULT_CONNECT_S = (() => {
  const value = Number(/const DEFAULT_CONNECT_TIMEOUT_S = (\d+)/u.exec(clientSource)?.[1])
  if (!Number.isInteger(value) || value <= 0) throw new Error('没能从 client.js 读到 DEFAULT_CONNECT_TIMEOUT_S')
  return value
})()

const plugin = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`client.js 不应 require 其他模块，实际请求了 ${specifier}`)
})

check('插件声明 inject', Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('locale'), JSON.stringify(plugin.inject))

/* ---------------------------------------------------------------- 桩客户端 ctx */

const effects = []
const effectDisposers = []
const dictionaries = []
const registrations = []
/** 语言状态：认领导航行的"语言切换后重新认领"靠它驱动。 */
const localeState = { lang: 'zh' }

const fakeCtx = {
  effect(fn, label) {
    effects.push(label)
    const cleanup = fn()
    effectDisposers.push({ label, cleanup: typeof cleanup === 'function' ? cleanup : () => {} })
    return typeof cleanup === 'function' ? cleanup : () => {}
  },
  locale: {
    register(ns, dicts) { dictionaries.push({ ns, dicts }); return () => {} },
    // 绑定出来的 t 直接查已注册词典（与真实外壳一致），查不到才退回可识别的占位串。
    bind: (ns) => (key) => {
      const entry = dictionaries.find((item) => item.ns === ns)
      const table = entry === undefined ? undefined : entry.dicts[localeState.lang]
      return table !== undefined && typeof table[key] === 'string' ? table[key] : `t:${ns}:${key}`
    },
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
/* 注册进来的两套词典：后面的文案断言直接查它们（英文渲染也要用到） */
const zhDict = dictionaries[0].dicts.zh
const enDict = dictionaries[0].dicts.en

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

/* ---------------------------------------------------------------- 卡片渲染辅助 */

/** 渲染一张已结算的卡片（返回元素树）。 */
const renderCard = (block, toolName) => {
  hookState = []
  return invoke(ImageResultRow, { ...commonProps, toolName: toolName ?? 'image_generate', phase: 'result', block }).element
}
const settledBlock = (meta, extra) => ({
  kind: 'tool-result',
  isError: false,
  content: [{ type: 'text', text: '<generated_images/>' }],
  ...(meta === undefined ? {} : { meta }),
  ...(extra ?? {}),
})

/* ------------------------------------------------------------------ *
 * A. 生成中的秒级计时
 *
 * 「正在生成图片…」后面要跟一个每秒递增的秒数。这段占位是用户**唯一能看到本卡片内容**的
 * 时机（对话稳定后卡片会被宿主折叠/隐藏），所以它值得被认真验：
 *   首帧就有数字（不能先空一秒）、每秒 +1、**结束/卸载时必须清掉定时器**、zh/en 都走语言包。
 * 时间推进**不真等**：用文件顶部那个全局桩时钟（`stubClock`）手动 tick。
 * 状态推进用 createSession（它按路径持久化 hook，重渲染才会带着新秒数）。
 * ------------------------------------------------------------------ */
{
  const timers = stubClock.timers
  const clearedIds = stubClock.cleared
  const pendingTextOf = (tree) => {
    const node = tree.nodes.find((entry) => String(entry.props?.className ?? '').split(/\s+/u).includes('dib-pending'))
    return node === undefined ? '' : textOfElement(node).trim()
  }
  {
    const startProps = { ...commonProps, toolName: 'image_generate', phase: 'start', block: { phase: 'start', args: { prompt: '一只猫' } } }
    const timerSession = createSession(ImageResultRow, startProps)
    const firstFrame = timerSession.tree()
    check(
      '① 生成中首帧就带秒数（0s 立即可见，不用先空一秒）',
      pendingTextOf(firstFrame) === '正在生成图片… 0s'
        && firstFrame.nodes.some((node) => node.props?.['data-dib-elapsed'] === '0')
        && zhDict['running.elapsed'] === '{seconds}s',
      JSON.stringify({ text: pendingTextOf(firstFrame), timers: timers.size }).slice(0, 160),
    )
    stubClock.tick()
    const afterOne = timerSession.tree()
    stubClock.tick()
    const afterTwo = timerSession.tree()
    check(
      '② 时钟推进后秒数递增（桩时钟手动 tick，不真等）',
      pendingTextOf(afterOne) === '正在生成图片… 1s'
        && pendingTextOf(afterTwo) === '正在生成图片… 2s'
        && afterTwo.nodes.some((node) => node.props?.['data-dib-elapsed'] === '2'),
      JSON.stringify({ one: pendingTextOf(afterOne), two: pendingTextOf(afterTwo) }).slice(0, 160),
    )
    // 状态切到已结算（生成结束）→ effect 依赖变化 → **这一个** session 的定时器必须被清掉
    const timersBefore = timers.size
    const clearedBefore = clearedIds.length
    timerSession.props = { ...startProps, phase: 'result', block: settledBlock({ prompt: '一只猫', imageCapable: true, images: [] }) }
    const settledTree = timerSession.tree()
    check(
      '③ 生成结束（状态切换）后定时器被清理：clearInterval 被调用、该定时器从桩里消失',
      clearedIds.length > clearedBefore
        && timers.size === timersBefore - 1
        && settledTree.nodes.every((node) => node.props?.['data-dib-elapsed'] === undefined),
      JSON.stringify({ cleared: clearedIds.length - clearedBefore, timersBefore, timersAfter: timers.size }).slice(0, 160),
    )

    /* zh / en 两套：定时文案必须跟着语言包走，而不是硬编码中文 */
    const enTimerSession = createSession(ImageResultRow, {
      t: (key) => enDict[key] ?? key,
      toolName: 'image_generate',
      phase: 'start',
      block: { phase: 'start', args: { prompt: 'a cat' } },
    })
    const enTree = enTimerSession.tree()
    check(
      '④ zh / en 两套都有计时文案，且渲染结果跟着语言包走',
      typeof zhDict['running.elapsed'] === 'string'
        && typeof enDict['running.elapsed'] === 'string'
        && pendingTextOf(enTree) === 'Generating image… 0s'
        && !pendingTextOf(enTree).includes('生成')
        // 它也必须挂到（桩）时钟上——否则下面那句"清理"就无从谈起
        && timers.size >= 1,
      JSON.stringify({ zh: zhDict['running.elapsed'], en: enDict['running.elapsed'], en0: pendingTextOf(enTree) }).slice(0, 200),
    )
    /*
     * 收尾：把这个 session 也推到已结算，让它的定时器被清掉——测试里"挂上就不管"的定时器
     * 会留在桩时钟里（第一版用真实 setInterval，脚本跑完 SUMMARY 都不退出，正是这个原因）。
     */
    enTimerSession.props = { ...enTimerSession.props, block: settledBlock({ prompt: 'a cat', imageCapable: true, images: [] }) }
    enTimerSession.tree()
  }
}

/* ------------------------------------------------------------------ *
 * 图片状态文案与「未知错误」不能硬编码（A11）
 *
 * 卡片里有三处文案曾经写死：图片加载中 / 图片加载失败 / 未知错误（还有 img 的 alt）。
 * 硬编码的后果不是报错——是**英文界面里冒出中文**（或反过来），没人会为此开 issue，
 * 但界面看起来就是没做完。所以断言既查词典，也**真的用英文渲染一遍**。
 * ------------------------------------------------------------------ */
{
  const pendingBlock = settledBlock({
    prompt: 'a cat',
    imageCapable: true,
    images: [{ attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }],
  })
  const renderWith = (dict) => invoke(ImageResultRow, {
    t: (key) => dict[key] ?? key,
    toolName: 'image_generate',
    // 不 resolve：停在"加载中"，正好覆盖那条待机文案
    loadImage: () => new Promise(() => {}),
    phase: 'result',
    block: pendingBlock,
  }).element

  check(
    '图片状态与替代文本都走语言包（中英各有一条，且两两不同）',
    zhDict['image.loading'] === '图片加载中…' && enDict['image.loading'] === 'Loading image…'
      && zhDict['image.loadFailed'] !== enDict['image.loadFailed']
      && zhDict['image.alt'] !== enDict['image.alt']
      && zhDict['error.unknown'] !== enDict['error.unknown'],
    JSON.stringify({ zh: zhDict['image.loading'], en: enDict['image.loading'] }),
  )
  check(
    '英文界面下"加载中"渲染英文（硬编码中文会在这里红）',
    textOfElement(renderWith(enDict)).includes('Loading image…') && !textOfElement(renderWith(enDict)).includes('图片加载中'),
    JSON.stringify(textOfElement(renderWith(enDict)).slice(0, 120)),
  )
  check(
    '中文界面下"加载中"渲染中文（我们没把中文弄丢）',
    textOfElement(renderWith(zhDict)).includes('图片加载中…'),
    JSON.stringify(textOfElement(renderWith(zhDict)).slice(0, 120)),
  )

  /*
   * 图片在**浏览器层面**加载失败也要收（A4）。
   *
   * 上面那条 promise 只覆盖"拿地址"：`loadImage` 成功返回一个地址，不代表这个地址真能取到图
   * （附件被清理、地址过期、文件被删）。没有 `onError` 时卡片会留下一个**裂图占位**——用户看到
   * 半张图加一个系统破图图标，而不是一句能看懂的话。
   *
   * 做法：用 `peek` 让地址**同步**可用（首帧就渲染出 `img`），触发它的 `onError`，
   * 再渲染一次——桩 React 的 hook 状态是共享的，所以第二次渲染能看到 `failed` 已置位。
   */
  {
    const url = 'data:image/png;base64,AAAA'
    const peekLoader = Object.assign(() => Promise.resolve(url), { peek: () => url })
    /*
     * 必须用 `createSession`：一次性渲染里 `setState` 是空函数（见上面那段说明），
     * 触发 onError 之后界面不会变。会话把 hook 状态按组件实例持久化，重渲染才看得到结果。
     */
    const imgSession = createSession(ImageResultRow, {
      t: (key) => zhDict[key] ?? key,
      toolName: 'image_generate',
      loadImage: peekLoader,
      phase: 'result',
      block: pendingBlock,
    })
    let imgTree = imgSession.tree()
    const imgNode = imgTree.nodes.find((node) => node.type === 'img' && node.props?.className === 'dib-image')
    check(
      '图片元素挂了 onError（否则浏览器层加载失败会留一个裂图）',
      imgNode !== undefined && typeof imgNode.props?.onError === 'function',
      JSON.stringify({ found: imgNode !== undefined, hasOnError: typeof imgNode?.props?.onError }),
    )
    imgSession.fire(imgNode?.props?.onError)
    imgTree = imgSession.tree()
    check(
      'onError 之后换成可读文案，且不再渲染那个 img（不留裂图占位）',
      imgTree.text.includes(zhDict['image.loadFailed'])
        && imgTree.nodes.every((node) => node.props?.className !== 'dib-image'),
      JSON.stringify({ text: imgTree.text.slice(0, 90) }),
    )
  }

  /* 失败且没有正文时，不能出现那句写死的 'unknown error'。 */
  const failedBlock = settledBlock(undefined, {
    kind: 'tool-result',
    isError: true,
    content: [],
  })
  const failedEn = invoke(ImageResultRow, {
    t: (key) => enDict[key] ?? key,
    toolName: 'image_generate',
    loadImage: () => Promise.resolve('data:image/png;base64,AAAA'),
    phase: 'result',
    block: failedBlock,
  }).element
  check(
    '失败卡片没有正文时显示词典里的「未知错误」（不是写死的 unknown error）',
    textOfElement(failedEn).includes(enDict['error.unknown']) && !JSON.stringify(failedEn).includes('unknown error'),
    JSON.stringify(textOfElement(failedEn).slice(0, 120)),
  )
}

/* 焦点环：令牌缺失时不能整条失效（A13）——键盘用户看不到焦点比样式难看严重得多。 */
{
  const focusRingCss = styles.map((node) => String(node.textContent ?? '')).join('')
  const rings = (focusRingCss.match(/outline:var\(--dsw-focus-ring-width[^}]*/gu) ?? [])
  check(
    '每个 focus-visible 的焦点环都带宽度 fallback（缺令牌也不会整条失效）',
    rings.length >= 4 && rings.every((rule) => rule.includes('--dsw-focus-ring-width,')),
    JSON.stringify({ count: rings.length, sample: rings[0]?.slice(0, 90) ?? null }),
  )
  check(
    '焦点环颜色兜底到主题令牌，而不是字面色（硬编码颜色会绕过主题）',
    rings.length > 0 && rings.every((rule) => !/#[0-9a-fA-F]{3,8}/u.test(rule)) && rings.every((rule) => rule.includes('var(--dsw-alias-')),
    JSON.stringify({ hardcoded: rings.filter((rule) => /#[0-9a-fA-F]{3,8}/u.test(rule)).length }),
  )
}
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
    effect: (fn, label) => {
      try {
        const cleanup = fn()
        const disposer = typeof cleanup === 'function' ? cleanup : () => {}
        // 记下来，让"卸载后清理干净"的断言能覆盖每一个挂载实例（不只 fakeCtx 那一个）。
        effectDisposers.push({ label: label === undefined ? 're-apply' : label, cleanup: disposer })
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
/** 尺寸下拉里「自定义…」的保留取值（必须与 client.js 的 CUSTOM_SIZE_VALUE 一致）。 */
const CUSTOM_SIZE_VALUE = '__dib_custom_size__'

/* ---------------------------------------------------------------- 自绘下拉的查询助手 */

/** 触发器：`<button id=… aria-haspopup=listbox>`（原来的原生 select 位置）。 */
const triggerById = (tree, id) => tree.nodes.find((node) => node.type === 'button' && node.props?.id === id && node.props?.['aria-haspopup'] === 'listbox')
const triggerTextOf = (tree, id) => {
  const trigger = triggerById(tree, id)
  if (trigger === undefined) return ''
  // 触发器里是「值 + 小箭头」，断言的"显示文案"只取值那一半。
  const value = (Array.isArray(trigger.props.children) ? trigger.props.children : [])
    .find((child) => child?.props?.className === 'dib-dd-value')
  return (value === undefined ? textOfElement(trigger) : textOfElement(value)).trim()
}
/** 下拉组件节点本身（渲染时就在树里，props.entries 是条目表；菜单项也在其展开结果里）。 */
const dropdownById = (tree, id) => tree.nodes.find((node) => node.props?.id === id && Array.isArray(node.props?.entries))
const entriesOf = (tree, id) => dropdownById(tree, id)?.props?.entries ?? []
const entryOptionsOf = (tree, id) => entriesOf(tree, id).filter((entry) => entry.kind === 'option')
/** 模型项（排除末尾的「手动输入…」）。 */
const modelOptionsOf = (tree, id) => entryOptionsOf(tree, id).filter((entry) => entry.value !== MANUAL_MODEL_VALUE)
const groupLabelsOf = (tree, id) => entriesOf(tree, id).filter((entry) => entry.kind === 'group').map((entry) => entry.label)
/** 展开后的菜单面板与菜单项（只在 open 状态存在）。 */
const menuOf = (tree, id) => tree.nodes.find((node) => node.props?.['data-dib-menu'] === id)
const menuItemsOf = (menu) => (menu === undefined ? [] : (menu.props.children ?? []).filter((child) => child?.props?.role === 'option'))
const menuGroupsOf = (menu) => (menu === undefined ? [] : (menu.props.children ?? []).filter((child) => child?.props?.className === 'dib-menu-group'))
const menuItemByNameOf = (menu, label) => menuItemsOf(menu).find((item) => textOfElement(item).replace('✓', '').trim() === label)
const menuItemByValueOf = (menu, value) => menuItemsOf(menu).find((item) => String(item.props['data-value'] ?? '') === value)
/** 点击触发器打开菜单（已经开着就不点，避免又关掉），返回展开后的树。 */
const openDropdownTree = (session, id) => {
  const before = session.tree()
  if (menuOf(before, id) === undefined) session.click(triggerById(before, id))
  return session.tree()
}
const keyDownOn = (session, node, key, extra) => {
  // `extra` 用来带修饰键（type-ahead 必须忽略 Ctrl/Meta/Alt 组合，好据此验证）。
  session.fire(node?.props?.onKeyDown, { key, preventDefault() {}, ...(extra ?? {}) })
}

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  rpcCalls.push({ url: String(url), method: body.method, payload: body.payload ?? {} })
  // test 的返回体按 Host 的新契约带上 models（在 value.models 这一层）。
  const okTest = { ok: true, value: { ok: true, message: '连接成功：GET .../models → 200', models: ALL_MODELS } }
  const result = body.method === 'models'
    ? (modelsResultOverride ?? { ok: true, value: { models: ALL_MODELS } })
    : body.method === 'test'
      ? (testResultOverride ?? okTest)
      : { ok: true, value: { ok: true, message: 'HTTP 200' } }
  return {
    ok: true,
    status: 200,
    json: async () => ({ type: 'server-response', rpcId: body.rpcId, result }),
  }
}
/** 需要验证"失败落到对应卡片"的用例会临时把它设成失败的返回体，用完置回 null。 */
let testResultOverride = null
/** 需要验证"空模型列表"的用例临时把它设成空结果，用完置回 null。 */
let modelsResultOverride = null
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
      React.useEffect = (effect, deps) => {
        const store = cursor
        const index = store.index
        store.index += 1
        if (store.effects === undefined) store.effects = new Map()
        const previous = store.effects.get(index)
        /*
         * 依赖数组要真的参与判断：像"打开时才挂 document 监听、关闭时摘掉"这类 effect
         * （自绘下拉就靠它）必须能在 open 变化后重跑，否则测不到"点外部关闭"。
         * 没有依赖数组时保持老行为：只在挂载那次执行。
         */
        if (previous !== undefined) {
          const same = Array.isArray(deps) && Array.isArray(previous.deps)
            && deps.length === previous.deps.length
            && deps.every((value, position) => Object.is(value, previous.deps[position]))
          if (same) return undefined
          if (typeof previous.cleanup === 'function') previous.cleanup()
        }
        let cleanup
        try {
          cleanup = effect()
        } catch {
          cleanup = undefined
        }
        store.effects.set(index, { deps: Array.isArray(deps) ? deps.slice() : undefined, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
        return cleanup
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
      /*
       * 状态槽**按树内路径**定位，不再掺 `props.key`。
       *
       * 之前用 `${name}#${key ?? path}`：五个 Dropdown 的 key 都叫 'select' 时它们会**共享
       * 同一份 hook 状态**，断言看起来在验证五个控件、其实只验证了一个。key 修好之后这里
       * 也一并改成纯路径定位，让断言强度与它看起来的一致。
       */
      const key = `${name}#${path}`
      let store = stores.get(key)
      if (store === undefined) {
        store = { hooks: [], index: 0, effects: new Map(), refs: {} }
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

/*
 * 兼容层：控件从原生 `<select>` 换成了自绘下拉（Dropdown，见 client.js）。
 *
 * 早期断言是按 select 写的，这里把「按 id 取控件」映射到"触发器 + 条目表"上，
 * 让只关心 value / disabled / aria / 选项清单的断言原样继续有效；语义确实变了的
 * （占位文案现在在触发器上、菜单要展开才渲染、选择要点击而不是触发 change）逐条改写。
 */
const selectById = (tree, id) => {
  const dropdown = tree.nodes.find((node) => node.props?.id === id && Array.isArray(node.props?.entries))
  const trigger = tree.nodes.find((node) => node.type === 'button' && node.props?.id === id && node.props?.['aria-haspopup'] === 'listbox')
  if (dropdown === undefined && trigger === undefined) return undefined
  const entries = dropdown?.props?.entries ?? []
  return {
    type: 'button',
    props: {
      ...(trigger?.props ?? {}),
      id,
      value: dropdown?.props?.value,
      optionValues: entries.filter((entry) => entry.kind === 'option').map((entry) => entry.value),
      optionTexts: entries.map((entry) => entry.label),
      optionEntries: entries,
    },
  }
}
const optionValuesOf = (select) => {
  if (select === undefined) return []
  if (Array.isArray(select.props.optionValues)) return select.props.optionValues
  const children = Array.isArray(select.props.children) ? select.props.children : [select.props.children]
  return children.filter((child) => child !== null && typeof child === 'object').map((child) => String(child.props?.value ?? ''))
}
const inputById = (tree, id) => tree.nodes.find((node) => node.type === 'input' && node.props?.id === id)

/*
 * icon.svg 的**图形组**：`<g id="dib-icon-glyph">…</g>`。
 *
 * 图标现在是"蓝底白图"——多了一块品牌蓝的圆角底。导航遮罩与跨文件几何一致性都只关心
 * **图形**那一组，所以断言一律比"图形组内的几何数据"，而不是整份文件：底色不属于图形，
 * 也不该进遮罩（进了遮罩就会渲染成一个实心方块，而不是桥）。
 */
const iconGlyphGroupOf = (svgText) => {
  const match = /<g id="dib-icon-glyph"[^>]*>([\s\S]*?)<\/g>/u.exec(svgText)
  return match === null ? '' : match[1]
}
/** 图形元素上的几何数据（按属性名.值排序，便于两侧逐条比对）。 */
const geometryPairsIn = (text) => [...String(text).matchAll(/(?:^|\s)(x|y|width|height|rx|cx|cy|r|d)="([^"]*)"/gu)]
  .map((match) => `${match[1]}="${match[2]}"`)
  .sort()

const buttonByText = (tree, label) => tree.buttons.find((button) => textOfElement(button).includes(label))
const hasClass = (tree, name) => tree.classes.some((value) => value.split(' ').includes(name))

/** 带记录的远程上下文：settings 记 update，credentials 记 set 与 describe。 */
function sectionWithRecording(settingsValue, options) {
  const opts = options ?? {}
  const updates = []
  const credentialSets = []
  const describedRefs = []
  /*
   * `gateUpdates`：让 `update` 一直挂着，直到测试手动放行。
   * 用途是验证"第一次保存还没回来时又提交一次"——用立刻返回的桩根本测不到那个窗口，
   * 而那正是重复落盘（写两遍配置、必要时写两遍密钥）发生的地方。
   */
  let releaseGate
  const gate = opts.gateUpdates === true ? new Promise((resolve) => { releaseGate = resolve }) : null
  const settings = {
    describe: async () => ({ ok: true, value: { writable: true, namespaces: [{ ns: 'image-bridge-v4', value: settingsValue, revision: 1 }] } }),
    update: async (ns, patch, revision) => {
      updates.push({ ns, patch, revision })
      if (gate !== null) await gate
      // `updateFails` 用来验证"失败提示仍然显示"（成功提示已经不渲染了）。
      return opts.updateFails === true
        ? { ok: false, error: { code: 'write-rejected', message: opts.updateError ?? '保存失败：配置不可写' } }
        : { ok: true, value: {} }
    },
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
  return { component, updates, credentialSets, describedRefs, releaseGate: () => releaseGate?.() }
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

/** 模型行里的模型名（span.dib-model-id 的文本）。 */
const rowIdOf = (row) => {
  const children = Array.isArray(row?.props?.children) ? row.props.children : []
  const span = children.find((child) => child !== null && typeof child === 'object' && child.props?.className === 'dib-model-id')
  return span === undefined ? '' : textOfElement(span).trim()
}
const modelIdsOf = (tree) => tree.nodes.filter((node) => node.props?.className === 'dib-model-row').map(rowIdOf)

/** 一个模型槽位（与 client.js 里 routes 的字段形状一致）。 */
const routeItem = (providerId, model, extra) => ({ providerId, model, manual: false, manualText: '', ...(extra ?? {}) })
/** 四个槽位的初始状态，可覆盖任意槽。 */
const routesSeed = (overrides) => ({
  'generate.primary': routeItem('', ''),
  'generate.fallback': routeItem('', ''),
  'edit.primary': routeItem('', ''),
  'edit.fallback': routeItem('', ''),
  ...(overrides ?? {}),
})
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

/* 空列表：虚线「添加」入口 */
const emptyBundle = sectionWithRecording({ size: '1024x1024' })
const emptyTree = pageWith(emptyBundle, { providers: [], activeProviderId: '' })
check(
  '未配置提供商时列表底部给出虚线「添加模型提供商」入口',
  hasClass(emptyTree, 'dib-add-btn') && emptyTree.text.includes('添加模型提供商'),
  emptyTree.classes.join(' | ').slice(0, 200),
)
check('未配置提供商时给出空态提示', emptyTree.text.includes('还没有配置模型提供商'), emptyTree.text.slice(0, 160))

/* 卡片列表：单行结构 + 连接状态灯（正文已收进编辑浮层） */
const cardBundle = sectionWithRecording({ size: '1024x1024' })
/* 本次会话测过且成功 → 绿灯 */
const cardTree = pageWith(cardBundle, { providers: [providerRecord], activeProviderId: 'zhipu', testState: { zhipu: 'ok' }, keyConfigured: { zhipu: true } })
/* 本次会话测试失败 → 红灯（哪怕之前存过模型列表） */
const failTree = pageWith(cardBundle, { providers: [providerRecord], activeProviderId: 'zhipu', testState: { zhipu: 'fail' } })
/* 从未测过、也没有模型列表 → 灰灯 */
const idleTree = pageWith(cardBundle, { providers: [{ ...providerRecord, models: [] }], activeProviderId: 'zhipu' })
/* 从未测过，但已经保存过模型列表 → 绿灯（重新载入页面后依然成立） */
const persistedTree = pageWith(cardBundle, { providers: [providerRecord], activeProviderId: 'zhipu' })
const cardShellOf = (tree) => tree.nodes.filter((node) => node.props?.className === 'dib-card')
const dotClassOf = (tree) => tree.classes.find((value) => value.startsWith('dib-dot')) ?? ''
const cardTextOf = (tree) => {
  const shell = cardShellOf(tree)[0]
  return shell === undefined ? '' : textOfElement(shell).replace(/\s+/gu, ' ').trim()
}
const cardTextsOf = (tree) => cardShellOf(tree).map((shell) => textOfElement(shell).replace(/\s+/gu, ' ').trim())

check(
  '卡片仍是单行：[状态灯] 名称 [按钮]，正文容器已消失',
  cardShellOf(cardTree).length === 1
    && Array.isArray(cardShellOf(cardTree)[0].props.children)
    && cardShellOf(cardTree)[0].props.children.length === 1
    && hasClass(cardTree, 'dib-card-head')
    && !hasClass(cardTree, 'dib-card-body')
    && !hasClass(cardTree, 'dib-card-sub'),
  JSON.stringify({ cards: cardShellOf(cardTree).length, children: cardShellOf(cardTree)[0]?.props?.children?.length ?? null }),
)
check(
  '卡片上有状态灯、名称与「测试」「编辑」「删除」三个按钮',
  hasClass(cardTree, 'dib-dot')
    && cardTextOf(cardTree).includes('智谱')
    && buttonByText(cardTree, '测试') !== undefined
    && buttonByText(cardTree, '编辑') !== undefined
    && buttonByText(cardTree, '删除') !== undefined,
  cardTree.buttonTexts.join(','),
)
check(
  '卡片上不再有「当前使用」徽标与「设为当前」按钮',
  !cardTextOf(cardTree).includes('当前使用')
    && !cardTextOf(cardTree).includes('设为当前')
    && cardTree.buttons.every((button) => !textOfElement(button).includes('设为当前'))
    && !hasClass(cardTree, 'dib-card-tag-on'),
  JSON.stringify({ text: cardTextOf(cardTree) }).slice(0, 160),
)
check(
  '卡片正文那四行不再渲染（生图模型 / 改图模型 / 接口地址 / 密钥状态）',
  !cardTextOf(cardTree).includes('生图模型')
    && !cardTextOf(cardTree).includes('改图模型')
    && !cardTextOf(cardTree).includes('密钥')
    && !cardTextOf(cardTree).includes('open.bigmodel.cn')
    && !hasClass(cardTree, 'dib-card-body'),
  JSON.stringify({ text: cardTextOf(cardTree) }).slice(0, 160),
)
check(
  '连接状态灯三色：本次测试成功=绿、本次失败=红、从未测过且没有模型列表=灰',
  dotClassOf(cardTree) === 'dib-dot dib-dot-ok'
    && dotClassOf(failTree) === 'dib-dot dib-dot-fail'
    && dotClassOf(idleTree) === 'dib-dot',
  JSON.stringify({ ok: dotClassOf(cardTree), fail: dotClassOf(failTree), idle: dotClassOf(idleTree) }),
)
check(
  '绿灯在重新载入页面后依然成立：没有测试记录、但保存过模型列表的也是绿灯',
  dotClassOf(persistedTree) === 'dib-dot dib-dot-ok'
    && persistedTree.nodes.some((node) => node.props?.['aria-label'] === '已获取到可用模型列表'),
  JSON.stringify({ persisted: dotClassOf(persistedTree) }),
)

/* 名称下方的状态小字：与状态灯同源（同一个 providerSignalOf） */
const cardStatusTextOf = (tree) => {
  const node = tree.nodes.find((entry) => entry.props?.className === 'dib-card-status')
  return node === undefined ? '' : textOfElement(node).trim()
}
const cardStatusClassOf = (tree) => tree.nodes.find((entry) => entry.props?.className === 'dib-card-status')?.props?.className ?? ''
check(
  /*
   * A6：绿灯有**两种来源**，小字必须跟着分。
   *   - 本次会话真测过（`cardTree`）→「已连接」
   *   - 只是"保存过模型列表"这个**持久信号**（`persistedTree`）→「以前可用…」
   * 都写「已连接」就是过承诺：密钥可能早已被吊销，而界面并不会去重新验证。
   * 这条以前把"两种来源同一句话"当成正确行为，现在按更精确的口径钉住。
   */
  '卡片名称下方是状态小字：已连接 / 连接失败 / 未测试，且"以前能用"与"本次测过"分得清',
  cardStatusTextOf(cardTree) === '已连接'
    && cardStatusTextOf(failTree) === '连接失败'
    && cardStatusTextOf(idleTree) === '未测试'
    && cardStatusTextOf(persistedTree) === zhDict['provider.status.worked']
    && cardStatusTextOf(persistedTree) !== cardStatusTextOf(cardTree),
  JSON.stringify({ ok: cardStatusTextOf(cardTree), fail: cardStatusTextOf(failTree), idle: cardStatusTextOf(idleTree), persisted: cardStatusTextOf(persistedTree) }).slice(0, 240),
)
check(
  '状态小字是独立的弱化类（与名称不同类），且 zh/en 词典四条文案齐备、两两不同',
  cardStatusClassOf(cardTree) === 'dib-card-status'
    && cardStatusClassOf(cardTree) !== 'dib-card-name'
    && zhDict['provider.status.ok'] === '已连接'
    && zhDict['provider.status.fail'] === '连接失败'
    && zhDict['provider.status.untested'] === '未测试'
    && enDict['provider.status.ok'] === 'Connected'
    && enDict['provider.status.fail'] === 'Connection failed'
    && enDict['provider.status.untested'] === 'Not tested'
    // 第四档（以前可用）中英都要有，且与「已连接」不是同一句话
    && typeof zhDict['provider.status.worked'] === 'string' && zhDict['provider.status.worked'] !== ''
    && typeof enDict['provider.status.worked'] === 'string' && enDict['provider.status.worked'] !== ''
    && zhDict['provider.status.worked'] !== zhDict['provider.status.ok']
    && enDict['provider.status.worked'] !== enDict['provider.status.ok'],
  JSON.stringify({ cls: cardStatusClassOf(cardTree), zh: zhDict['provider.status.worked'], en: enDict['provider.status.worked'] }).slice(0, 240),
)
check(
  '状态小字与状态灯同源：四种情形下点色与文案一一对应，不会出现「绿点写着连接失败」',
  (() => {
    const pairs = [
      [cardTree, 'dib-dot dib-dot-ok', '已连接'],
      [failTree, 'dib-dot dib-dot-fail', '连接失败'],
      [idleTree, 'dib-dot', '未测试'],
      [persistedTree, 'dib-dot dib-dot-ok', zhDict['provider.status.worked']],
    ]
    return pairs.every(([tree, dot, text]) => dotClassOf(tree) === dot && cardStatusTextOf(tree) === text)
      // 反向也钉一下：红灯不能写"已连接"、绿灯不能写"连接失败"。
      && cardStatusTextOf(failTree) !== '已连接'
      && cardStatusTextOf(cardTree) !== '连接失败'
  })(),
  JSON.stringify({ ok: `${dotClassOf(cardTree)}/${cardStatusTextOf(cardTree)}`, fail: `${dotClassOf(failTree)}/${cardStatusTextOf(failTree)}`, idle: `${dotClassOf(idleTree)}/${cardStatusTextOf(idleTree)}`, persisted: `${dotClassOf(persistedTree)}/${cardStatusTextOf(persistedTree)}` }).slice(0, 260),
)
check(
  '状态小字就在名称下方（同一个 identity 列里、紧随名称之后）',
  (() => {
    const identity = cardTree.nodes.find((node) => node.props?.className === 'dib-card-identity')
    const children = (Array.isArray(identity?.props?.children) ? identity.props.children : []).filter(Boolean)
    return children.length === 2
      && children[0]?.props?.className === 'dib-card-name'
      && children[1]?.props?.className === 'dib-card-status'
  })(),
  JSON.stringify(cardTextOf(cardTree)).slice(0, 160),
)

/* 失败原因挂到对应的那张卡片上（A 家失败不会串到 B 家） */
/* 注意：React 不会把 key 放进 props，所以按卡片名称来定位是哪一张卡。 */
const findClassIn = (node, className) => {
  let found
  walk(node, (item) => {
    if (found === undefined && item !== null && typeof item === 'object' && item.props?.className === className) found = item
  })
  return found
}
const reasonTextOf = (tree, cardName) => {
  const shell = cardShellOf(tree).find((node) => {
    const nameNode = findClassIn(node, 'dib-card-name')
    return nameNode !== undefined && textOfElement(nameNode).trim() === cardName
  })
  const reason = shell === undefined ? undefined : findClassIn(shell, 'dib-card-reason')
  return reason === undefined ? '' : textOfElement(reason).trim()
}
const reasonStatusClassOf = (tree) => tree.nodes.filter((node) => node.props?.className === 'dib-card-status').map((node) => textOfElement(node).trim())

/* 两家服务商：只让第一家测试失败，看原因落在谁身上 */
const reasonZhipu = { ...providerRecord, models: ALL_MODELS }
const reasonOpenai = {
  id: 'openai',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  keyRef: 'DSH_IMAGE_BRIDGE_KEY_OPENAI',
  models: ['gpt-image-1'],
  imageModel: 'gpt-image-1',
  editModel: '',
}
rpcCalls.length = 0
const reasonBundle = sectionWithRecording({ providers: [reasonZhipu, reasonOpenai], activeProviderId: 'zhipu', size: '1024x1024' })
const reasonSession = createSession(reasonBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'loading' },
})
await sleep(30)
let reasonTree = reasonSession.tree()
// 载入是异步的：等到卡片真的渲染出来再点，避免点到"加载中"那一版。
for (let round = 0; round < 5 && reasonTree.buttons.length === 0; round += 1) {
  await sleep(20)
  reasonTree = reasonSession.tree()
}
testResultOverride = { ok: true, value: { ok: false, message: '401 密钥被拒绝' } }
const reasonCardTestButtons = () => reasonTree.buttons.filter((button) => textOfElement(button) === '测试')
const firstCardTest = reasonCardTestButtons()[0]
const beforeClickCalls = rpcCalls.length
firstCardTest?.props.onClick()
await sleep(30)
reasonTree = reasonSession.tree()
const afterFirstTree = reasonTree
const reasonDebug = {
  callsAfterClick: rpcCalls.length - beforeClickCalls,
  methods: rpcCalls.map((call) => call.method).slice(-3),
}
check(
  '测试失败的原因只出现在这一张卡片上（另一家仍扛着绿灯、没有那一行）',
  firstCardTest !== undefined
    && reasonTextOf(afterFirstTree, '智谱') === '连接失败：401 密钥被拒绝'
    && reasonTextOf(afterFirstTree, 'OpenAI') === ''
    // 另一家本次没测过（绿灯来自"保存过模型列表"），所以小字是「以前可用…」而不是「已连接」。
    && reasonStatusClassOf(afterFirstTree).join(',') === `连接失败,${zhDict['provider.status.worked']}`,
  JSON.stringify({ ...reasonDebug, zhipu: reasonTextOf(afterFirstTree, '智谱'), openai: reasonTextOf(afterFirstTree, 'OpenAI'), statuses: reasonStatusClassOf(afterFirstTree) }).slice(0, 320),
)
check(
  '卡片状态小字与状态灯同源（本次改动没有破坏它）：失败的那家写「连接失败」，另一家是绿灯',
  reasonStatusClassOf(afterFirstTree).join(',') === `连接失败,${zhDict['provider.status.worked']}`
    && dotClassOf(afterFirstTree) === 'dib-dot dib-dot-fail'
    && cardStatusTextOf(cardTree) === '已连接'
    && cardStatusTextOf(idleTree) === '未测试',
  JSON.stringify({ statuses: reasonStatusClassOf(afterFirstTree), dot: dotClassOf(afterFirstTree) }).slice(0, 200),
)
check(
  '成功时不出现失败原因那一行（状态小字「已连接」已经说清了）',
  reasonTextOf(cardTree, '智谱') === '' && cardStatusTextOf(cardTree) === '已连接',
  JSON.stringify({ reason: reasonTextOf(cardTree, '智谱') }),
)

/*
 * 两家各自失败、原因不同：第二条不能盖到第一条上，也不能互相复制——
 * 这条专门盯"失败原因是不是真的按 provider 归属"。
 */
testResultOverride = { ok: true, value: { ok: false, message: '连接超时' } }
reasonCardTestButtons()[1]?.props.onClick()
await sleep(30)
reasonTree = reasonSession.tree()
testResultOverride = null
check(
  '两家各自失败时，失败原因各归各家（不会串台、也不会互相覆盖）',
  reasonTextOf(reasonTree, '智谱') === '连接失败：401 密钥被拒绝'
    && reasonTextOf(reasonTree, 'OpenAI') === '连接失败：连接超时'
    && reasonStatusClassOf(reasonTree).join(',') === '连接失败,连接失败',
  JSON.stringify({ zhipu: reasonTextOf(reasonTree, '智谱'), openai: reasonTextOf(reasonTree, 'OpenAI'), statuses: reasonStatusClassOf(reasonTree) }).slice(0, 220),
)

/* 底部状态行：成功不渲染，失败仍然显示 */
const saveSizeButtonOf = (tree) => tree.nodes.find((node) => node.type === 'button' && textOfElement(node).trim() === '保存尺寸')
const statusRowsOf = (tree) => tree.nodes.filter((node) => node.type === 'p' && node.props?.role === 'status')

const okStatusBundle = sectionWithRecording({ size: '1024x1024' })
const okStatusSession = createSession(okStatusBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', providers: [providerRecord], activeProviderId: 'zhipu', size: '1024x1024' },
})
let okStatusTree = okStatusSession.tree()
okStatusSession.click(saveSizeButtonOf(okStatusTree))
await sleep(30)
okStatusTree = okStatusSession.tree()
const cfgOf = (tree) => tree.nodes.find((node) => node.props?.className === 'dib-cfg')
const atPageBottomOf = (tree, node) => (Array.isArray(cfgOf(tree)?.props?.children) ? cfgOf(tree).props.children : []).some((child) => child === node)
const bottomChildOf = (tree) => {
  const children = (Array.isArray(cfgOf(tree)?.props?.children) ? cfgOf(tree).props.children : []).filter(Boolean)
  return children[children.length - 1]
}
const sizeControlsOf = (tree) => tree.nodes.find((node) => node.props?.className === 'dib-size-controls')
const routesFooterOf = (tree) => tree.nodes.find((node) => node.props?.className === 'dib-footer')
check(
  '保存尺寸的反馈仍在，且紧邻按钮（在那一行 controls 里），不在页面底部容器里',
  statusRowsOf(okStatusTree).length === 1
    && textOfElement(statusRowsOf(okStatusTree)[0]).trim() === '已保存'
    && String(statusRowsOf(okStatusTree)[0]?.props?.className ?? '').includes('dib-status-inline')
    && (sizeControlsOf(okStatusTree)?.props?.children ?? []).includes(statusRowsOf(okStatusTree)[0])
    && atPageBottomOf(okStatusTree, statusRowsOf(okStatusTree)[0]) === false
    && okStatusBundle.updates.length === 1,
  JSON.stringify({
    row: statusRowsOf(okStatusTree).map((node) => textOfElement(node).trim()),
    cls: statusRowsOf(okStatusTree).map((node) => node.props?.className),
  }).slice(0, 220),
)
/*
 * A10：这一行是**单行省略**的（`.dib-status-inline` 带 text-overflow:ellipsis），而服务商的报错
 * 经常很长（带 URL、状态码、响应正文片段）。没有 `title` 时用户只能看到半句话——"看不全错误"
 * 等于"没法排查"。断言把它钉住：文案是什么，悬停就该读到什么，一个字都不能少。
 */
check(
  '状态行带 title = 完整文案（单行省略时悬停能看全，否则错误会被截断成半句话）',
  statusRowsOf(okStatusTree)[0]?.props?.title === textOfElement(statusRowsOf(okStatusTree)[0]).trim()
    && statusRowsOf(okStatusTree)[0]?.props?.title === '已保存',
  JSON.stringify({ title: statusRowsOf(okStatusTree)[0]?.props?.title ?? null }).slice(0, 120),
)

const failStatusBundle = sectionWithRecording({ size: '1024x1024' }, { updateFails: true, updateError: '保存失败：配置不可写' })
const failStatusSession = createSession(failStatusBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', providers: [providerRecord], activeProviderId: 'zhipu', size: '1024x1024' },
})
let failStatusTree = failStatusSession.tree()
failStatusSession.click(saveSizeButtonOf(failStatusTree))
await sleep(30)
failStatusTree = failStatusSession.tree()
check(
  '失败时的反馈也没有丢：仍然显示错误文案，而且就在按钮旁边（不在页面底部）',
  statusRowsOf(failStatusTree).length === 1
    && textOfElement(statusRowsOf(failStatusTree)[0]).trim() === '保存失败：配置不可写'
    && String(statusRowsOf(failStatusTree)[0]?.props?.className ?? '').includes('dib-status-error')
    && (sizeControlsOf(failStatusTree)?.props?.children ?? []).includes(statusRowsOf(failStatusTree)[0])
    && atPageBottomOf(failStatusTree, statusRowsOf(failStatusTree)[0]) === false,
  JSON.stringify({ row: statusRowsOf(failStatusTree).map((node) => textOfElement(node).trim()), cls: statusRowsOf(failStatusTree)[0]?.props?.className ?? null }).slice(0, 200),
)
check(
  '页面底部不再有任何状态提示（`.dib-cfg` 的最后一个子节点不是状态行）',
  statusRowsOf(okStatusTree).every((row) => atPageBottomOf(okStatusTree, row) === false)
    && statusRowsOf(failStatusTree).every((row) => atPageBottomOf(failStatusTree, row) === false)
    && bottomChildOf(okStatusTree)?.props?.role !== 'status'
    && bottomChildOf(failStatusTree)?.props?.role !== 'status',
  JSON.stringify({ bottom: bottomChildOf(okStatusTree)?.props?.className ?? null, bottomRole: bottomChildOf(okStatusTree)?.props?.role ?? null }).slice(0, 200),
)

/* 页头：与官方「插件市场」页同形态 —— 第一行 [单色图标] 标题 [仓库 版本]，第二行副标题 */
const headerTree = pageWith(cardBundle, { providers: [providerRecord], activeProviderId: 'zhipu' })
const headerNode = headerTree.nodes.find((node) => node.props?.className === 'dib-page-head')
const headerChildren = (Array.isArray(headerNode?.props?.children) ? headerNode.props.children : []).filter(Boolean)
const titleRow = headerChildren[0]
const titleRowChildren = (Array.isArray(titleRow?.props?.children) ? titleRow.props.children : []).filter(Boolean)
const inlineGlyph = titleRowChildren.find((child) => child?.type === 'svg')
const badgeNode = titleRowChildren[2]
const badgeText = badgeNode === undefined ? '' : textOfElement(badgeNode).trim()
const manifestJson = JSON.parse(await readFile(`${ROOT}/package.json`, 'utf8'))
/*
 * 徽标显示的仓库名取自**客户端自己的常量**（`client.js` 的 `REPO_NAME`），不在这里推导。
 *
 * 以前的写法是"包名去掉 scope 前缀"，那在包名是 `@local/dsh-image-bridge` 时恰好等于仓库名；
 * 包名改成 `kkj-luna-dsh-image-bridge` 之后这个推导就错了（推出来是 `kkj-luna-dsh-image-bridge`，
 * 而界面上显示的是仓库名 `dsh-image-bridge`）。断言应当核对**界面真的用了哪个常量**，
 * 而不是自己再猜一遍推导规则——否则规则一变，测试会红在一个它并不该管的地方。
 */
const repoName = /const REPO_NAME = '([^']+)'/u.exec(clientSource)?.[1] ?? ''
/* 仓库地址常量：与 client.js 的 REPO_URL 一致。 */
const repoUrl = /const REPO_URL = '([^']+)'/u.exec(clientSource)?.[1] ?? ''
check(
  '页头第一行：[单色图标] + 「生图桥」标题 + 仓库徽标（版本与 package.json 逐字一致、不显示 scope 前缀）',
  headerNode !== undefined
    && titleRowChildren.map((child) => child?.type).join(',') === 'svg,h2,a'
    && textOfElement(titleRowChildren[1]).trim() === '生图桥'
    && zhDict['nav'] === '生图桥'
    // 版本仍与清单逐字一致；显示名换成仓库名，不再逐字等于包名。
    && badgeNode?.props?.children === `${repoName}  v${manifestJson.version}`
    && manifestJson.name === 'kkj-luna-dsh-image-bridge',
  JSON.stringify({ row: titleRowChildren.map((child) => child?.type), badge: badgeText, version: manifestJson.version }).slice(0, 220),
)
check(
  '① 徽标是真实链接（<a>，键盘可达），href 精确指向仓库',
  badgeNode?.type === 'a'
    && badgeNode?.props?.href === repoUrl
    && badgeNode?.props?.onClick === undefined,
  JSON.stringify({ type: badgeNode?.type ?? null, href: badgeNode?.props?.href ?? null }).slice(0, 200),
)
check(
  '② 链接在新标签打开且 rel 含 noopener（noreferrer 一并带上）',
  badgeNode?.props?.target === '_blank'
    && String(badgeNode?.props?.rel ?? '').split(/\s+/u).includes('noopener')
    && String(badgeNode?.props?.rel ?? '').split(/\s+/u).includes('noreferrer'),
  JSON.stringify({ target: badgeNode?.props?.target ?? null, rel: badgeNode?.props?.rel ?? null }).slice(0, 200),
)
check(
  '③ 徽标文案 = 仓库名 + 版本，且**不把包名整串显示出来**（`kkj-luna-` 前缀对使用无意义）',
  badgeText === `${repoName}  v${manifestJson.version}`
    && repoName !== '' && badgeText.startsWith(repoName)
    && badgeText.includes(manifestJson.version)
    // 徽标显示仓库名，而包名带用户名前缀：两者不是同一个字符串，界面只显示前者。
    && !badgeText.includes(manifestJson.name)
    && typeof badgeNode?.props?.title === 'string' && badgeNode.props.title.includes(repoUrl)
    && typeof badgeNode?.props?.['aria-label'] === 'string' && badgeNode.props['aria-label'].includes(repoUrl)
    // 悬停要有可点击的视觉反馈，且只用主题令牌
    && /\.dib-page-badge:hover\{[^}]*var\(--dsw-/u.test(styles.map((style) => style.textContent).join('')),
  JSON.stringify({ badge: badgeText, repoName, pkg: manifestJson.name, title: badgeNode?.props?.title ?? null }).slice(0, 240),
)
/*
 * A12：徽标的可访问名称必须走语言包。它是页头唯一的链接，硬编码中文会在英文界面里让读屏
 * 读出中文——"半个界面是外语"这种问题没人会专门提 issue，但它是实打实的缺陷。
 */
check(
  '③b 徽标 aria-label 走语言包（中英各一条、占位符都替换、两版文案不同）',
  (() => {
    const zhLabel = zhDict['badge.label']
    const enLabel = enDict['badge.label']
    const aria = badgeNode?.props?.['aria-label'] ?? ''
    return typeof zhLabel === 'string' && typeof enLabel === 'string' && zhLabel !== enLabel
      && zhLabel.includes('{repo}') && zhLabel.includes('{version}') && zhLabel.includes('{url}')
      && enLabel.includes('{repo}') && enLabel.includes('{version}') && enLabel.includes('{url}')
      // 中文界面下渲染出来的不该含未替换的占位符，也不该出现英文模板
      && !aria.includes('{') && aria.includes(repoName) && aria.includes(manifestJson.version)
      && aria.includes(repoUrl)
  })(),
  JSON.stringify({ zh: zhDict['badge.label'], en: enDict['badge.label'], aria: badgeNode?.props?.['aria-label'] ?? null }).slice(0, 240),
)
const iconSvgText = await readFile(`${ROOT}/icon.svg`, 'utf8')
/* 只比对几何数据（stub React 会把 key 留在 props 里，真实 React 不会）。 */
const GEOMETRY_ATTRS = ['x', 'y', 'width', 'height', 'rx', 'cx', 'cy', 'r', 'd', 'points']
const glyphChildren = (Array.isArray(inlineGlyph?.props?.children) ? inlineGlyph.props.children : []).filter(Boolean)
const glyphPairs = glyphChildren.flatMap((shape) => Object.entries(shape.props ?? {})
  .filter(([name]) => GEOMETRY_ATTRS.includes(name))
  .map(([name, value]) => `${name}="${value}"`))
const iconGlyphGroup = iconGlyphGroupOf(iconSvgText)
const iconGlyphPairs = geometryPairsIn(iconGlyphGroup)
/*
 * 这条只管**内联图形**（页头 SVG 与导航遮罩的来源）：它必须只用 currentColor / fill=none，
 * 因为导航那一行是靠 CSS mask-image 上色的（mask 只读 alpha，可见颜色来自 currentColor），
 * 一旦写死颜色，深色主题下就会变成一块不跟主题的色斑。
 *
 * `icon.svg` **不受这条约束**：它是插件列表里的品牌图标，蓝底白图是有意为之（见下面的
 * 图标断言）。以后不要因为"看着不一致"就把这条规则又套回 icon.svg 上。
 */
const colorPattern = /#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|(^|[^-])(white|black)\b/u
check(
  '内联图形（页头/导航）只用 currentColor、无硬编码颜色；几何数据与 icon.svg 的图形组逐条一致',
  inlineGlyph?.props?.stroke === 'currentColor'
    && inlineGlyph?.props?.fill === 'none'
    && glyphChildren.map((shape) => shape.type).join(',') === 'rect,circle,path,path,path,path'
    && glyphPairs.length >= 10
    // 两侧的几何数据必须**互相**包含（不只是子集）：图形组里的形状不许被悄悄改多/改少。
    && [...glyphPairs].sort().join('|') === iconGlyphPairs.join('|')
    && glyphPairs.every((pair) => !colorPattern.test(pair))
    && !colorPattern.test(JSON.stringify(inlineGlyph?.props ?? {}))
    // 它是所有用户唯一看得到的专属图标，不能被缩成一个点：至少与标题同量级。
    && Number(inlineGlyph?.props?.width) >= 20
    && Number(inlineGlyph?.props?.height) === Number(inlineGlyph?.props?.width),
  JSON.stringify({ shapes: glyphChildren.map((shape) => shape.type), pairs: glyphPairs.length, size: inlineGlyph?.props?.width ?? null, missing: iconGlyphPairs.filter((pair) => !glyphPairs.includes(pair)) }).slice(0, 260),
)
check(
  '① icon.svg 是蓝底白图的品牌图标：蓝色圆角底铺满画布，图形几何与内联图形逐条一致',
  (() => {
    const base = /<rect\s+x="0"\s+y="0"\s+width="24"\s+height="24"\s+rx="([\d.]+)"\s+fill="(#[0-9a-fA-F]{6})"\s*\/>/u.exec(iconSvgText)
    const groupTag = /<g id="dib-icon-glyph"[^>]*stroke="(#[0-9a-fA-F]{6})"[^>]*>/u.exec(iconSvgText)
    // 注释里出现 "<style>" 这样的字眼不该影响判断：先剥掉 XML 注释再看。
    const bare = iconSvgText.replace(/<!--[\s\S]*?-->/gu, '')
    return base !== null
      && groupTag !== null
      && Number(base[1]) > 0
      // 品牌蓝：外壳调色板里的 --dsw-static-deepseek-500
      && base[2].toLowerCase() === '#4176e6'
      && groupTag[1].toLowerCase() === '#ffffff'
      && iconGlyphPairs.length >= 12
      && iconGlyphPairs.join('|') === [...glyphPairs].sort().join('|')
      // 不引外部资源、不用内联样式表（否则外壳的内容安全策略/主题切换都会出问题）
      && !/<style[\s>]/iu.test(bare)
      && !/xlink:href|href="http/iu.test(bare)
      && iconSvgText.includes('aria-label="Image Bridge"')
  })(),
  JSON.stringify({ base: /<rect[^>]*fill="[^"]*"[^>]*>/u.exec(iconSvgText)?.[0] ?? null, glyph: iconGlyphPairs.length }).slice(0, 240),
)
check(
  '② 导航遮罩仍然只由 currentColor 与几何数据构成：底色的品牌蓝没有渗进遮罩或样式表',
  (() => {
    const maskStyle = styles.find((style) => style.dataset?.pluginCss === 'dsh-image-bridge/settings-nav-icon')
    const maskText = String(maskStyle?.textContent ?? '')
    const maskSvg = decodeURIComponent((/mask-image:\s*url\("([^"]+)"\)/u.exec(maskText)?.[1] ?? '').replace(/^data:image\/svg\+xml,/u, ''))
    return maskStyle !== undefined
      && maskSvg !== ''
      // 遮罩里不能出现品牌蓝/白色填充，否则导航会渲染成实心块
      && !/#4176e6|#fff/iu.test(maskSvg)
      && !/fill="#/u.test(maskSvg)
      && maskText.includes('background-color: currentColor')
  })(),
  JSON.stringify({ maskColors: [...new Set((/#[0-9a-fA-F]{3,8}/gu.exec('') ?? []))] }).slice(0, 120),
)
const cfgNode = headerTree.nodes.find((node) => node.props?.className === 'dib-cfg')
const cfgChildren = (Array.isArray(cfgNode?.props?.children) ? cfgNode.props.children : []).filter(Boolean)
const indexOfClassIn = (className) => cfgChildren.findIndex((child) => String(child?.props?.className ?? '').split(/\s+/u).includes(className))
const headerCssText = styles.map((style) => style.textContent).join('')
check(
  '副标题在页头第二行（纵向排列），且既有区块顺序未被破坏：列表 → 模型区块 → 图片尺寸',
  headerChildren.length === 2
    && headerChildren[0] === titleRow
    && String(headerChildren[1]?.props?.className ?? '').includes('dib-page-sub')
    && textOfElement(headerChildren[1]).trim() === zhDict['intro']
    && cfgChildren[0] === headerNode
    && indexOfClassIn('dib-list') > 0
    && indexOfClassIn('dib-routes') > indexOfClassIn('dib-list')
    && indexOfClassIn('dib-size-field') > indexOfClassIn('dib-routes')
    && headerCssText.includes('.dib-page-head{display:flex;flex-direction:column;'),
  JSON.stringify({ cfg: cfgChildren.map((child) => String(child?.props?.className ?? '').slice(0, 20)) }).slice(0, 260),
)

/* 副标题是一句话，不是教程：字数封顶，防以后又被写长 */
const subtitleText = textOfElement(headerChildren[1] ?? {}).trim()
check(
  '副标题是一句话：zh 逐字等于约定文案，汉字 ≤ 24 且总长 ≤ 40（够放产品名 DeepSeek Harness）',
  subtitleText === '为你的 DeepSeek Harness 接上外部生图模型'
    && zhDict['intro'] === subtitleText
    // 汉字数封顶仍然保持 24：防的是"以后又被写成长教程"；总长放宽到 40 只是为了容纳产品名。
    && (subtitleText.match(/[\u4e00-\u9fff]/gu) ?? []).length <= 24
    && subtitleText.length <= 40
    // 不带句尾句号（与设置页其它说明文案一致），也不再塞括号步骤。
    && !/[。.]$/u.test(subtitleText)
    && !/[（(]/u.test(subtitleText),
  JSON.stringify({ text: subtitleText, cjk: (subtitleText.match(/[\u4e00-\u9fff]/gu) ?? []).length, length: subtitleText.length }).slice(0, 200),
)
check(
  '副标题的英文同样是一句短句（zh/en 两套都有，且不是直译的长句）',
  typeof enDict['intro'] === 'string'
    && enDict['intro'] === 'Connect external image models to your DeepSeek Harness'
    && enDict['intro'] !== zhDict['intro']
    && enDict['intro'].length <= 80
    && !/[。.]$/u.test(enDict['intro'])
    && !enDict['intro'].includes('('),
  JSON.stringify({ en: enDict['intro'], length: String(enDict['intro']).length }).slice(0, 200),
)

/* 编辑面板：字段 + 两个动作按钮 */
const editorInitial = {
  id: 'zhipu',
  keyRef: 'DSH_IMAGE_BRIDGE_KEY_ZHIPU',
  label: '智谱',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  models: ALL_MODELS,
  imageModel: 'qwen-image-3.0-pro',
  editModel: '',
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
  '编辑面板有保存 / 取消，并有密钥说明小字',
  editorTree.text.includes('API Key 保存在凭据服务里，不会写进配置文件，也不会回传浏览器')
    && buttonByText(editorTree, '保存') !== undefined
    && buttonByText(editorTree, '取消') !== undefined,
  editorTree.buttonTexts.join(','),
)

/* API Key：占位提示随状态变化，星号只进 placeholder、绝不进 value */
const keyInputOf = (configured) => {
  const tree = pageWith(cardBundle, {
    providers: [providerRecord],
    activeProviderId: 'zhipu',
    ...(configured ? { keyConfigured: { zhipu: true } } : {}),
    editor: { mode: 'edit', initial: editorInitialFor(ALL_MODELS) },
  })
  return inputById(tree, 'dib-provider-key')
}
const keyInputUnconfigured = keyInputOf(false)
const keyInputConfigured = keyInputOf(true)
check(
  'API Key 未配置时提示「输入API密钥」；已配置时用星号铺满 placeholder，两者 value 都为空',
  keyInputUnconfigured?.props?.placeholder === '输入API密钥'
    && keyInputUnconfigured?.props?.value === ''
    && keyInputConfigured?.props?.placeholder === '*'.repeat(12)
    && keyInputConfigured?.props?.value === ''
    && String(keyInputConfigured?.props?.value ?? '').includes('*') === false,
  JSON.stringify({
    unconfigured: keyInputUnconfigured?.props?.placeholder ?? null,
    configured: keyInputConfigured?.props?.placeholder ?? null,
    value: keyInputConfigured?.props?.value ?? null,
  }).slice(0, 200),
)
check(
  '密钥说明小字是最终文案（不带结尾句号），英文包按英文习惯保留句末句号',
  (() => {
    const tree = pageWith(cardBundle, {
      providers: [providerRecord],
      activeProviderId: 'zhipu',
      keyConfigured: { zhipu: true },
      editor: { mode: 'edit', initial: editorInitialFor(ALL_MODELS) },
    })
    const hint = tree.nodes.find((node) => node.type === 'p' && node.props?.id === 'dib-provider-key-hint')
    const text = hint === undefined ? '' : textOfElement(hint).trim()
    return text === 'API Key 保存在凭据服务里，不会写进配置文件，也不会回传浏览器'
      && zhDict['keyNote'] === 'API Key 保存在凭据服务里，不会写进配置文件，也不会回传浏览器'
      && String(enDict['keyNote']).endsWith('.')
  })(),
  zhDict['keyNote'],
)
check(
  'zh 词典里所有说明文案都不以「。」结尾（遍历整份词典，不逐个硬编码）',
  Object.entries(zhDict).every(([, value]) => typeof value !== 'string' || !value.endsWith('。')),
  JSON.stringify(Object.entries(zhDict).filter(([, value]) => typeof value === 'string' && value.endsWith('。')).map(([key, value]) => `${key}=${value}`)).slice(0, 240),
)

/* 模型列表（浮层里）：只作展示，选择已经搬到主页的模型区块 */
check(
  '浮层里仍列出这家服务商的模型，默认只列生图模型',
  hasClass(editorTree, 'dib-model-list') && modelIdsOf(editorTree).length === IMAGE_MODELS.length
    && IMAGE_MODELS.every((model) => modelIdsOf(editorTree).includes(model))
    && NON_IMAGE_MODELS.every((model) => !modelIdsOf(editorTree).includes(model)),
  `rows=${modelIdsOf(editorTree).length}`,
)
check(
  '浮层里不再有「生图 / 改图」选择按钮（选哪个模型只在主页做）',
  editorTree.buttons.every((button) => !['生图', '改图'].includes(textOfElement(button).trim())),
  editorTree.buttonTexts.join(','),
)
const routedRowOf = (tree, model) => tree.nodes.filter((node) => node.props?.className === 'dib-model-row').find((row) => rowIdOf(row) === model)
const routedTree = pageWith(cardBundle, {
  providers: [providerRecord],
  activeProviderId: 'zhipu',
  routes: routesSeed({
    'generate.primary': routeItem('zhipu', 'qwen-image-3.0'),
    'edit.primary': routeItem('zhipu', 'wan2.7-image'),
  }),
  editor: { mode: 'edit', initial: editorInitialFor(ALL_MODELS) },
})
check(
  '浮层行标出主页当前选中的生图 / 改图模型（同一份 modelRoutes，两处不分裂）',
  textOfElement(routedRowOf(routedTree, 'qwen-image-3.0')).includes('当前生图模型')
    && textOfElement(routedRowOf(routedTree, 'wan2.7-image')).includes('当前改图模型')
    && !textOfElement(routedRowOf(routedTree, 'qwen-image-2.1-pro')).includes('当前生图模型'),
  JSON.stringify({
    image: textOfElement(routedRowOf(routedTree, 'qwen-image-3.0')).slice(0, 60),
    edit: textOfElement(routedRowOf(routedTree, 'wan2.7-image')).slice(0, 60),
  }),
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

/* ------------------------------------------------------------------ *
 * 空模型列表**不能覆盖**已保存的列表
 *
 * 回归用例（曾经真实存在的数据丢失路径）：服务商回 `{data: []}`、或不提供 /models，
 * 客户端把空结果当成"权威答案"写进 models，用户再点一次保存就把这家服务商的模型列表
 * 抹成了空——四个模型下拉随之全部变灰，界面上还没有一句话说明是这一步抹掉的。
 * 判定口径：点完「重新获取可用模型」后，界面仍然拿得到原来那份列表。
 * ------------------------------------------------------------------ */
{
  modelsResultOverride = { ok: true, value: { models: [] } }
  const keepBundle = sectionWithRecording({ size: '1024x1024' })
  const keepSession = createSession(keepBundle.component, {
    t: undefined,
    close: () => {},
    __initial: {
      phase: 'idle',
      providers: [providerRecord],
      activeProviderId: 'zhipu',
      editor: { mode: 'edit', initial: editorInitialFor(ALL_MODELS) },
    },
  })
  const keepTree = keepSession.tree()
  keepSession.click(buttonByText(keepTree, '重新获取可用模型'))
  await sleep(30)
  const afterEmpty = keepSession.tree()
  check(
    '「获取可用模型」拿到空结果时不覆盖已保存的列表（按钮仍显示「重新获取」）',
    buttonByText(afterEmpty, '重新获取可用模型') !== undefined
      && afterEmpty.text.includes('已保留原有模型列表'),
    JSON.stringify({ buttons: afterEmpty.buttons.map((button) => textOfElement(button).trim()).slice(0, 12) }),
  )
  /*
   * 再验"保存之后仍然是原来那份"：列表先被清空、再被 Save 写进配置，才是数据丢失真正发生的那一步。
   */
  keepBundle.updates.length = 0
  keepSession.submit(keepSession.tree().forms[0])
  await sleep(30)
  const keptModels = keepBundle.updates[0]?.patch?.providers?.[0]?.models
  check(
    '空结果之后保存，写进去的仍是原有模型列表（不是空数组）',
    Array.isArray(keptModels) && keptModels.length === ALL_MODELS.length,
    JSON.stringify({ models: keptModels?.length ?? null, expected: ALL_MODELS.length }),
  )
  modelsResultOverride = null
}

/* ------------------------------------------------------------------ *
 * 无障碍：自绘下拉的**触发器**必须有可访问名
 *
 * 触发器渲染成 `<button>`，而可见标签是与它并列的 `<label htmlFor>`——`<button>` 不在
 * ARIA 的可被 label 关联元素集合里，所以那条可见标签给不出可访问名。备用槽位与尺寸下拉
 * 各自都漏过这个属性，读屏里就是几个没有名字的按钮。
 * ------------------------------------------------------------------ */
{
  const a11yDropdownBundle = sectionWithRecording({ size: '1024x1024' })
  const a11yDropdownSession = createSession(a11yDropdownBundle.component, {
    t: undefined,
    close: () => {},
    __initial: {
      phase: 'idle',
      providers: [providerRecord],
      activeProviderId: 'zhipu',
      keyConfigured: { zhipu: true },
    },
  })
  const a11yDropdownTree = a11yDropdownSession.tree()
  const dropdownNames = ['dib-route-generate-primary', 'dib-route-generate-fallback', 'dib-route-edit-primary', 'dib-route-edit-fallback', 'dib-size']
    .map((id) => {
      const trigger = triggerById(a11yDropdownTree, id)
      return { id, label: trigger?.props?.['aria-label'] ?? '' }
    })
  check(
    '五个自绘下拉的触发器都有 aria-label（label+button 关联不上，必须自带可访问名）',
    dropdownNames.every((entry) => entry.label !== ''),
    JSON.stringify(dropdownNames),
  )
}

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

/* ------------------------------------------------------------------ *
 * 无障碍：浮层的焦点管理（A2）
 *
 * 三件事都要成立，缺一件都是"能用鼠标、键盘用户被困或迷路"：
 *   进来先聚焦浮层、Tab 不出浮层、关掉回到原来那个元素。
 * 桩 DOM 没有真实节点树，但 ref 桩会记录 `focus()`、并给浮层表单一个固定的两项可聚焦
 * 列表——足够把"循环逻辑"真验出来，而不是只断言"代码里写了 focus"。
 * ------------------------------------------------------------------ */
{
  const a11yBundle = sectionWithRecording({ size: '1024x1024' })
  const a11ySession = createSession(a11yBundle.component, {
    t: undefined,
    close: () => {},
    __initial: {
      phase: 'idle',
      providers: [providerRecord],
      activeProviderId: 'zhipu',
      editor: { mode: 'edit', initial: editorInitialFor(['cogview-4']) },
    },
  })
  /** 打开浮层前焦点所在的元素（真实场景里是那张卡片的「编辑」按钮）。 */
  const triggerElement = { focus() { navDom.document.activeElement = this; domCalls.focus.push('trigger') } }
  navDom.document.activeElement = triggerElement
  const focusBefore = domCalls.focus.length
  const listenersBefore = navDom.listenerCount('keydown')
  a11ySession.tree()
  const focusedOnOpen = domCalls.focus.slice(focusBefore)
  check(
    '浮层打开时把焦点收进浮层（不是留在背后的页面上）',
    focusedOnOpen.includes('form'),
    JSON.stringify({ focusedOnOpen, keydownListeners: `${listenersBefore} → ${navDom.listenerCount('keydown')}`, refCurrent: typeof a11ySession.element?.props?.children?.[1]?.props?.ref?.current }),
  )

  navDom.document.focusOn({ focus() {}, tag: 'inside' })
  navDom.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() {} })
  navDom.document.focusOn({ focus() {}, tag: 'inside' })
  navDom.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() {} })
  navDom.document.focusOn({ focus() {}, tag: 'inside' })
  navDom.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} })
  const focusDuringTrap = domCalls.focus.slice(focusBefore + focusedOnOpen.length)
  check(
    'Tab / Shift+Tab 的落点都被浮层接管（焦点不会跑到背后的页面）',
    focusDuringTrap.filter((entry) => entry.startsWith('dialog-item-')).length >= 3,
    JSON.stringify(focusDuringTrap),
  )

  /* 点「取消」把浮层真正关掉（组件卸载 → effect 清理跑）→ 焦点必须回到打开它的那个元素。 */
  /*
   * 第三条（关闭后焦点回到打开它的元素）**在这里观察不到**：清理函数存在会话的 effect store 里，
   * 子组件从树里消失时这套桩渲染器不会调用它（真实 React 会）。所以这里不断言它，只在
   * README 的「未覆盖范围」里标注"真实焦点回流需真机确认"——把一条永远红的断言留在套件里，
   * 比不写更糟：它会训练人忽略红色。
   */
  navDom.document.activeElement = null
}
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

const ROUTE_SELECTS = {
  'generate.primary': 'dib-route-generate-primary',
  'generate.fallback': 'dib-route-generate-fallback',
  'edit.primary': 'dib-route-edit-primary',
  'edit.fallback': 'dib-route-edit-fallback',
}
const openaiProvider = {
  id: 'openai',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  keyRef: 'DSH_IMAGE_BRIDGE_KEY_OPENAI',
  models: ['gpt-image-1', 'dall-e-3', 'gpt-4o'],
  imageModel: 'gpt-image-1',
  editModel: '',
}
const zhipuFull = { ...providerRecord, models: ALL_MODELS }
/* 截图里那个小写英文服务商名 other：与模型名最容易混淆的那一种，必须能一眼分出。 */
const otherProvider = {
  id: 'other',
  label: 'other',
  baseUrl: 'https://other.example.com/v1',
  keyRef: 'DSH_IMAGE_BRIDGE_KEY_OTHER',
  models: ['gemini-3.1-flash-image', 'gpt-image-2'],
  imageModel: 'gemini-3.1-flash-image',
  editModel: '',
}
const OTHER_MODELS = otherProvider.models
/** 主页（不开浮层）的模型路由视图：三家服务商，各自的模型列表都已获取过。 */
const routesPageWith = (bundle, extra) => treeOf(invoke(bundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', providers: [zhipuFull, openaiProvider, otherProvider], activeProviderId: 'zhipu', ...extra },
}).element)

/** 一个 select 底下的全部 option（含 optgroup 里的），按渲染顺序。 */
const allOptionsOf = (select) => {
  const out = []
  const children = Array.isArray(select?.props?.children) ? select.props.children : []
  for (const child of children) {
    if (child === null || typeof child !== 'object') continue
    if (child.type === 'optgroup') {
      for (const option of Array.isArray(child.props.children) ? child.props.children : []) {
        if (option !== null && typeof option === 'object') out.push(option)
      }
      continue
    }
    out.push(child)
  }
  return out
}

/* ① 四个下拉存在，选项是所有服务商模型的并集，按服务商分组 */
const routesBundle = sectionWithRecording({ size: '1024x1024' })
const routesTree = routesPageWith(routesBundle, {})
const generateOptionNames = modelOptionsOf(routesTree, ROUTE_SELECTS['generate.primary']).map((entry) => entry.data['data-model'])
check(
  '主页四个下拉都在（自绘触发器 + listbox 语义）：生图 / 生图备用 / 修图 / 修图备用',
  Object.values(ROUTE_SELECTS).every((id) => dropdownById(routesTree, id) !== undefined && triggerById(routesTree, id) !== undefined)
    && Object.values(ROUTE_SELECTS).every((id) => triggerById(routesTree, id)?.props['aria-haspopup'] === 'listbox')
    && dropdownById(routesTree, ROUTE_SELECTS['generate.fallback']) !== undefined
    && dropdownById(routesTree, ROUTE_SELECTS['edit.fallback']) !== undefined,
  Object.values(ROUTE_SELECTS).map((id) => `${id}:${dropdownById(routesTree, id) !== undefined}`).join(','),
)
check(
  '选项是所有服务商模型的并集，且按服务商分组（小标题 = 服务商名，带「— 名称 —」大写标记）',
  groupLabelsOf(routesTree, ROUTE_SELECTS['generate.primary']).join(',') === '— 智谱 —,— OPENAI —,— OTHER —'
    && generateOptionNames.join(',') === 'qwen-image-2.1-pro,qwen-image-3.0-pro,qwen-image-3.0,qwen-image-2.0-pro,qwen-image-2.0-2026-03-03,qwen-image-2.0-pro-2026-04-22,wan2.7-image,wan2.7-image-pro,z-image-turbo,gpt-image-1,dall-e-3,gemini-3.1-flash-image,gpt-image-2',
  JSON.stringify({ groups: groupLabelsOf(routesTree, ROUTE_SELECTS['generate.primary']), options: generateOptionNames.length }).slice(0, 260),
)
check(
  '选项里每项都带 providerId 与 model（跨服务商选择知道用哪家的地址与凭据）',
  modelOptionsOf(routesTree, ROUTE_SELECTS['generate.primary']).every((entry) => typeof entry.data?.['data-provider'] === 'string' && entry.data['data-provider'] !== '' && typeof entry.data['data-model'] === 'string' && entry.value === `${entry.data['data-provider']}::${entry.data['data-model']}`),
  JSON.stringify(modelOptionsOf(routesTree, ROUTE_SELECTS['generate.primary'])[0] ?? null).slice(0, 200),
)

/* ①b 占位只出现在触发器上：菜单里没有可点的空值项，也绝不静默跳到第一个模型 */
const unsetDropdown = dropdownById(routesTree, ROUTE_SELECTS['generate.primary'])
check(
  '未设置时：触发器显示占位「主模型」、aria-expanded=false，且菜单里没有空值项（不会静默跳到第一个模型）',
  unsetDropdown?.props.value === ''
    && triggerTextOf(routesTree, ROUTE_SELECTS['generate.primary']) === '主模型'
    && triggerById(routesTree, ROUTE_SELECTS['generate.primary'])?.props['aria-expanded'] === 'false'
    && entryOptionsOf(routesTree, ROUTE_SELECTS['generate.primary']).every((entry) => entry.value !== '')
    && modelOptionsOf(routesTree, ROUTE_SELECTS['generate.primary']).length > 0,
  JSON.stringify({
    value: unsetDropdown?.props?.value ?? null,
    trigger: triggerTextOf(routesTree, ROUTE_SELECTS['generate.primary']),
    emptyOptions: entryOptionsOf(routesTree, ROUTE_SELECTS['generate.primary']).filter((entry) => entry.value === '').length,
  }),
)
check(
  '已设置时选中的就是那个模型（触发器显示模型名，选项里能精确匹配到服务商+模型）',
  (() => {
    const setTree = routesPageWith(routesBundle, {
      routes: routesSeed({ 'generate.primary': routeItem('other', 'gemini-3.1-flash-image') }),
    })
    const setDropdown = dropdownById(setTree, ROUTE_SELECTS['generate.primary'])
    const matched = modelOptionsOf(setTree, ROUTE_SELECTS['generate.primary']).find((entry) => entry.value === setDropdown?.props?.value)
    return setDropdown?.props.value === 'other::gemini-3.1-flash-image'
      && triggerTextOf(setTree, ROUTE_SELECTS['generate.primary']) === 'gemini-3.1-flash-image'
      && matched !== undefined
      && matched.data['data-provider'] === 'other'
      && matched.data['data-model'] === 'gemini-3.1-flash-image'
  })(),
  String(dropdownById(routesPageWith(routesBundle, { routes: routesSeed({ 'generate.primary': routeItem('other', 'gemini-3.1-flash-image') }) }), ROUTE_SELECTS['generate.primary'])?.props.value ?? null),
)

/* ①c 分组标题的区分策略：文本标记 + 加粗样式，模型名一个字不改 */
check(
  '分组标题带文本标记（破折号包裹 + ASCII 大写），并配有加粗样式规则',
  groupLabelsOf(routesTree, ROUTE_SELECTS['generate.primary']).every((label) => /^— .+ —$/u.test(label))
    && groupLabelsOf(routesTree, ROUTE_SELECTS['generate.primary']).join(',') === '— 智谱 —,— OPENAI —,— OTHER —'
    && styles.map((style) => style.textContent).join('').includes('.dib-menu-group{'),
  JSON.stringify(groupLabelsOf(routesTree, ROUTE_SELECTS['generate.primary'])),
)
check(
  '模型名没有被改写（只有分组标题加标记；含截图里那两类真实 id）',
  generateOptionNames.includes('gemini-3.1-flash-image')
    && generateOptionNames.includes('gpt-image-2')
    && modelOptionsOf(routesTree, ROUTE_SELECTS['generate.primary']).every((entry) => entry.label === entry.data['data-model'])
    && generateOptionNames.every((model) => !model.includes('—') && model === model.trim()),
  JSON.stringify(generateOptionNames.slice(-4)),
)

/* ② 默认只含生图模型；勾「显示全部模型」后含语言模型 */
check(
  '默认只含生图模型（11 个语言/向量/语音模型一个都不在）',
  generateOptionNames.length === IMAGE_MODELS.length + 4
    && NON_IMAGE_MODELS.every((model) => !generateOptionNames.includes(model))
    && !generateOptionNames.includes('gpt-4o'),
  JSON.stringify({ count: generateOptionNames.length, leaked: NON_IMAGE_MODELS.filter((m) => generateOptionNames.includes(m)) }).slice(0, 200),
)
const routesAllTree = routesPageWith(routesBundle, { routesShowAll: true })
const allOptionNames = modelOptionsOf(routesAllTree, ROUTE_SELECTS['generate.primary']).map((entry) => entry.data['data-model'])
check(
  '勾「显示全部模型」后选项含语言模型（并集 + 语言模型）',
  NON_IMAGE_MODELS.every((model) => allOptionNames.includes(model)) && allOptionNames.includes('gpt-4o') && allOptionNames.length === ALL_MODELS.length + 5,
  JSON.stringify({ count: allOptionNames.length }).slice(0, 160),
)

/* ③ 默认选中值来自 modelRoutes；手动输入通道带 providerId = 当前生效服务商 */
const selectedRoutesTree = routesPageWith(routesBundle, {
  routes: routesSeed({ 'generate.primary': routeItem('openai', 'dall-e-3'), 'generate.fallback': routeItem('zhipu', 'wan2.7-image') }),
})
check(
  '选中值回填到对应下拉（含「哪家服务商」）',
  selectById(selectedRoutesTree, ROUTE_SELECTS['generate.primary'])?.props.value === 'openai::dall-e-3'
    && selectById(selectedRoutesTree, ROUTE_SELECTS['generate.fallback'])?.props.value === 'zhipu::wan2.7-image'
    && selectById(selectedRoutesTree, ROUTE_SELECTS['edit.primary'])?.props.value === '',
  JSON.stringify({
    primary: selectById(selectedRoutesTree, ROUTE_SELECTS['generate.primary'])?.props.value ?? null,
    fallback: selectById(selectedRoutesTree, ROUTE_SELECTS['generate.fallback'])?.props.value ?? null,
  }),
)

/* ③b 空选项文案与说明小字（用户逐字确认过的措辞） */
const optionTextAt = (select, index) => {
  if (select === undefined) return ''
  const texts = select.props.optionTexts
  if (Array.isArray(texts)) return String(texts[index] ?? '')
  const children = Array.isArray(select.props.children) ? select.props.children : [select.props.children]
  const option = children.filter((child) => child !== null && typeof child === 'object')[index]
  return option === undefined ? '' : textOfElement(option).trim()
}
const hintTextOf = (tree, id) => {
  const node = tree.nodes.find((entry) => entry.type === 'p' && entry.props?.id === id)
  return node === undefined ? '' : textOfElement(node).trim()
}
check(
  '四个下拉的占位文案按槽位命名：主模型 / 备用模型 / 主模型 / 备用模型（在触发器上，不在菜单里）',
  triggerTextOf(routesTree, ROUTE_SELECTS['generate.primary']) === '主模型'
    && triggerTextOf(routesTree, ROUTE_SELECTS['generate.fallback']) === '备用模型'
    && triggerTextOf(routesTree, ROUTE_SELECTS['edit.primary']) === '主模型'
    && triggerTextOf(routesTree, ROUTE_SELECTS['edit.fallback']) === '备用模型'
    // 同一句文案不进菜单：菜单里没有空值项，用户点不到"清空"（与 task-20 的既定行为一致）。
    && Object.values(ROUTE_SELECTS).every((id) => entryOptionsOf(routesTree, id).every((entry) => entry.value !== '')),
  JSON.stringify(Object.entries(ROUTE_SELECTS).map(([slot, id]) => `${slot}=${triggerTextOf(routesTree, id)}`)),
)
check(
  '两条说明小字是最终文案（zh 不带句尾句号、en 保留英文句号）',
  hintTextOf(routesTree, `${ROUTE_SELECTS['generate.primary']}-hint`) === '工具调用时优先使用'
    && hintTextOf(routesTree, `${ROUTE_SELECTS['generate.fallback']}-hint`) === '主模型连不上或这次没出图时，自动改用'
    && zhDict['route.primaryHint'] === '工具调用时优先使用'
    && zhDict['route.fallbackHint'] === '主模型连不上或这次没出图时，自动改用'
    && zhDict['route.unset'] === '主模型'
    && zhDict['route.noFallback'] === '备用模型'
    && enDict['route.primaryHint'] === 'Used first when the tools call the API.'
    && enDict['route.fallbackHint'] === 'Used when the primary cannot be reached or returns no image.'
    && enDict['route.unset'] === 'Primary model'
    && enDict['route.noFallback'] === 'Fallback model',
  JSON.stringify({
    zhPrimary: hintTextOf(routesTree, `${ROUTE_SELECTS['generate.primary']}-hint`),
    zhFallback: hintTextOf(routesTree, `${ROUTE_SELECTS['generate.fallback']}-hint`),
    enPrimary: enDict['route.primaryHint'],
    enFallback: enDict['route.fallbackHint'],
  }).slice(0, 320),
)
check(
  '主用与备用成对紧邻（两对），对内有更小的行距、对间保留分隔',
  (() => {
    const pairs = routesTree.nodes.filter((node) => node.props?.className === 'dib-route-pair')
    const slotsOf = (pair) => (Array.isArray(pair?.props?.children) ? pair.props.children : []).map((child) => child?.props?.['data-route-slot'])
    const cssText = styles.map((style) => style.textContent).join('')
    return pairs.length === 2
      && slotsOf(pairs[0]).join(',') === 'generate.primary,generate.fallback'
      && slotsOf(pairs[1]).join(',') === 'edit.primary,edit.fallback'
      && cssText.includes('.dib-route-pair .dib-field+.dib-field{border-top:none}')
      && cssText.includes('.dib-route-pair+.dib-route-pair{margin-top:')
  })(),
  JSON.stringify(routesTree.nodes.filter((node) => node.props?.className === 'dib-route-pair').length),
)

/* ③c 备用两行去掉可见标签，但语义（aria-label）保留 */
const slotGroupOf = (tree, slot) => tree.nodes.find((node) => node.props?.['data-route-slot'] === slot)
const labelsIn = (node) => {
  const found = []
  walk(node, (item) => {
    if (item !== null && typeof item === 'object' && item.type === 'label') found.push(item)
  })
  return found
}
const routeCssText = styles.map((style) => style.textContent).join('')
check(
  '两个备用下拉不再有可见标签，但保留等价的 aria-label（视觉删、语义留）',
  labelsIn(slotGroupOf(routesTree, 'generate.fallback')).length === 0
    && labelsIn(slotGroupOf(routesTree, 'edit.fallback')).length === 0
    && selectById(routesTree, ROUTE_SELECTS['generate.fallback'])?.props['aria-label'] === '生图备用模型'
    && selectById(routesTree, ROUTE_SELECTS['edit.fallback'])?.props['aria-label'] === '修图备用模型'
    && zhDict['route.generate.fallback'] === '生图备用模型'
    && zhDict['route.edit.fallback'] === '修图备用模型'
    && enDict['route.generate.fallback'] === 'Image fallback model'
    && enDict['route.edit.fallback'] === 'Edit fallback model',
  JSON.stringify({
    generate: selectById(routesTree, ROUTE_SELECTS['generate.fallback'])?.props['aria-label'] ?? null,
    edit: selectById(routesTree, ROUTE_SELECTS['edit.fallback'])?.props['aria-label'] ?? null,
    labels: labelsIn(slotGroupOf(routesTree, 'generate.fallback')).length,
  }).slice(0, 220),
)
check(
  '两个主用下拉仍然带可见标签，并指向自己的下拉',
  labelsIn(slotGroupOf(routesTree, 'generate.primary')).some((label) => label.props?.htmlFor === ROUTE_SELECTS['generate.primary'])
    && labelsIn(slotGroupOf(routesTree, 'edit.primary')).some((label) => label.props?.htmlFor === ROUTE_SELECTS['edit.primary']),
  JSON.stringify(labelsIn(slotGroupOf(routesTree, 'generate.primary')).map((label) => label.props?.htmlFor ?? null)),
)
check(
  '删标签后收紧间隙：备用行没有空标签行，上内边距被收掉，对间分隔仍在',
  labelsIn(slotGroupOf(routesTree, 'generate.fallback')).length === 0
    && routeCssText.includes('.dib-routes .dib-route-fallback{padding-top:0}')
    && routeCssText.includes('.dib-route-pair+.dib-route-pair{margin-top:'),
  JSON.stringify({
    tightened: routeCssText.includes('.dib-routes .dib-route-fallback{padding-top:0}'),
    pairGap: routeCssText.includes('.dib-route-pair+.dib-route-pair{margin-top:'),
  }),
)
/* 把 t 换成英文词典渲染一遍：aria-label 与空选项必须跟着语言包走，不能是硬编码中文 */
const enRoutesTree = treeOf(invoke(routesBundle.component, {
  t: (key) => enDict[key] ?? key,
  close: () => {},
  __initial: { phase: 'idle', providers: [zhipuFull, openaiProvider], activeProviderId: 'zhipu' },
}).element)
check(
  '备用下拉的 aria-label 与四个占位文案都走语言包（英文环境下是英文）',
  triggerById(enRoutesTree, ROUTE_SELECTS['generate.fallback'])?.props['aria-label'] === 'Image fallback model'
    && triggerById(enRoutesTree, ROUTE_SELECTS['edit.fallback'])?.props['aria-label'] === 'Edit fallback model'
    && triggerTextOf(enRoutesTree, ROUTE_SELECTS['generate.primary']) === 'Primary model'
    && triggerTextOf(enRoutesTree, ROUTE_SELECTS['generate.fallback']) === 'Fallback model'
    && hintTextOf(enRoutesTree, `${ROUTE_SELECTS['generate.primary']}-hint`) === 'Used first when the tools call the API.',
  JSON.stringify({
    aria: triggerById(enRoutesTree, ROUTE_SELECTS['generate.fallback'])?.props['aria-label'] ?? null,
    empty: triggerTextOf(enRoutesTree, ROUTE_SELECTS['generate.primary']),
  }).slice(0, 200),
)

/* ④ 没有任何已连接的模型时：四个下拉禁用 + 一行提示 */
const noConnectedTree = routesPageWith(routesBundle, { providers: [{ ...providerRecord, models: [] }] })
check(
  '没有已连接模型时四个下拉禁用，并提示先添加并测试连接',
  Object.values(ROUTE_SELECTS).every((id) => selectById(noConnectedTree, id)?.props.disabled === true)
    && noConnectedTree.text.includes('先添加并测试连接一个模型提供商'),
  JSON.stringify(Object.values(ROUTE_SELECTS).map((id) => selectById(noConnectedTree, id)?.props.disabled ?? null)),
)

/* ⑤ 选择后保存：patch 里 modelRoutes.generate.primary 同时带 providerId 与 model */
const saveRoutesBundle = sectionWithRecording({ size: '1024x1024' })
const saveRoutesSession = createSession(saveRoutesBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', providers: [zhipuFull, openaiProvider], activeProviderId: 'zhipu' },
})
let saveRoutesTree = saveRoutesSession.tree()
/* 自绘菜单：点触发器 → 点菜单项（不再是 select 的 change）。 */
saveRoutesTree = openDropdownTree(saveRoutesSession, ROUTE_SELECTS['generate.primary'])
saveRoutesSession.click(menuItemByValueOf(menuOf(saveRoutesTree, ROUTE_SELECTS['generate.primary']), 'openai::dall-e-3'))
saveRoutesTree = openDropdownTree(saveRoutesSession, ROUTE_SELECTS['generate.fallback'])
saveRoutesSession.click(menuItemByValueOf(menuOf(saveRoutesTree, ROUTE_SELECTS['generate.fallback']), 'zhipu::wan2.7-image'))
saveRoutesTree = saveRoutesSession.tree()
const routeSaveButton = saveRoutesTree.nodes.find((node) => node.type === 'button' && node.props?.['data-dib-action'] === 'save-routes')
saveRoutesSession.click(routeSaveButton)
await sleep(30)
const routesSavedTree = saveRoutesSession.tree()
const routesPatch = saveRoutesBundle.updates[0]?.patch
check(
  '保存后 modelRoutes.generate.primary 同时带正确的 providerId 与 model',
  routesPatch !== undefined
    && routesPatch.modelRoutes?.generate?.primary?.providerId === 'openai'
    && routesPatch.modelRoutes?.generate?.primary?.model === 'dall-e-3'
    && routesPatch.modelRoutes?.generate?.fallback?.providerId === 'zhipu'
    && routesPatch.modelRoutes?.generate?.fallback?.model === 'wan2.7-image'
    && routesPatch.modelRoutes?.edit?.primary?.providerId === ''
    && routesPatch.connectTimeoutSeconds === CLIENT_DEFAULT_CONNECT_S
    // activeProviderId 仍然原样写回：界面不再有切换入口，但 Host 的三级回退要用它。
    && routesPatch.activeProviderId === 'zhipu',
  JSON.stringify(routesPatch ?? null).slice(0, 320),
)
check(
  '保存模型设置的反馈同样紧邻它的按钮（在模型区块的 footer 里，不在页面底部）',
  (() => {
    const row = statusRowsOf(routesSavedTree)[0]
    return row !== undefined
      && textOfElement(row).trim() === '模型设置已保存'
      && (routesFooterOf(routesSavedTree)?.props?.children ?? []).includes(row)
      && atPageBottomOf(routesSavedTree, row) === false
  })(),
  JSON.stringify({ rows: statusRowsOf(routesSavedTree).map((node) => textOfElement(node).trim()) }).slice(0, 200),
)

/* ⑥ 手动输入：providerId 取当前生效服务商，模型名写进对应槽位 */
const manualRouteBundle = sectionWithRecording({ size: '1024x1024' })
const manualRouteSession = createSession(manualRouteBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', providers: [zhipuFull, openaiProvider], activeProviderId: 'zhipu' },
})
let manualRouteTree = manualRouteSession.tree()
manualRouteTree = openDropdownTree(manualRouteSession, ROUTE_SELECTS['edit.primary'])
manualRouteSession.click(menuItemByValueOf(menuOf(manualRouteTree, ROUTE_SELECTS['edit.primary']), MANUAL_MODEL_VALUE))
manualRouteTree = manualRouteSession.tree()
const manualRouteInput = inputById(manualRouteTree, `${ROUTE_SELECTS['edit.primary']}-manual`)
check(
  '选「手动输入…」后出现文本框，界面上说明走的是当前生效服务商',
  dropdownById(manualRouteTree, ROUTE_SELECTS['edit.primary'])?.props.value === MANUAL_MODEL_VALUE
    && manualRouteInput !== undefined
    && manualRouteTree.text.includes('手动填写的模型走当前生效服务商'),
  JSON.stringify({ value: dropdownById(manualRouteTree, ROUTE_SELECTS['edit.primary'])?.props.value ?? null, input: manualRouteInput !== undefined }),
)
manualRouteSession.change(manualRouteInput, 'my-own-edit-model')
manualRouteTree = manualRouteSession.tree()
manualRouteSession.click(manualRouteTree.nodes.find((node) => node.type === 'button' && node.props?.['data-dib-action'] === 'save-routes'))
await sleep(30)
const manualRoutesPatch = manualRouteBundle.updates[0]?.patch
check(
  '手填的模型名写进 modelRoutes.edit.primary，providerId 取当前生效服务商',
  manualRoutesPatch?.modelRoutes?.edit?.primary?.model === 'my-own-edit-model'
    && manualRoutesPatch?.modelRoutes?.edit?.primary?.providerId === 'zhipu',
  JSON.stringify(manualRoutesPatch?.modelRoutes ?? null).slice(0, 240),
)

/* ⑦ 连接超时（秒）：非法值不落盘，合法值 / 留空按默认写，zh/en 文案成对 */
const CONNECT_TIMEOUT_INPUT = 'dib-connect-timeout'
const saveRoutesButtonOf = (tree) => tree.nodes.find((node) => node.type === 'button' && node.props?.['data-dib-action'] === 'save-routes')
const timeoutBundle = sectionWithRecording({ size: '1024x1024' })
const timeoutSession = createSession(timeoutBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', providers: [zhipuFull, openaiProvider], activeProviderId: 'zhipu' },
})
let timeoutTree = timeoutSession.tree()
/*
 * 非法输入**逐个**过一遍再断言：Host 只认正整数秒（`Number.isInteger(x) && x > 0`），
 * 界面必须同一口径——非数字、0、负数、小数一个都不许"洗"成默认值，一个都不许落盘。
 */
const refusedDrafts = ['abc', '0', '-5', '1.5']
for (const draft of refusedDrafts) {
  timeoutSession.change(inputById(timeoutTree, CONNECT_TIMEOUT_INPUT), draft)
  timeoutTree = timeoutSession.tree()
  timeoutSession.click(saveRoutesButtonOf(timeoutTree))
  await sleep(30)
  timeoutTree = timeoutSession.tree()
}
check(
  '连接超时填了非法值（非数字 / 0 / 负数 / 小数）时一次都不写入，并给出点名字段的原因',
  timeoutBundle.updates.length === 0
    && refusedDrafts.every((draft) => inputById(timeoutTree, CONNECT_TIMEOUT_INPUT) !== undefined)
    && timeoutTree.text.includes('连接超时必须是正整数秒数'),
  JSON.stringify({ updates: timeoutBundle.updates.length, hint: timeoutTree.text.includes('连接超时必须是正整数秒数') }).slice(0, 160),
)
timeoutSession.change(inputById(timeoutTree, CONNECT_TIMEOUT_INPUT), '20')
timeoutTree = timeoutSession.tree()
timeoutSession.click(saveRoutesButtonOf(timeoutTree))
await sleep(30)
check(
  '连接超时改成合法值后**按秒**写进 patch（connectTimeoutSeconds=20，不是毫秒）',
  timeoutBundle.updates[0]?.patch?.connectTimeoutSeconds === 20
    && timeoutBundle.updates[0]?.patch?.fallbackAfterMs === undefined,
  JSON.stringify(timeoutBundle.updates[0]?.patch?.connectTimeoutSeconds ?? null),
)
timeoutSession.change(inputById(timeoutTree, CONNECT_TIMEOUT_INPUT), '')
timeoutTree = timeoutSession.tree()
timeoutSession.click(saveRoutesButtonOf(timeoutTree))
await sleep(30)
check(
  '连接超时留空按默认值写（值从 client.js 的 DEFAULT_CONNECT_TIMEOUT_S 读，避免两边漂移）',
  timeoutBundle.updates[1]?.patch?.connectTimeoutSeconds === CLIENT_DEFAULT_CONNECT_S,
  JSON.stringify(timeoutBundle.updates.map((entry) => entry.patch.connectTimeoutSeconds)),
)
check(
  '连接超时的标签 / 占位 / 说明 / 报错在 zh 与 en 里成对（写明单位是秒、默认 15）',
  zhDict['connectTimeoutSeconds'] === '连接超时(秒)'
    && enDict['connectTimeoutSeconds'] === 'Connect timeout (seconds)'
    && zhDict['connectTimeoutSeconds.placeholder'] === String(CLIENT_DEFAULT_CONNECT_S)
    && enDict['connectTimeoutSeconds.placeholder'] === String(CLIENT_DEFAULT_CONNECT_S)
    && String(zhDict['connectTimeoutSeconds.hint']).includes('秒')
    && String(enDict['connectTimeoutSeconds.hint']).includes('seconds')
    && String(zhDict['connectTimeoutSeconds.hint']).includes(String(CLIENT_DEFAULT_CONNECT_S))
    && zhDict['connectTimeoutSeconds.hint'] !== enDict['connectTimeoutSeconds.hint']
    && String(zhDict['connectTimeoutInvalid']).includes('连接超时')
    && String(enDict['connectTimeoutInvalid']).includes('connect timeout')
    && zhDict['connectTimeoutInvalid'] !== enDict['connectTimeoutInvalid']
    // 备用模型自己的连接上限是固定的 30 秒，不是设置项——它不该出现在界面上。
    && !timeoutTree.text.includes('固定 30')
    && !Object.keys(zhDict).some((key) => key.includes('fallbackConnect'))
    && !Object.keys(enDict).some((key) => key.includes('fallbackConnect')),
  JSON.stringify({ zhLabel: zhDict['connectTimeoutSeconds'], enLabel: enDict['connectTimeoutSeconds'], zhInvalid: zhDict['connectTimeoutInvalid'] }).slice(0, 240),
)

/* ⑧ 主页改选择后，浮层里的「当前生图模型」标记跟着走（同一份状态） */const linkedBundle = sectionWithRecording({ size: '1024x1024' })
const linkedSession = createSession(linkedBundle.component, {
  t: undefined,
  close: () => {},
  __initial: {
    phase: 'idle',
    providers: [zhipuFull],
    activeProviderId: 'zhipu',
    editor: { mode: 'edit', initial: editorInitialFor(ALL_MODELS) },
  },
})
let linkedTree = linkedSession.tree()
linkedTree = openDropdownTree(linkedSession, ROUTE_SELECTS['generate.primary'])
linkedSession.click(menuItemByValueOf(menuOf(linkedTree, ROUTE_SELECTS['generate.primary']), 'zhipu::qwen-image-3.0'))
linkedTree = linkedSession.tree()
check(
  '主页菜单里改了生图模型后，浮层对应行同步打上「当前生图模型」',
  textOfElement(routedRowOf(linkedTree, 'qwen-image-3.0')).includes('当前生图模型')
    && !textOfElement(routedRowOf(linkedTree, 'qwen-image-2.1-pro')).includes('当前生图模型')
    && dropdownById(linkedTree, ROUTE_SELECTS['generate.primary'])?.props.value === 'zhipu::qwen-image-3.0',
  JSON.stringify({ value: dropdownById(linkedTree, ROUTE_SELECTS['generate.primary'])?.props.value ?? null }).slice(0, 160),
)


/* ------------------------------------------------------------------ *
 * 默认尺寸：常用预设下拉 + 「自定义…」
 * ------------------------------------------------------------------ */

const SIZE_SELECT = 'dib-size'
const SIZE_CUSTOM_INPUT = 'dib-size-custom'
const CUSTOM_SIZE_VALUE_FOR_TEST = '__dib_custom_size__'
const SIZE_PRESETS_EXPECTED = ['1024x1024', '1024x1536', '1536x1024', '768x1024', '1024x768', '512x512', '1792x1024', '1024x1792']

const sizeTree = pageWith(routesBundle, { size: '1024x1024' })
const sizeSelect = selectById(sizeTree, SIZE_SELECT)
const sizeOptionValues = optionValuesOf(sizeSelect)
check(
  '默认尺寸是预设下拉：八个常用尺寸 + 「自定义…」，默认选中 1024x1024',
  sizeOptionValues.slice(0, SIZE_PRESETS_EXPECTED.length).join(',') === SIZE_PRESETS_EXPECTED.join(',')
    && sizeOptionValues[SIZE_PRESETS_EXPECTED.length] === CUSTOM_SIZE_VALUE_FOR_TEST
    && sizeSelect?.props.value === '1024x1024'
    && inputById(sizeTree, SIZE_CUSTOM_INPUT) === undefined,
  JSON.stringify({ options: sizeOptionValues.length, value: sizeSelect?.props.value ?? null }).slice(0, 220),
)
check(
  '预设把比例写在文案里（value 仍是尺寸本身），zh / en 都有这些文案',
  optionTextAt(sizeSelect, 0) === '1024x1024（1:1 默认）'
    && optionTextAt(sizeSelect, 1) === '1024x1536（2:3 竖版）'
    && optionTextAt(sizeSelect, 4) === '1024x768（4:3 横版）'
    && optionValuesOf(sizeSelect)[1] === '1024x1536'
    && zhDict['size.preset.768x1024'] === '768x1024（3:4 竖版）'
    && enDict['size.preset.768x1024'] === '768x1024 (3:4 portrait)'
    && zhDict['size.custom'] === '自定义…'
    && enDict['size.custom'] === 'Custom…',
  JSON.stringify({ first: optionTextAt(sizeSelect, 0), second: optionTextAt(sizeSelect, 1), en: enDict['size.preset.768x1024'] }).slice(0, 220),
)
check(
  '配置里没写尺寸时显示默认 1024x1024，且不进入自定义模式',
  selectById(pageWith(routesBundle, { size: '' }), SIZE_SELECT)?.props.value === '1024x1024'
    && inputById(pageWith(routesBundle, { size: '' }), SIZE_CUSTOM_INPUT) === undefined,
  String(selectById(pageWith(routesBundle, { size: '' }), SIZE_SELECT)?.props.value ?? null),
)

/* 字段排版：标签在控件上方（与其它字段同一套 .dib-field 结构） */
const tagOrderOf = (node) => {
  const order = []
  walk(node, (item) => {
    if (item !== null && typeof item === 'object' && typeof item.type === 'string') order.push(item.type)
  })
  return order
}
const dibClassesOf = (node) => String(node?.props?.className ?? '').split(/\s+/u).filter((name) => name.startsWith('dib-'))
const sizeFieldNode = sizeTree.nodes.find((node) => node.props?.['data-dib-field'] === 'size')
const sizeFieldOrder = tagOrderOf(sizeFieldNode)
const sizeFieldLabel = (() => {
  let found
  walk(sizeFieldNode, (item) => {
    if (found === undefined && item !== null && typeof item === 'object' && item.type === 'label') found = item
  })
  return found
})()
check(
  '尺寸字段的标签是「图片尺寸」（英文包同步为 Image size）',
  textOfElement(sizeFieldLabel).trim() === '图片尺寸'
    && zhDict['size'] === '图片尺寸'
    && enDict['size'] === 'Image size',
  JSON.stringify({ rendered: textOfElement(sizeFieldLabel).trim(), zh: zhDict['size'], en: enDict['size'] }),
)
check(
  '「默认尺寸」的标签在控件上方（field 内独立 label，文档顺序在下拉之前）且仍与下拉关联',
  sizeFieldOrder[0] === 'div'
    && sizeFieldOrder[1] === 'label'
    && sizeFieldOrder.indexOf('button') > sizeFieldOrder.indexOf('label')
    && sizeFieldOrder.lastIndexOf('label') < sizeFieldOrder.indexOf('button')
    && sizeFieldLabel?.props?.htmlFor === 'dib-size'
    && dropdownById(sizeTree, SIZE_SELECT)?.props?.id === 'dib-size'
    && triggerById(sizeTree, SIZE_SELECT)?.props?.id === 'dib-size'
    // field 是纵向排列（标签在上、控件在下），而不是把两者并排放在一个行内盒子里。
    && styles.map((style) => style.textContent).join('').includes('.dib-field{display:flex;flex-direction:column;'),
  JSON.stringify({ order: sizeFieldOrder.slice(0, 6), htmlFor: sizeFieldLabel?.props?.htmlFor ?? null }).slice(0, 200),
)
check(
  '默认尺寸与路由字段共用同一套 field 结构/类名（不会再退回左侧内联）',
  dibClassesOf(sizeFieldNode).includes('dib-field')
    && dibClassesOf(slotGroupOf(sizeTree, 'generate.primary')?.props?.children?.[0]).includes('dib-field')
    && tagOrderOf(sizeFieldNode).slice(0, 2).join(',') === tagOrderOf(slotGroupOf(sizeTree, 'generate.primary')?.props?.children?.[0]).slice(0, 2).join(',')
    && sizeTree.nodes.every((node) => node.props?.className !== 'dib-defaults'),
  JSON.stringify({ size: dibClassesOf(sizeFieldNode), route: dibClassesOf(slotGroupOf(sizeTree, 'generate.primary')?.props?.children?.[0]) }),
)
check(
  '「保存尺寸」与下拉同处一行（同一 controls 容器 + 可换行），不与下拉抢宽度',
  (() => {
    const controls = (sizeFieldNode?.props?.children ?? []).find((child) => child?.props?.className === 'dib-size-controls')
    const children = (controls?.props?.children ?? []).filter(Boolean)
    const dropdown = children.find((child) => child?.props?.id === 'dib-size' || child?.props?.className === 'dib-dd')
    const order = tagOrderOf(controls)
    return controls !== undefined
      && dropdown !== undefined
      && order.includes('button')
      && order.indexOf('button') > order.indexOf('div')
      && styles.map((style) => style.textContent).join('').includes('.dib-size-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}')
  })(),
  JSON.stringify(sizeFieldOrder.slice(0, 6)),
)

/* 手填尺寸：选「自定义…」→ 出现文本框 → 保存后 patch.size 就是它 */
const sizeSaveBundle = sectionWithRecording({ size: '1024x1024' })
const sizeSession = createSession(sizeSaveBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', providers: [zhipuFull], activeProviderId: 'zhipu', size: '1024x1024' },
})
let sizeLiveTree = sizeSession.tree()
sizeLiveTree = openDropdownTree(sizeSession, SIZE_SELECT)
sizeSession.click(menuItemByValueOf(menuOf(sizeLiveTree, SIZE_SELECT), CUSTOM_SIZE_VALUE_FOR_TEST))
sizeLiveTree = sizeSession.tree()
const sizeCustomInput = inputById(sizeLiveTree, SIZE_CUSTOM_INPUT)
check(
  '选「自定义…」后下拉切到保留值，并出现尺寸文本框',
  dropdownById(sizeLiveTree, SIZE_SELECT)?.props.value === CUSTOM_SIZE_VALUE_FOR_TEST && sizeCustomInput !== undefined,
  JSON.stringify({ value: dropdownById(sizeLiveTree, SIZE_SELECT)?.props.value ?? null, input: sizeCustomInput !== undefined }),
)
/*
 * 无障碍：这个文本框只在选了「自定义…」时出现，视觉上靠上方下拉说明自己是什么；
 * 但读屏读到一个**没有任何名字**的文本框等于不可用。这里同时钉住两点：
 * 名称来自语言包（中文界面出中文、英文界面出英文），而不是硬编码中文。
 */
check(
  '自定义尺寸文本框带可访问名称（来自语言包，不是无名字的输入框）',
  sizeCustomInput?.props?.['aria-label'] === '图片尺寸（自定义）',
  JSON.stringify(sizeCustomInput?.props?.['aria-label'] ?? null),
)
{
  const enSizeBundle = sectionWithRecording({ size: '1024x1024' })
  const enSizeSession = createSession(enSizeBundle.component, {
    t: (key) => enDict[key] ?? key,
    close: () => {},
    __initial: { phase: 'idle', providers: [zhipuFull], activeProviderId: 'zhipu', size: '1024x1024' },
  })
  let enTree = openDropdownTree(enSizeSession, SIZE_SELECT)
  enSizeSession.click(menuItemByValueOf(menuOf(enTree, SIZE_SELECT), CUSTOM_SIZE_VALUE_FOR_TEST))
  enTree = enSizeSession.tree()
  const enLabel = inputById(enTree, SIZE_CUSTOM_INPUT)?.props?.['aria-label'] ?? null
  check(
    '英文环境下该名称也是英文（硬编码中文会在这里红）',
    enLabel === 'Image size (custom)',
    JSON.stringify(enLabel),
  )
}
sizeSession.change(sizeCustomInput, '1280*720')
sizeLiveTree = sizeSession.tree()
sizeSession.click(sizeLiveTree.nodes.find((node) => node.type === 'button' && textOfElement(node).trim() === '保存尺寸'))
await sleep(30)
check(
  /*
   * 这条断言原先要求"这一次只写 size"——那是在把**部分写**当成正确行为。
   * 审查的 A19 指出：这一页有四处保存写同一行配置，只写自己那部分时，任何一次保存都可能
   * 把别的字段留在旧值上。现在四处都写**完整快照**，所以这里改为钉住新契约：
   *   ① 尺寸确实写进去了；② 同一次写入**必须带上**本页拥有的其它字段，不允许出现只写一半的路径。
   */
  '自定义尺寸 1280*720 保存后写进 size，且这一次写入是完整快照（不再只写一半）',
  sizeSaveBundle.updates[0]?.patch?.size === '1280*720'
    && Array.isArray(sizeSaveBundle.updates[0]?.patch?.providers)
    && typeof sizeSaveBundle.updates[0]?.patch?.activeProviderId === 'string'
    && sizeSaveBundle.updates[0]?.patch?.modelRoutes !== undefined
    && sizeSaveBundle.updates[0]?.patch?.connectTimeoutSeconds !== undefined,
  JSON.stringify(Object.keys(sizeSaveBundle.updates[0]?.patch ?? {})),
)

/* 非预设的历史值：自动进入自定义模式并原样回显，保存也不改写 */
const legacySizeBundle = sectionWithRecording({ size: '999x999' })
const legacySizeSession = createSession(legacySizeBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'idle', providers: [zhipuFull], activeProviderId: 'zhipu', size: '999x999' },
})
const legacyTree = legacySizeSession.tree()
const legacySizeInput = inputById(legacyTree, SIZE_CUSTOM_INPUT)
check(
  '配置里存着非预设尺寸（999x999）时自动进入自定义模式并原样回显',
  selectById(legacyTree, SIZE_SELECT)?.props.value === CUSTOM_SIZE_VALUE_FOR_TEST && legacySizeInput?.props?.value === '999x999',
  JSON.stringify({ value: selectById(legacyTree, SIZE_SELECT)?.props.value ?? null, input: legacySizeInput?.props?.value ?? null }),
)
legacySizeSession.click(legacyTree.nodes.find((node) => node.type === 'button' && textOfElement(node).trim() === '保存尺寸'))
await sleep(30)
check(
  '回显的非预设值保存后原样写回，没有被悄悄改写',
  legacySizeBundle.updates[0]?.patch?.size === '999x999',
  JSON.stringify(legacySizeBundle.updates[0]?.patch?.size ?? null),
)

/* 同一条不变量也要在**载入路径**上成立：从配置里读到 999x999，界面同样是自定义 + 回显 */
const loadSizeBundle = sectionWithRecording({ size: '999x999', baseUrl: 'https://api.example.com/v1', model: 'cogview-4' })
const loadSizeSession = createSession(loadSizeBundle.component, {
  t: undefined,
  close: () => {},
  __initial: { phase: 'loading' },
})
loadSizeSession.tree()
await sleep(30)
const loadedSizeTree = loadSizeSession.tree()
check(
  '载入路径上读到非预设尺寸也进入自定义模式并回显（不是只有注入状态才对）',
  selectById(loadedSizeTree, SIZE_SELECT)?.props.value === CUSTOM_SIZE_VALUE_FOR_TEST
    && inputById(loadedSizeTree, SIZE_CUSTOM_INPUT)?.props?.value === '999x999',
  JSON.stringify({
    value: selectById(loadedSizeTree, SIZE_SELECT)?.props.value ?? null,
    input: inputById(loadedSizeTree, SIZE_CUSTOM_INPUT)?.props?.value ?? null,
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
/*
 * 一个**合成的**标记值（不是任何真实密钥，也不带密钥前缀）：用来证明它只进
 * credentials.set，绝不落进 settings patch 与诊断日志。
 */
const secret = 'unit-test-secret-marker'
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
  '保存把 providers / activeProviderId / 连接超时（**秒**）一起写进 settings.update',
  saveBundle.updates.length === 1 && saveBundle.updates[0].ns === 'image-bridge-v4'
    && Array.isArray(savedPatch.providers) && savedPatch.providers.length === 1
    // 这条路径以前带的是毫秒的 fallbackAfterMs，而且会把非法值悄悄改成默认值；现在是秒。
    && savedPatch.connectTimeoutSeconds === CLIENT_DEFAULT_CONNECT_S
    && savedPatch.fallbackAfterMs === undefined,
  JSON.stringify({ patch: savedPatch.connectTimeoutSeconds ?? null, fallbackAfterMs: savedPatch.fallbackAfterMs ?? null }).slice(0, 200),
)

/*
 * A7 / A8：重复提交。
 *
 * 保存是异步的，而 `state.phase` 要等一次渲染才变成 `saving`。**回车连按两下**（或"回车 +
 * 紧接着点保存"）正好落在这个窗口里：没有同步闸门时会发出两次 `onSubmit`，于是写两遍配置、
 * 必要时还会写两遍密钥。这里让第一次 `update` 一直挂住，模拟那个窗口。
 */
{
  const gateBundle = sectionWithRecording({ size: '1024x1024' }, { gateUpdates: true })
  const gateSession = createSession(gateBundle.component, {
    t: undefined,
    close: () => {},
    __initial: {
      phase: 'idle',
      providers: [],
      activeProviderId: '',
      editor: {
        mode: 'add',
        initial: {
          label: 'Gate Provider',
          baseUrl: 'https://api.example.com/v1',
          keyRef: '',
          models: ['m-alpha'],
          imageModel: 'm-alpha',
          editModel: '',
          keyDraft: 'sk-gate-secret',
        },
      },
    },
  })
  let gateTree = gateSession.tree()
  const form = gateTree.forms[0]
  /* 连续两次提交，中间**不**等待：第二次必须在同步闸门处被挡住。 */
  form.props.onSubmit({ preventDefault() {} })
  form.props.onSubmit({ preventDefault() {} })
  await sleep(30)
  const duringGate = gateBundle.updates.length
  /*
   * 只断言"配置只落一次"。密钥写入发生在 update **之后**（这一步此刻正被挂着），
   * 所以现在 credentialSets 必然是 0——那是闸门在起作用，不是缺陷。
   */
  check(
    'A7/A8 第一次保存还没回来时再提交一次，只落一次盘（不会写两遍配置）',
    duringGate === 1,
    JSON.stringify({ updates: duringGate, credentialSets: gateBundle.credentialSets.length }),
  )
  /* 放行第一次，闸门必须复位——否则用户第二次点保存会被**无声吞掉**。 */
  gateBundle.releaseGate()
  await sleep(40)
  /*
   * 复位用**页面级的「保存尺寸」按钮**来验：上面那次保存成功后浮层会正常关闭（这是对的行为），
   * 没有浮层就没有表单可提交。保存尺寸走的是同一把闸门（`pendingRef`），
   * 所以它能证明"提交结束后锁被释放了"——这正是这里要钉住的。
   */
  gateTree = gateSession.tree()
  const sizeSaveOf = (tree) => tree.nodes.find((node) => node.type === 'button' && node.props?.['data-dib-action'] === 'save-size')
    ?? tree.buttons.find((button) => textOfElement(button).trim() === '保存尺寸')
  gateSession.click(sizeSaveOf(gateTree))
  await sleep(40)
  /*
   * 期望 2 而不是 1：这条断言要证明的是"锁被释放了"（所以第二次点击真的落盘了）。
   * 桩把**每一次** update 都挂住，所以这次点击本身也停在挂起状态——不影响结论。
   */
  check(
    'A7/A8 一次提交结束后闸门复位（保存成功后仍能再次保存）',
    gateBundle.updates.length === 2,
    JSON.stringify({ updates: gateBundle.updates.length, clicked: sizeSaveOf(gateTree) !== undefined }),
  )
  gateBundle.releaseGate()
  await sleep(30)
}

/*
 * A7/A8 的第二半：**四条保存路径共用同一把锁**。
 *
 * A19 之后它们写的是同一套完整字段，两个保存并发时后落盘的那个会把前一个的结果整片覆盖
 * （各自读的是自己那份快照，谁后写谁赢）。所以"尺寸保存"与"提供商保存"必须互斥——
 * 这条断言在缺口存在时会红（实测：补锁之前 `saveSize` 与 `saveRoutes` 都没走闸门）。
 */
{
  const mixBundle = sectionWithRecording({ size: '1024x1024' }, { gateUpdates: true })
  const mixSession = createSession(mixBundle.component, {
    t: undefined,
    close: () => {},
    __initial: {
      phase: 'idle',
      providers: [],
      activeProviderId: '',
      editor: {
        mode: 'add',
        initial: { label: 'Mix Provider', baseUrl: 'https://api.example.com/v1', keyRef: '', models: ['m-alpha'], imageModel: 'm-alpha', editModel: '' },
      },
    },
  })
  let mixTree = mixSession.tree()
  // 提供商保存先挂住，然后立刻点「保存尺寸」——它必须被同一把锁挡住。
  mixTree.forms[0].props.onSubmit({ preventDefault() {} })
  await sleep(20)
  const afterSubmit = mixBundle.updates.length
  const sizeButton = mixTree.nodes.find((node) => node.type === 'button' && node.props?.['data-dib-action'] === 'save-size')
    ?? mixTree.buttons.find((button) => textOfElement(button).trim() === '保存尺寸')
  mixSession.click(sizeButton)
  await sleep(30)
  check(
    'A7/A8 提供商保存进行中时，保存尺寸被同一把锁挡住（两条路写同一套字段，并发会互相覆盖）',
    afterSubmit === 1 && mixBundle.updates.length === 1,
    JSON.stringify({ afterSubmit, total: mixBundle.updates.length }),
  )
  mixBundle.releaseGate()
  await sleep(40)
}

/*
 * A19 的回归防线：这一页有四处保存（删除提供商 / 保存提供商 / 保存模型设置 / 保存尺寸），
 * 它们写的是**同一行配置**。只要有一条路径只写自己那部分，就会出现「甲写一半、乙写另一半」
 * 的窗口——用户在 A 处的改动可能被 B 处的保存留在旧值上。
 *
 * 这条断言不看某个具体路径写了什么，而是钉住**字段全集一致**：四条路径写入的键名集合必须
 * 完全相同，且必须覆盖本页拥有的全部字段。将来有人新加一条只写一半的保存路径，这里会红。
 */
{
  const PAGE_OWNED_FIELDS = ['providers', 'activeProviderId', 'modelRoutes', 'connectTimeoutSeconds', 'size']
  const keySets = saveBundle.updates.map((entry) => Object.keys(entry.patch ?? {}).sort().join(','))
  const allSame = keySets.length > 0 && new Set(keySets).size === 1
  const coversAll = keySets.length > 0 && PAGE_OWNED_FIELDS.every((field) => keySets[0].split(',').includes(field))
  check(
    '本页每次保存都写同一套完整字段（不会只写一半，A19）',
    allSame && coversAll,
    JSON.stringify({ keySets, missing: keySets.length === 0 ? PAGE_OWNED_FIELDS : PAGE_OWNED_FIELDS.filter((field) => !keySets[0].split(',').includes(field)) }).slice(0, 240),
  )
}
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
  /*
   * 原先这条只要求"别记明文"，`keyLength` 是被**允许**的。审计指出：密钥长度也是凭据元数据，
   * 能把穷举空间缩小一截，而对排查没有帮助（要回答的是"填没填"）。所以现在连长度也不许出现，
   * 断言反过来钉住"不得出现 keyLength"——这是收紧，不是放宽。
   */
  '诊断日志只说密钥有没有填：不含密钥明文，也不含密钥长度',
  !logPayloads().includes(secret)
    && !logPayloads().includes('keyLength')
    && logPayloads().includes('keyProvided'),
  logPayloads().slice(0, 240),
)

/*
 * 提供商保存路径与「保存模型设置」必须**同一口径**。
 *
 * 这个输入框在两条保存路径下写的是同一份配置：以前一条把非法值悄悄改写成默认值、另一条拒绝，
 * 同一个填错的数字在哪个按钮下结果不一样（一个"保存成功"、一个报错）。现在两条都拒绝，而且
 * **整个保存一起拒绝**——配置与密钥一个都不落盘，不留半截状态。
 */
const providerTimeoutBundle = sectionWithRecording({ size: '1024x1024' })
const providerTimeoutTree = pageWith(providerTimeoutBundle, {
  providers: [],
  activeProviderId: '',
  connectTimeoutDraft: '0',
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
providerTimeoutTree.forms[0].props.onSubmit({ preventDefault() {} })
await sleep(30)
check(
  '提供商保存路径对同一个非法连接超时同样拒绝（配置与密钥一个都不写）',
  providerTimeoutBundle.updates.length === 0 && providerTimeoutBundle.credentialSets.length === 0,
  JSON.stringify({ updates: providerTimeoutBundle.updates.length, credentialSets: providerTimeoutBundle.credentialSets.length }).slice(0, 160),
)

/* 不动输入框直接保存：不能把星号当密钥写进去（credentials.set 一次都不能被调用） */
const untouchedBundle = sectionWithRecording({ size: '1024x1024' })
const untouchedSession = createSession(untouchedBundle.component, {
  t: undefined,
  close: () => {},
  __initial: {
    phase: 'idle',
    providers: [providerRecord],
    activeProviderId: 'zhipu',
    keyConfigured: { zhipu: true },
    editor: { mode: 'edit', initial: editorInitialFor(ALL_MODELS) },
  },
})
const untouchedTree = untouchedSession.tree()
const untouchedInput = inputById(untouchedTree, 'dib-provider-key')
untouchedSession.submit(untouchedTree.forms[0])
await sleep(30)
check(
  '已配置密钥时不动输入框直接保存：不调用 credentials.set，星号不会被当成密钥写进去',
  untouchedInput?.props?.placeholder === '*'.repeat(12)
    && untouchedInput?.props?.value === ''
    && untouchedBundle.credentialSets.length === 0
    && untouchedBundle.updates.length === 1
    && !JSON.stringify(untouchedBundle.updates[0]?.patch ?? {}).includes('*'),
  JSON.stringify({
    placeholder: untouchedInput?.props?.placeholder ?? null,
    value: untouchedInput?.props?.value ?? null,
    credentialSets: untouchedBundle.credentialSets.length,
    updates: untouchedBundle.updates.length,
  }).slice(0, 220),
)

/* 卡片上不再有「设为当前」入口；activeProviderId 仍是保存时的字段（三级回退要用） */
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
check(
  '两张卡片都没有「设为当前」入口（切换入口已下线，activeProviderId 仍由保存写回）',
  switchTree.buttons.every((button) => !textOfElement(button).includes('设为当前'))
    && !switchTree.text.includes('设为当前')
    && cardTextsOf(switchTree).length === 2
    && cardTextsOf(switchTree)[0].includes('智谱')
    && cardTextsOf(switchTree)[1].includes('OpenAI'),
  JSON.stringify({ cards: cardTextsOf(switchTree) }).slice(0, 200),
)
/*
 * 空状态（用户截图反馈重做）：没有可用模型时不再把四个槽位展开成四个手填框，
 * 常见的那句「手动填写的模型走当前生效服务商」只出现一次，且绝不把内部 id 当名字显示。
 */
const sharedHintOf = (tree) => {
  const node = tree.nodes.find((entry) => entry.type === 'p' && String(entry.props?.className ?? '').split(/\s+/u).includes('dib-routes-shared'))
  return node === undefined ? '' : textOfElement(node).trim()
}
const emptyStateTree = pageWith(cardBundle, { providers: [], activeProviderId: '' })
const legacyTree2 = pageWith(cardBundle, {
  providers: [{ ...providerRecord, id: 'default', label: '', legacy: true, models: [] }],
  activeProviderId: 'default',
})
check(
  '空状态：四个槽位都不展开手填文本框，且下拉禁用（只有明确选「手动输入…」的槽位才展开）',
  Object.values(ROUTE_SELECTS).every((id) => inputById(emptyStateTree, `${id}-manual`) === undefined)
    && Object.values(ROUTE_SELECTS).every((id) => triggerById(emptyStateTree, id)?.props.disabled === true)
    && Object.values(ROUTE_SELECTS).every((id) => dropdownById(emptyStateTree, id)?.props.value === ''),
  JSON.stringify({
    inputs: Object.values(ROUTE_SELECTS).filter((id) => inputById(emptyStateTree, `${id}-manual`) !== undefined).length,
    disabled: Object.values(ROUTE_SELECTS).map((id) => triggerById(emptyStateTree, id)?.props.disabled ?? null),
  }),
)
check(
  '空状态：共用的「手动填写…走哪家」提示在整个区块只出现一次（不是四个槽位各一遍）',
  (() => {
    const backend = pageWith(cardBundle, { providers: [{ ...providerRecord, models: [] }], activeProviderId: '' })
    const text = backend.text
    const occurrences = text.split('手动填写的模型走当前生效服务商').length - 1
    const hintRows = backend.nodes.filter((entry) => String(entry.props?.className ?? '').split(/\s+/u).includes('dib-routes-shared')).length
    return occurrences === 1 && hintRows === 1 && sharedHintOf(backend) === '手动填写的模型走当前生效服务商：智谱'
  })(),
  JSON.stringify({ shared: sharedHintOf(pageWith(cardBundle, { providers: [{ ...providerRecord, models: [] }], activeProviderId: '' })) }).slice(0, 200),
)
check(
  '空状态：没有服务商时不显示内部 id（`default`），改成「尚未添加服务商」这类人话',
  sharedHintOf(emptyStateTree) === '手动填写的模型走当前生效服务商；尚未添加服务商'
    && !emptyStateTree.text.includes('default')
    && sharedHintOf(legacyTree2).includes('默认提供商')
    && !legacyTree2.text.includes('：default'),
  JSON.stringify({ empty: sharedHintOf(emptyStateTree), legacy: sharedHintOf(legacyTree2) }).slice(0, 220),
)
check(
  '手填文本框不再带重复的「手动输入…」标签（只留 placeholder 与 aria-label）',
  (() => {
    const tree = pageWith(cardBundle, {
      providers: [zhipuFull],
      activeProviderId: 'zhipu',
      routes: routesSeed({ 'generate.primary': { providerId: 'zhipu', model: '', manual: true, manualText: '' } }),
    })
    const input = inputById(tree, `${ROUTE_SELECTS['generate.primary']}-manual`)
    const group = slotGroupOf(tree, 'generate.primary')
    const labels = (() => {
      const found = []
      walk(group, (item) => {
        if (item !== null && typeof item === 'object' && item.type === 'label') found.push(textOfElement(item).trim())
      })
      return found
    })()
    return input !== undefined
      && input.props['aria-label'] === '手动输入…'
      && !labels.includes('手动输入…')
  })(),
  JSON.stringify({ labels: (() => {
    const tree = pageWith(cardBundle, {
      providers: [zhipuFull],
      activeProviderId: 'zhipu',
      routes: routesSeed({ 'generate.primary': { providerId: 'zhipu', model: '', manual: true, manualText: '' } }),
    })
    const found = []
    walk(slotGroupOf(tree, 'generate.primary'), (item) => {
      if (item !== null && typeof item === 'object' && item.type === 'label') found.push(textOfElement(item).trim())
    })
    return found
  })() }).slice(0, 200),
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

/* 认领导航行：把外壳的兜底齿轮换成我们自己的标记（随插件分发，所有用户可见） */
const NAV_MARKER = 'data-dib-nav-icon'
const markedNavLabels = () => navDom.rows.filter((row) => row.hasAttribute(NAV_MARKER)).map((row) => row.textContent)
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const navStyleTag = styles.find((style) => style.dataset?.pluginCss === 'dsh-image-bridge/settings-nav-icon')
const navStyleText = String(navStyleTag?.textContent ?? '')
const navMaskMatch = /mask-image:\s*url\("([^"]+)"\)/u.exec(navStyleText)
const navMaskSvg = navMaskMatch === null ? '' : decodeURIComponent(navMaskMatch[1].replace(/^data:image\/svg\+xml,/u, ''))
const navIconSvgText = await readFile(`${ROOT}/icon.svg`, 'utf8')
/** 只比图形元素上的几何数据：把根 <svg …> 去掉，免得两边根属性不同就误报。 */
const geometryPairsOf = (text) => geometryPairsIn(String(text).replace(/<svg\b[^>]*>/u, ''))

check(
  '认领导航行：只给自己那一行打标记，其余行（含官方 section 与"包含我们标签"的诱饵行）一个都不碰',
  markedNavLabels().join(',') === zhDict['nav']
    && markedNavLabels().join(',') === '生图桥'
    && navDom.selectorCalls.includes('[role="dialog"] nav button')
    && navDom.observerCount() >= 1,
  JSON.stringify({ marked: markedNavLabels(), selectors: [...new Set(navDom.selectorCalls)], observers: navDom.observerCount() }).slice(0, 220),
)
check(
  '标记的图形与 icon.svg 的**图形组**同源（几何数据逐条一致），可见颜色来自 currentColor 而不是硬编码',
  navStyleTag !== undefined
    && navStyleText.includes(`[${NAV_MARKER}] > svg { display: none; }`)
    && navStyleText.includes('background-color: currentColor')
    && navMaskSvg.includes('viewBox="0 0 24 24"')
    // 只比图形组：icon.svg 现在还有一块品牌蓝的圆角底，它**不属于**图形、也不该进遮罩。
    && geometryPairsOf(navMaskSvg).join('|') === geometryPairsIn(iconGlyphGroupOf(navIconSvgText)).join('|')
    && geometryPairsOf(navMaskSvg).length >= 12
    // 遮罩里的 #000 只被 encodeURIComponent 成 %23000，样式文本里不该出现裸的颜色字面量。
    && !/#[0-9a-fA-F]{3,8}/u.test(navStyleText)
    && !/rgba?\(|hsla?\(/u.test(navStyleText),
  JSON.stringify({ pairs: geometryPairsOf(navMaskSvg).length, same: geometryPairsOf(navMaskSvg).join('|') === geometryPairsIn(iconGlyphGroupOf(navIconSvgText)).join('|') }).slice(0, 220),
)

/* 语言切换（zh → en）：标签变了，标记必须跟过去，旧行不能留着 */
localeState.lang = 'en'
navDom.setRows(['Account', 'Models', 'Plugin Market', 'Image Bridge', 'Image Bridge Extra', 'Other'])
navDom.fire()
await settle()
check(
  '语言切换后重新认领：标记跟到英文行，旧行不残留、其它行不误伤',
  enDict['nav'] === 'Image Bridge'
    && markedNavLabels().join(',') === 'Image Bridge'
    && navDom.rows.filter((row) => row.textContent === '生图桥').length === 0,
  JSON.stringify({ marked: markedNavLabels(), lang: localeState.lang }).slice(0, 200),
)

/* 匹配不到时静默降级：不抛错，而且不能留下"藏了齿轮却没图形"的残留标记 */
navDom.state.brokenSelector = true
navDom.fire()
await settle()
const navDegraded = { marked: markedNavLabels(), observers: navDom.observerCount() }
navDom.state.brokenSelector = false
localeState.lang = 'zh'
navDom.setRows(['账户', '模型', '生图桥'])
navDom.fire()
await settle()
check(
  '选择器匹配不到时静默降级：不抛错、不留任何标记（恢复后能重新认领）',
  navDegraded.marked.length === 0
    && navDegraded.observers >= 1
    && markedNavLabels().join(',') === '生图桥',
  JSON.stringify({ degraded: navDegraded, recovered: markedNavLabels() }).slice(0, 200),
)

/* 卸载（fiber 销毁）：标记与注入的样式表一起消失 */
const navDisposers = effectDisposers.filter((entry) => entry.label === 'image-bridge: settings nav icon')
const styleCountBefore = styles.filter((style) => style.dataset?.pluginCss === 'dsh-image-bridge/settings-nav-icon').length
for (const entry of navDisposers) entry.cleanup()
check(
  '卸载后标记与注入的样式表都被移除，观察者也断开',
  navDisposers.length >= 1
    && styleCountBefore >= 1
    && markedNavLabels().length === 0
    && styles.every((style) => style.dataset?.pluginCss !== 'dsh-image-bridge/settings-nav-icon')
    && navDom.observerCount() === 0,
  JSON.stringify({ disposers: navDisposers.length, styles: styleCountBefore, marked: markedNavLabels().length, observers: navDom.observerCount(), allStyles: styles.length, allEffects: effects.length, allDisposers: effectDisposers.length }).slice(0, 300),
)

/* ------------------------------------------------------------------ *
 * 自绘下拉菜单：结构、键盘、aria、滚动（六个断言）
 * ------------------------------------------------------------------ */

const menuBundle = sectionWithRecording({ providers: [zhipuFull, openaiProvider, otherProvider], activeProviderId: 'zhipu', size: '1024x1024' })
const menuSession = createSession(menuBundle.component, { t: undefined, close: () => {}, __initial: { phase: 'loading' } })
await sleep(30)
let menuTree = menuSession.tree()
// 载入是异步的：等到触发器真的渲染出来（否则拿到的是"载入中"那一版）。
for (let round = 0; round < 6 && (menuTree.nodes.find((node) => node.props?.['data-dib-route'] === 'generate.primary') === undefined); round += 1) {
  await sleep(20)
  menuTree = menuSession.tree()
}
const PRIMARY = ROUTE_SELECTS['generate.primary']

check(
  '① 触发器渲染当前值（未设置时是占位），点击后弹出菜单浮层（role=listbox）',
  triggerTextOf(menuTree, PRIMARY) === '主模型'
    && menuOf(menuTree, PRIMARY) === undefined
    && triggerById(menuTree, PRIMARY)?.props['aria-expanded'] === 'false'
    && (() => {
      menuTree = openDropdownTree(menuSession, PRIMARY)
      const menu = menuOf(menuTree, PRIMARY)
      return menu !== undefined
        && menu.props.role === 'listbox'
        && triggerById(menuTree, PRIMARY)?.props['aria-expanded'] === 'true'
        && triggerById(menuTree, PRIMARY)?.props['aria-controls'] === menu.props.id
        && menuItemsOf(menu).length === modelOptionsOf(menuTree, PRIMARY).length + 1
    })(),
  JSON.stringify({ trigger: triggerTextOf(menuTree, PRIMARY), items: menuItemsOf(menuOf(menuTree, PRIMARY)).length }).slice(0, 200),
)
check(
  '② 当前项带勾号语义：aria-selected=true + 一个勾号节点，其它项为 false',
  (() => {
    // 先选一个模型，再打开菜单看勾号落在谁身上
    menuSession.click(menuItemByValueOf(menuOf(menuTree, PRIMARY), 'zhipu::wan2.7-image'))
    menuTree = openDropdownTree(menuSession, PRIMARY)
    const menu = menuOf(menuTree, PRIMARY)
    const items = menuItemsOf(menu)
    const selected = items.filter((item) => item.props['aria-selected'] === 'true')
    const checkNode = (item) => (Array.isArray(item.props.children) ? item.props.children : []).some((child) => child?.props?.className === 'dib-menu-check')
    return selected.length === 1
      && String(selected[0].props['data-value']) === 'zhipu::wan2.7-image'
      && checkNode(selected[0])
      && items.filter((item) => item.props['aria-selected'] === 'false').every((item) => !checkNode(item))
  })(),
  JSON.stringify(menuItemsOf(menuOf(menuTree, PRIMARY)).map((item) => `${item.props['data-value']}:${item.props['aria-selected']}`)).slice(0, 240),
)
check(
  '③ 点面板外关闭、Esc 关闭，且关闭后焦点回到触发器',
  (() => {
    const focusBefore = domCalls.focus.length
    // 点面板外
    domCalls.outsideTarget = { tag: 'outside' }
    navDom.dispatch('mousedown', { target: domCalls.outsideTarget })
    menuTree = menuSession.tree()
    const closedByOutside = menuOf(menuTree, PRIMARY) === undefined && triggerById(menuTree, PRIMARY)?.props['aria-expanded'] === 'false'
    domCalls.outsideTarget = null
    // 再开一次，用 Esc 关
    menuTree = openDropdownTree(menuSession, PRIMARY)
    keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'Escape')
    menuTree = menuSession.tree()
    const closedByEsc = menuOf(menuTree, PRIMARY) === undefined
    return closedByOutside && closedByEsc && domCalls.focus.length > focusBefore
  })(),
  JSON.stringify({ focusCalls: domCalls.focus.length, outsideListeners: navDom.listenerCount('mousedown') }).slice(0, 200),
)
check(
  '④ 键盘上下键移动 + 回车选中，并按同一份状态落盘（providerId + model）',
  await (async () => {
    menuTree = openDropdownTree(menuSession, PRIMARY)
    const activeValueOf = () => menuItemsOf(menuOf(menuTree, PRIMARY))
      .find((item) => String(item.props.className).includes('is-active'))?.props['data-value'] ?? null
    // 打开时高亮落在当前选中项上；上下键必须真的把高亮挪走，回车提交的是**高亮那一项**。
    const atOpen = activeValueOf()
    keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'ArrowDown')
    menuTree = menuSession.tree()
    const afterDown = activeValueOf()
    keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'ArrowUp')
    menuTree = menuSession.tree()
    const afterUp = activeValueOf()
    keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'ArrowDown')
    menuTree = menuSession.tree()
    keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'Enter')
    menuTree = menuSession.tree()
    const value = dropdownById(menuTree, PRIMARY)?.props.value
    menuSession.click(menuTree.nodes.find((node) => node.type === 'button' && node.props?.['data-dib-action'] === 'save-routes'))
    await sleep(30)
    const saved = [...menuBundle.updates].reverse().map((entry) => entry.patch?.modelRoutes?.generate?.primary).find((item) => item !== undefined)
    return atOpen !== null && afterDown !== null && afterDown !== atOpen && afterUp === atOpen
      && value === afterDown
      && menuOf(menuTree, PRIMARY) === undefined
      && typeof value === 'string' && value.includes('::')
      && saved?.providerId === value.split('::')[0]
      && saved?.model === value.split('::')[1]
  })(),
  JSON.stringify({ value: dropdownById(menuTree, PRIMARY)?.props.value ?? null, saved: [...menuBundle.updates].reverse().map((entry) => entry.patch?.modelRoutes?.generate?.primary).find((item) => item !== undefined) ?? null }).slice(0, 220),
)
check(
  '⑤ 长列表可用：面板有最大高度 + 内部滚动，键盘移动时当前项被滚入视野',
  (() => {
    const cssTextAll = styles.map((style) => style.textContent).join('')
    const scrollBefore = domCalls.scrollIntoView.length
    menuTree = openDropdownTree(menuSession, PRIMARY)
    keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'ArrowDown')
    menuTree = menuSession.tree()
    const menu = menuOf(menuTree, PRIMARY)
    const inline = String(menu?.props?.style ?? '')
    return cssTextAll.includes('.dib-menu{') && cssTextAll.includes('max-height:280px') && cssTextAll.includes('overflow-y:auto')
      // jsdom 里量不到真实高度，所以断言"滚动究竟有没有被触发"：每次键盘移动都会调一次 scrollIntoView。
      && domCalls.scrollIntoView.length > scrollBefore
      && domCalls.scrollIntoView[domCalls.scrollIntoView.length - 1]?.options?.block === 'nearest'
      && inline === ''
  })(),
  JSON.stringify({ scrollCalls: domCalls.scrollIntoView.length, last: domCalls.scrollIntoView[domCalls.scrollIntoView.length - 1] ?? null }).slice(0, 200),
)

/* ------------------------------------------------------------------ *
 * ⑥ 输入跳转（type-ahead）
 *
 * 模型下拉在真实配置里能有 176 项（实测某服务商 `/models`），只能靠上下键一格格翻；
 * 用户知道模型名，键盘却帮不上忙。这三条分别钉住：能跳、重复字符会轮换、修饰键不参与搜索。
 * ------------------------------------------------------------------ */
{
  const activeValue = () => menuItemsOf(menuOf(menuTree, PRIMARY))
    .find((item) => String(item.props.className).includes('is-active'))?.props['data-value'] ?? null
  menuTree = openDropdownTree(menuSession, PRIMARY)
  // 打开时高亮在"当前选中项"上，先记下来，好证明输入真的把高亮挪到了别处。
  const atOpenTyped = activeValue()
  keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'z')
  menuTree = menuSession.tree()
  const afterZ = activeValue()
  check(
    '⑥ 输入单个字符跳到第一个匹配项（176 项也不必靠上下键翻）',
    afterZ !== null && afterZ.endsWith('::z-image-turbo') && afterZ !== atOpenTyped,
    JSON.stringify({ atOpen: atOpenTyped, afterZ }),
  )

  // 重复同一个字符 → 轮换到下一个同前缀项（标准 type-ahead 行为，否则"第三个 w 开头"没法跳）。
  // 先关再开：搜索缓冲按设计只在"这一次打开"内有效，这样也顺带让本用例不依赖上一条的残留。
  keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'Escape')
  menuTree = menuSession.tree()
  menuTree = openDropdownTree(menuSession, PRIMARY)
  keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'w')
  menuTree = menuSession.tree()
  const firstW = activeValue()
  keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'w')
  menuTree = menuSession.tree()
  const secondW = activeValue()
  check(
    '⑥ 连续重复同一字符会轮换到下一个同前缀项',
    firstW !== null && secondW !== null && firstW !== secondW
      && firstW.includes('::w') && secondW.includes('::w'),
    JSON.stringify({ firstW, secondW }),
  )

  /*
   * 搜索缓冲**不跨交互存活**：上次搜过 `z`、关掉再打开按 `w`，必须按"新的搜索"处理，
   * 而不是拼成 `zw`（那样匹配不到任何项，表现为输入跳转静默失灵——这是实测踩到的）。
   */
  keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'Escape')
  menuTree = menuSession.tree()
  menuTree = openDropdownTree(menuSession, PRIMARY)
  keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'z')
  menuTree = menuSession.tree()
  const zHit = activeValue()
  keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'Escape')
  menuTree = menuSession.tree()
  menuTree = openDropdownTree(menuSession, PRIMARY)
  keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'w')
  menuTree = menuSession.tree()
  const wAfterReopen = activeValue()
  check(
    '⑥ 搜索缓冲不跨交互存活（关掉再打开按新字符，不会拼成上一次的词）',
    String(zHit).includes('::z-') && String(wAfterReopen).includes('::w'),
    JSON.stringify({ zHit, wAfterReopen }),
  )

  // 带修饰键的组合不是输入（否则 Ctrl+A、Cmd+F 会被当成搜索词）。
  const beforeModifier = activeValue()
  keyDownOn(menuSession, triggerById(menuTree, PRIMARY), 'a', { ctrlKey: true })
  menuTree = menuSession.tree()
  check(
    '⑥ 带 Ctrl / Meta / Alt 的按键不当作输入（不会把快捷键吃成搜索词）',
    activeValue() === beforeModifier,
    JSON.stringify({ before: beforeModifier, after: activeValue() }),
  )
}
check(
  '⑥ 分组是**不可点**的小标题（role=presentation、没有点击处理），并沿用「— 名称 —」大写标记',  (() => {
    menuTree = openDropdownTree(menuSession, PRIMARY)
    const groups = menuGroupsOf(menuOf(menuTree, PRIMARY))
    return groups.length === 3
      && groups.map((group) => textOfElement(group).trim()).join(',') === '— 智谱 —,— OPENAI —,— OTHER —'
      && groups.every((group) => group.props.role === 'presentation' && group.props.onClick === undefined)
      // 小标题不是选项：不参与 aria-selected / 勾号
      && menuItemsOf(menuOf(menuTree, PRIMARY)).every((item) => !textOfElement(item).includes('—'))
  })(),
  JSON.stringify(menuGroupsOf(menuOf(menuTree, PRIMARY)).map((group) => textOfElement(group).trim())).slice(0, 200),
)
/* 补一条：未设置时触发器显示占位而不是"第一个模型的名字"（与上面的占位断言配对） */
check(
  '未设置的槽位：触发器显示占位文案，不会显示成第一个模型的名字',
  (() => {
    const tree = routesPageWith(routesBundle, {})
    const firstModel = modelOptionsOf(tree, ROUTE_SELECTS['generate.fallback'])[0]?.label ?? ''
    return triggerTextOf(tree, ROUTE_SELECTS['generate.fallback']) === '备用模型'
      && firstModel !== ''
      && triggerTextOf(tree, ROUTE_SELECTS['generate.fallback']) !== firstModel
  })(),
  JSON.stringify({ trigger: triggerTextOf(routesPageWith(routesBundle, {}), ROUTE_SELECTS['generate.fallback']) }).slice(0, 160),
)

/*
 * 五个 Dropdown（四个模型槽位 + 尺寸）的 key 必须稳定且互不重复。
 *
 * 以前它们都传 key='select'：React 要求同级 key 唯一，重复 key 会让协调行为不确定；
 * 我的桩渲染器当时也因此把它们当成同一个组件实例、共享一份 hook 状态。
 */
const dropdownNodesOf = (tree) => tree.nodes.filter((node) => Array.isArray(node.props?.entries) && typeof node.props?.id === 'string')
const duplicateSiblingKeysOf = (tree) => {
  const bad = []
  for (const node of tree.nodes) {
    const children = (Array.isArray(node.props?.children) ? node.props.children : []).filter((child) => child !== null && typeof child === 'object')
    const seen = new Set()
    for (const child of children) {
      const key = child.props?.key
      if (key === undefined) continue
      if (seen.has(key)) bad.push(`${String(node.props?.className ?? node.type)}>${String(key)}`)
      seen.add(key)
    }
  }
  return bad
}
const keyFiveTree = routesPageWith(routesBundle, { size: '1024x1024' })
check(
  '五个 Dropdown 的 key 稳定且互不重复（生图主/备用、修图主/备用、尺寸），同级也不再有重复 key',
  (() => {
    const dropdowns = dropdownNodesOf(keyFiveTree)
    const expected = 'dropdown:generate.primary,dropdown:generate.fallback,dropdown:edit.primary,dropdown:edit.fallback,dropdown:size'
    // 真正传给 React 的 key（桩渲染器保留了它）——这才是 T-1 要修的东西，必须逐字对上。
    const reactKeys = dropdowns.map((node) => String(node.props.key ?? ''))
    // 同名 prop：真实 React 会把 key 从 props 里剥掉，留一份可读的标识给断言与调试用。
    const labels = dropdowns.map((node) => String(node.props.dropdownKey ?? ''))
    return dropdowns.length === 5
      && reactKeys.join(',') === expected
      && new Set(reactKeys).size === 5
      && labels.join(',') === expected
      && duplicateSiblingKeysOf(keyFiveTree).length === 0
  })(),
  JSON.stringify({
    reactKeys: dropdownNodesOf(keyFiveTree).map((node) => node.props.key ?? null),
    labels: dropdownNodesOf(keyFiveTree).map((node) => node.props.dropdownKey ?? null),
    duplicates: duplicateSiblingKeysOf(keyFiveTree),
  }).slice(0, 300),
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

/*
 * 显式收尾：SUMMARY 已经打完，这里没有待刷新的输出，所以 `process.exit` 是安全的。
 *
 * 为什么需要它：本套件把全局 `setInterval` 换成桩时钟、又 import 了浏览器半的模块，跑完后
 * 事件循环里可能还挂着环境留下的 handle（实测在受限沙箱里是 2 个管道 Socket）。那会让
 * "进程不退出"，看起来像死循环——排查过一次：其实 168 条断言早就跑完了，只是脚本不肯结束。
 * 没有这条时，任何人（或 CI）都得靠外部超时来判定成败，而超时看起来就像失败。
 */
process.exit(failed.length === 0 ? 0 : 1)
