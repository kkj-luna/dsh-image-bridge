/**
 * 生图桥 Host 半的进程外端到端验证。
 *
 * 用假的 Cordis ctx + 本地模拟生图接口，把 image_generate 整条管线跑通：
 * 配置解析 → HTTP 调用 → b64 解码 → 附件提交 → 工作区落盘 → 输出值/渲染/投影 → 测试通道。
 * 不依赖 Harness 进程，因此可以在重启前先证明代码本身是对的。
 */
import assert from 'node:assert/strict'
import diagnostics from 'node:diagnostics_channel'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_DIR, resolveDshBin, resolveProfileDir } from './dsh-paths.mjs'

/*
 * 路径全部现场推导，仓库里不写死开发机路径：
 * dsh 安装位置来自 DSH_BIN / 全局 npm 前缀，profile 目录来自 DSH_PROFILE_DIR / DSH_HOME。
 * 推不出来就抛错并告诉你该设哪个变量（见 dsh-paths.mjs）。
 */
const DSH_BIN = resolveDshBin()
process.env.DSH_PROFILE_DIR = resolveProfileDir()
/*
 * 把 CLI 入口指向 dsh 本体，让 `loadOptional` 能解析到真实的 @deepseek-ai/dsh-tools。
 * 否则 defineTool 会走恒等兜底，真实的 schema 校验（parameterSchemaSpecToJsonSchema /
 * valueSchemaSpecToJsonSchema）就完全没被覆盖——那恰恰是最容易抛错的一环。
 */
process.argv[1] = DSH_BIN
const ROOT = PLUGIN_DIR
/** Host 的 RPC 通道前缀（与 index.js 的 RPC_CHANNEL 必须一致）。 */
const RPC_PATH = '/dsh-image-bridge'

/** 一张真实的 1x1 PNG。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'ok   ' : 'FAIL '} ${name}${condition || detail === undefined ? '' : ` — ${detail}`}`)
}

/* ---------------------------------------------------------------- 模拟接口 */

let lastGenerateBody
let lastEditBody
/** 多服务商用例的记录：请求打到了哪个前缀、带了什么 Authorization。 */
let lastVendorGenerateBody
let lastVendorEditBody
let lastLegacyGenerateBody
let vendorAuth = ''
let legacyAuth = ''
let modelsAuth = ''
/** keyRef 用例专用：记录 /keyed/models 收到的 Authorization。 */
let keyedModelsAuth = ''
/** 收到的每一条请求（方法 + 路径）：用来断言"没有可用密钥时一个包都不发"。 */
const requests = []
/** 模型路由用例的记录：备用服务商、慢响应服务商、以及"第一次掐断连接"的服务器。 */
let lastAltGenerateBody
let lastAltEditBody
let altAuth = ''
let lastSlowGenerateBody
let slowAuth = ''
let flakyAttempts = 0
let lastFlakyGenerateBody
/** 慢响应用例：服务商从收到请求到回图的这段实际耗时（用来证明"慢"不再等于"换备用"）。 */
let slowHeaderStartAt = 0
let slowHeaderEndAt = 0

const server = createServer((request, response) => {
  const chunks = []
  // 客户端中途放弃（调用超时/取消）时 socket 会被掐断，别让这类事件把进程带崩。
  response.on('error', () => {})
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    requests.push(`${request.method} ${request.url}`)
    const body = Buffer.concat(chunks).toString('utf8')
    const auth = String(request.headers.authorization ?? '')
    /** 生图/改图统一回一张真实 PNG。 */
    const image = () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'revised by model' }] }))
    }
    const json = (code, payload) => {
      response.writeHead(code, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    if (request.method === 'POST' && (request.url.startsWith('/v1/images/generations') || request.url.startsWith('/v1/images/edits'))) {
      if (request.url.startsWith('/v1/images/generations')) lastGenerateBody = body
      else lastEditBody = body
      image()
      return
    }
    if (request.method === 'POST' && (request.url.startsWith('/alt-vendor/images/generations') || request.url.startsWith('/alt-vendor/images/edits'))) {
      if (request.url.startsWith('/alt-vendor/images/generations')) lastAltGenerateBody = body
      else lastAltEditBody = body
      altAuth = auth
      image()
      return
    }
    /*
     * 慢响应：拖 600ms 才回图。
     *
     * 它是"响应慢"的代表：新语义下响应快慢**完全不影响**是否换备用（③、⑦c 都靠它证明），
     * 所以这里只延迟、不做任何超时判定。
     */
    if (request.method === 'POST' && request.url.startsWith('/slow-vendor/images/generations')) {
      setTimeout(() => {
        if (response.writableEnded || response.destroyed) return
        lastSlowGenerateBody = body
        slowAuth = auth
        image()
      }, 600)
      return
    }
    /* 收到 POST 后立刻掐断 socket：模拟"请求已经上线、传输却断了"，用来验证"发出过的请求绝不重发"。
       若哪天又重发，flakyAttempts 会变成 2 并被 ⑥ 的断言抓住。 */
    if (request.method === 'POST' && request.url.startsWith('/flaky/images/generations')) {
      flakyAttempts += 1
      if (flakyAttempts === 1) {
        request.socket.destroy()
        return
      }
      lastFlakyGenerateBody = body
      image()
      return
    }
    if (request.method === 'POST' && (request.url.startsWith('/vendor/images/generations') || request.url.startsWith('/vendor/images/edits'))) {
      if (request.url.startsWith('/vendor/images/generations')) lastVendorGenerateBody = body
      else lastVendorEditBody = body
      vendorAuth = auth
      image()
      return
    }
    /* 200 但 data 为空：真机上"模型不支持这个端点 / 没出图"的常见形态。 */
    if (request.method === 'POST' && request.url.startsWith('/empty-vendor/images/generations')) {
      json(200, { data: [] })
      return
    }
    /* 200 但回的是任务态（没有 data 数组）：异步服务商常见形态。 */
    if (request.method === 'POST' && request.url.startsWith('/task-vendor/images/generations')) {
      json(200, { task_id: 'task-1', status: 'processing' })
      return
    }
    /* 200 且给了一个图片地址，但那个地址取不到：图片"已经产出、只是传输失败"。 */
    if (request.method === 'POST' && request.url.startsWith('/urlish-vendor/images/generations')) {
      json(200, { data: [{ url: `${origin}/missing-image.png` }] })
      return
    }
    if (request.method === 'POST' && request.url.startsWith('/legacy/images/generations')) {
      lastLegacyGenerateBody = body
      legacyAuth = auth
      image()
      return
    }
    if (request.method === 'GET' && request.url.startsWith('/v1/models')) {
      json(200, { data: [{ id: 'gpt-image-1' }] })
      return
    }
    if (request.method === 'GET' && request.url.startsWith('/vendor/models')) {
      modelsAuth = auth
      // 刻意混入空 id、缺 id 与非对象项：Host 必须把它们全部过滤掉。
      json(200, { data: [{ id: 'vendor-image-v2' }, { id: '  ' }, { id: 'vendor-edit-v2' }, { nope: 1 }, 'x'] })
      return
    }
    if (request.method === 'GET' && request.url.startsWith('/keyed/models')) {
      keyedModelsAuth = auth
      json(200, { data: [{ id: 'keyed-model' }] })
      return
    }
    if (request.method === 'GET' && request.url.startsWith('/broken/models')) {
      json(500, { error: { message: 'quota exhausted' } })
      return
    }
    if (request.method === 'GET' && request.url.startsWith('/plain/models')) {
      // 200 但正文不是 JSON：可达，但取不到模型列表。
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('not json at all')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not found"}')
  })
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
/*
 * 连接慢：新连接一律先压住 1.5s，请求因此迟迟发不出去。
 *
 * 只用来造出"连接耗时"这一段——它现在是**唯一**参与判定的时间：连接预算衡量的是"请求有没有
 * 发出去"，所以连接慢会真的吃掉预算（⑦a 的预算必须给够），而请求一旦发出就再也不计时。
 * 注意 keep-alive：第一次请求之后连接会被复用，所以后续用例的连接是快的。
 */
server.on('connection', (socket) => {
  socket.pause()
  setTimeout(() => socket.resume(), 1500)
})
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/v1`
/** 多服务商用例的其它前缀都挂在这个源上。 */
const origin = `http://127.0.0.1:${port}`

/*
 * 两个专用源，把"连接慢"与"响应慢"彻底分开——只有分开了，才能证明这两件事不再被混为一谈。
 *   - slowOrigin：请求体分两块、第二块延迟 1.5s 才给，于是"请求真正发出"被确定性地推后；
 *     服务商收到后立刻回答（实测接受≈1560ms，回答≈100ms）。
 *   - headerOrigin：请求发出是快的，只有一个前缀把响应拖 5s（服务商慢，但不该换备用）。
 */
const SLOW_HEADER_DELAY_MS = 5000
/** 响应慢但服务在听的路径：用来把"请求发出去了、只是没回头"与"连不上"分开。 */
const VERY_SLOW_DELAY_MS = 20000
const SLOW_BODY_DELAY_MS = 1500
let lastStalledVendorBody
let slowBodyAcceptedAt = 0
let slowBodyHeaderAt = 0

/** 只负责"答得慢"的源：请求发出快，慢的只有服务商的响应。 */
const headerServer = createServer((request, response) => {
  const chunks = []
  response.on('error', () => {})
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    requests.push(`${request.method} ${request.url}`)
    if (request.method === 'POST' && request.url.startsWith('/slow-header-vendor/images/generations')) {
      slowHeaderStartAt = Date.now()
      setTimeout(() => {
        if (response.writableEnded || response.destroyed) return
        slowHeaderEndAt = Date.now()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
      }, SLOW_HEADER_DELAY_MS)
      return
    }
    if (request.method === 'POST' && request.url.startsWith('/very-slow-vendor/images/generations')) {
      slowHeaderStartAt = Date.now()
      setTimeout(() => {
        if (response.writableEnded || response.destroyed) return
        slowHeaderEndAt = Date.now()
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
      }, VERY_SLOW_DELAY_MS)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  })
})
await new Promise((ready) => headerServer.listen(0, '127.0.0.1', ready))
const headerOrigin = `http://127.0.0.1:${headerServer.address().port}`

/** 只负责"发出晚"的源：请求体第二块延迟到达，服务商收到后立刻回答。 */
const slowServer = createServer((request, response) => {
  const chunks = []
  response.on('error', () => {})
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    requests.push(`${request.method} ${request.url}`)
    if (request.method === 'POST' && request.url.startsWith('/stalled-vendor/images/generations')) {
      const now = Date.now()
      if (slowBodyAcceptedAt === 0) slowBodyAcceptedAt = now
      slowBodyHeaderAt = now
      lastStalledVendorBody = Buffer.concat(chunks).toString('utf8')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found' }))
  })
})
await new Promise((ready) => slowServer.listen(0, '127.0.0.1', ready))
const slowOrigin = `http://127.0.0.1:${slowServer.address().port}`

/* ---------------------------------------------------------------- 假 ctx */

const registered = []
const routes = []
const workRoot = await mkdtemp(join(tmpdir(), 'dib-e2e-'))

const attachments = {
  async saveImage({ data, mediaType, name }) {
    return { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType, bytes: data.byteLength, width: 1, height: 1, name }
  },
}
const credentials = { async resolve() { return { value: 'test-key', source: 'mock' } } }
const llm = { async resolveModelInfo() { return { inputModalities: ['image', 'text'] } } }
const toolRegistry = { register(definition) { registered.push(definition); return () => {} } }

/** 启动自述写到这个临时目录，避免污染真实的 ~/.dsh。 */
const diagHome = await mkdtemp(join(tmpdir(), 'dib-startup-'))
process.env.DSH_HOME = diagHome

const services = {
  attachments,
  credentials,
  llm,
  tools: toolRegistry,
  fs: {
    async resolve(path, opts) {
      return { displayPath: path, hostPath: join(opts?.cwd ?? workRoot, path) }
    },
    async stat() {
      return { version: 'v1' }
    },
    async readBytes(target) {
      return new Uint8Array(await readFile(target.hostPath))
    },
  },
  connection: { requestRejection: () => undefined },
  webServer: { register(route) { routes.push(route); return () => {} } },
}
const ctx = {
  get: (name) => services[name],
  tools: toolRegistry,
  inject: (_deps, callback) => { callback(ctx); return () => {} },
  effect: (fn) => fn(),
  logger: { warn: (...args) => console.log('[warn]', ...args) },
}

/* ---------------------------------------------------------------- 载入插件 */

const mod = await import(`${pathToFileURL(`${ROOT}/index.js`).href}?hostcase=1`)

const packageName = JSON.parse(await readFile(`${ROOT}/package.json`, 'utf8')).name
check('导出 name 与包名一致', mod.name === packageName, `${mod.name} vs ${packageName}`)
check('导出 inject 含 tools', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
check('Config 已定义（schemastery 解析成功）', mod.Config !== undefined, 'Config 为 undefined 说明 schemastery 没解析到')

if (mod.Config !== undefined) {
  const json = mod.Config.toJSON()
  const serialized = JSON.stringify(json)
  const refs = json?.refs ?? {}
  const volatileNodes = Object.values(refs).filter((node) => node?.meta?.volatile === true)
  const fieldNames = ['baseUrl', 'model', 'editModel', 'size', 'saveToWorkspace', 'outputDir', 'timeoutMs', 'providers', 'activeProviderId', 'modelRoutes', 'connectTimeoutSeconds']
  check('Config 字段齐全', fieldNames.every((key) => serialized.includes(`"${key}"`)), `缺少: ${fieldNames.filter((key) => !serialized.includes(`"${key}"`)).join(',')}`)
  check('每个字段都标了 volatile', volatileNodes.length === fieldNames.length, `volatile=${volatileNodes.length}/${fieldNames.length}`)
  check('每个 volatile 字段都有默认值', volatileNodes.every((node) => node.meta.default !== undefined), '')

  /* 多服务商的新增字段：形状必须与契约一致，少一个字段就会被 Schema 静默丢掉。 */
  const providersNode = Object.values(refs).find((node) => node?.type === 'array' && node?.meta?.volatile === true)
  const providerItem = providersNode === undefined ? undefined : refs[String(providersNode.inner)]
  const itemFields = ['id', 'label', 'baseUrl', 'keyRef', 'models', 'imageModel', 'editModel']
  check(
    'providers 是对象数组且元素字段齐全',
    providersNode !== undefined && providerItem?.type === 'object' && itemFields.every((key) => providerItem.dict?.[key] !== undefined),
    JSON.stringify(providerItem === undefined ? null : Object.keys(providerItem.dict ?? {})),
  )
  /*
   * volatile 字段解析出来后不是普通值，而是 cosmokit 的冻结引用（`{ get() }`）——
   * 这正是 Host 侧读配置必须解引用、且每次调用都要重读的原因，这里一并固化下来。
   */
  const plain = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)
  const defaults = mod.Config({})
  check(
    'volatile 字段解析为引用对象（读配置必须解引用）',
    typeof defaults.providers?.get === 'function' && typeof defaults.activeProviderId?.get === 'function',
    JSON.stringify({ providers: typeof defaults.providers, activeProviderId: typeof defaults.activeProviderId }),
  )
  check(
    'providers 默认空数组、activeProviderId 默认空串',
    Array.isArray(plain(defaults.providers)) && plain(defaults.providers).length === 0 && plain(defaults.activeProviderId) === '',
    JSON.stringify({ providers: plain(defaults.providers), activeProviderId: plain(defaults.activeProviderId) }),
  )
  const roundTrip = mod.Config({
    providers: [{ id: 'vendor-one', label: 'Vendor', baseUrl: 'https://example.test/v1', keyRef: '', models: ['m1', 'm2'], imageModel: 'img', editModel: 'edit' }],
    activeProviderId: 'vendor-one',
  })
  const roundTripProviders = plain(roundTrip.providers)
  check(
    'providers 条目能通过 Schema 校验且字段原样保留',
    roundTripProviders?.[0]?.models?.join(',') === 'm1,m2' && roundTripProviders?.[0]?.editModel === 'edit' && plain(roundTrip.activeProviderId) === 'vendor-one',
    JSON.stringify(roundTripProviders),
  )

  /* 模型路由：两层嵌套对象，每一档都是 { providerId, model }，客户端会写这个形状。 */
  const roundTripRoutes = mod.Config({
    modelRoutes: {
      generate: { primary: { providerId: 'p1', model: 'm1' }, fallback: { providerId: 'p2', model: 'm2' } },
      edit: { primary: { providerId: 'p3', model: 'm3' } },
    },
    connectTimeoutSeconds: 4,
  })
  const routes = plain(roundTripRoutes.modelRoutes)
  check(
    'modelRoutes / connectTimeoutSeconds 能通过 Schema 校验且原样保留',
    routes?.generate?.primary?.providerId === 'p1'
      && routes?.generate?.fallback?.model === 'm2'
      && routes?.edit?.primary?.model === 'm3'
      && plain(roundTripRoutes.connectTimeoutSeconds) === 4,
    JSON.stringify({ routes, connectTimeoutSeconds: plain(roundTripRoutes.connectTimeoutSeconds) }),
  )
  const routeDefaults = plain(mod.Config({}).modelRoutes)
  check(
    'modelRoutes 默认 {}、connectTimeoutSeconds 默认为 15 秒（连接只算"请求有没有发出去"）',
    routeDefaults !== null && typeof routeDefaults === 'object' && plain(mod.Config({}).connectTimeoutSeconds) === 15,
    JSON.stringify({ routeDefaults, connectTimeoutSeconds: plain(mod.Config({}).connectTimeoutSeconds) }),
  )

  /*
   * 设置页的表单投影：dsh-settings 会对每个 volatile 字段执行
   * `new z(node.toJSON())`（plainSchema）再逐层 walk。数组套对象是最容易在这一步
   * 翻车的形状，所以直接照它的调用方式重建一次，确认元素对象还在。
   */
  const schemastery = createRequire(DSH_BIN)('@deepseek-ai/schemastery')
  const z = typeof schemastery === 'function' ? schemastery : schemastery.default
  const providersSchema = mod.Config?.dict?.providers
  const rebuiltProviders = providersSchema === undefined ? undefined : z(providersSchema.toJSON())
  check(
    'providers 子 schema 能被设置服务重建（plainSchema 同款调用）',
    rebuiltProviders?.type === 'array' && Object.keys(rebuiltProviders.inner?.dict ?? {}).length === 7,
    JSON.stringify(rebuiltProviders === undefined ? null : Object.keys(rebuiltProviders.inner?.dict ?? {})),
  )
  const rebuiltRoutes = mod.Config?.dict?.modelRoutes === undefined ? undefined : z(mod.Config.dict.modelRoutes.toJSON())
  check(
    'modelRoutes 子 schema 能被设置服务重建（两层嵌套对象）',
    rebuiltRoutes?.type === 'object'
      && rebuiltRoutes.dict?.generate?.dict?.primary?.dict?.providerId !== undefined
      && rebuiltRoutes.dict?.edit?.dict?.fallback?.dict?.model !== undefined,
    JSON.stringify(rebuiltRoutes === undefined ? null : Object.keys(rebuiltRoutes.dict ?? {})),
  )
}

mod.apply(ctx, {
  baseUrl,
  model: 'gpt-image-1',
  size: '1024x1024',
  saveToWorkspace: true,
  outputDir: 'generated-images',
  timeoutMs: 15000,
})

check('注册了 2 个工具', registered.length === 2, registered.map((t) => t.name).join(','))
check('注册了测试路由', routes.length === 1 && routes[0].path === '/dsh-image-bridge', JSON.stringify(routes.map((r) => r.path)))
/* 真 defineTool 会把作者格式的 parameters 编译成 JSON Schema（required 变成字符串数组）。 */
check(
  '参数已由真实 defineTool 编译（不是恒等兜底）',
  registered.every((tool) => tool.parameters !== undefined && Array.isArray(tool.parameters.required)),
  JSON.stringify(registered.map((tool) => tool.parameters?.required)),
)

/* apply 的执行轨迹会写成一份启动自述；它也是 Host 侧唯一的失败可见性来源。 */
await new Promise((done) => setTimeout(done, 500))
let startup = null
try {
  startup = JSON.parse(await readFile(join(diagHome, 'dsh-image-bridge-startup.json'), 'utf8'))
} catch {
  startup = null
}
check('写下了启动自述', startup !== null, '没有报告文件')
check('启动自述记录了工具注册步骤', Array.isArray(startup?.steps) && startup.steps.includes('两个工具已注册'), JSON.stringify(startup?.steps))
check('启动自述记录了服务就位情况', startup?.services?.tools === true && startup?.services?.attachments === true, JSON.stringify(startup?.services))

const generate = registered.find((tool) => tool.name === 'image_generate')
const edit = registered.find((tool) => tool.name === 'image_edit')
check('工具输出声明完整', Boolean(generate?.output?.schema && typeof generate.output.render === 'function'), 'output{schema,render} 是注册表强制要求')

/* ---------------------------------------------------------------- 跑一次生图 */

const exec = {
  signal: undefined,
  agent: {
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    session: { header: { cwd: workRoot }, requestHeader: () => undefined },
  },
}
const value = await generate.execute({ prompt: 'a red circle on white' }, exec)

check('请求体带上了 model 与 prompt', typeof lastGenerateBody === 'string' && lastGenerateBody.includes('gpt-image-1') && lastGenerateBody.includes('a red circle'), String(lastGenerateBody))
check('返回 1 张图片', Array.isArray(value.images) && value.images.length === 1, JSON.stringify(value.images))
check('图片媒体类型被魔数识别为 png', value.images[0]?.mediaType === 'image/png', String(value.images[0]?.mediaType))
check('图片尺寸来自附件服务', value.images[0]?.width === 1 && value.images[0]?.height === 1, `${value.images[0]?.width}x${value.images[0]?.height}`)
check('imageCapable 跟随路由能力为 true', value.imageCapable === true, String(value.imageCapable))
check('revised_prompt 被透传', Array.isArray(value.revisedPrompts) && value.revisedPrompts[0] === 'revised by model', JSON.stringify(value.revisedPrompts))
check('工作区落盘路径已返回', Array.isArray(value.savedPaths) && value.savedPaths.length === 1, JSON.stringify(value.savedPaths))

if (Array.isArray(value.savedPaths) && value.savedPaths.length === 1) {
  const saved = value.savedPaths[0]
  const info = await stat(saved).catch(() => undefined)
  check('落盘文件确实存在', info !== undefined && info.size === PNG.length, `${saved} size=${info?.size}`)
  const reloaded = await readFile(saved)
  check('落盘字节与接口返回一致', reloaded.equals(PNG), `len=${reloaded.length}`)
  check('落盘目录是工作区内的 generated-images', saved.includes('generated-images'), saved)
}

const blocks = generate.output.render({ prompt: 'x' }, value)
/*
 * 稳定后的可见性全靠 content：平台手上只剩 `content`（本函数的返回值）与 `meta`，
 * 而工具行的 keyed toolview 在对话稳定后被包进高度为 0 的容器里、屏幕上看不见。
 * 所以信封 + 图片之后还有**第三块**——末尾那行 `model: <真正产出这张图的模型>`。
 * （这就是"为什么这行字要写在 content 里"的答案，别把它当多余块删掉。）
 */
check(
  'render 产出「信封文本 + image + 末尾 model 行」三块（顺序固定）',
  blocks.length === 3
    && blocks[0].type === 'text'
    && blocks[1].type === 'image'
    && blocks[2].type === 'text'
    && blocks[2].text === `model: ${value.model}`,
  blocks.map((b) => (b.type === 'text' ? b.text.slice(0, 32) : b.type)).join(','),
)
check('image 块携带 attachmentId', typeof blocks[1]?.attachment?.attachmentId === 'string', JSON.stringify(blocks[1]?.attachment))
check('文本信封含文件路径', blocks[0].text.includes('generated-images'), '')

const meta = generate.output.presentationMeta({ prompt: 'x' }, value)
check('presentationMeta 带图片引用（界面据此渲染）', Array.isArray(meta.images) && meta.images.length === 1, JSON.stringify(meta))
check('presentationMeta 带 imageCapable', meta.imageCapable === true, String(meta.imageCapable))

/* ---------------------------------------------------------------- 纯文本模型分叉 */

const textValue = { ...value, imageCapable: false }
const textBlocks = generate.output.render({}, textValue)
/*
 * 这里断言的是"**一个 image 块都没有**"，而不是"块数恰好等于 1"：数量会随文本块增减而变
 * （末尾的 model 行就让 1 变成了 2），但"绝不下发 image 块"这条约束（否则 DSH 适配器会对
 * 不支持图片输入的路由抛 UNSUPPORTED_CONTENT）永远不该变。用 every 才盯得住这条不变量。
 */
check(
  '纯文本路由下**每个块都是文本**（绝不下发 image 块，避免 UNSUPPORTED_CONTENT）',
  textBlocks.length >= 1 && textBlocks.every((block) => block.type === 'text'),
  textBlocks.map((b) => b.type).join(','),
)
check('纯文本信封提示改用文件路径', textBlocks[0].text.includes('不支持图片输入'), '')

/* ---------------------------------------------------------------- 改图管线 */

const sourcePath = join(workRoot, 'generated-images', 'source.png')
await writeFile(sourcePath, await readFile(value.savedPaths[0]))
const editValue = await edit.execute({ prompt: 'make it blue', image_path: 'generated-images/source.png' }, exec)
check('改图走 multipart 并返回图片', Array.isArray(editValue.images) && editValue.images.length === 1, JSON.stringify(editValue.images))
check('改图请求确实发出', typeof lastEditBody === 'string', String(lastEditBody).slice(0, 80))

/* ---------------------------------------------------------------- 测试通道 */

const route = routes[0]

/**
 * 走一次 RPC：按真实客户端的样子发信封，返回状态码、原始响应体与解析后的信封。
 * url 由方法名推出，所以未知方法只能靠 handler 自己回 404。
 */
async function callRpc(target, method, payload, rpcId = `r-${method}`) {
  const requestBody = JSON.stringify({ type: 'client-request', rpcId, method, payload })
  const fakeRequest = {
    method: 'POST',
    url: `${RPC_PATH}/${method}`,
    headers: { 'content-type': 'application/json' },
    on(event, listener) {
      if (event === 'data') listener(Buffer.from(requestBody, 'utf8'))
      if (event === 'end') listener()
      return this
    },
  }
  let status
  let body
  const fakeResponse = {
    writeHead(code) { status = code; return this },
    end(text) { body = text },
  }
  await target.handler(fakeRequest, fakeResponse)
  let envelope
  try {
    envelope = JSON.parse(body)
  } catch {
    envelope = undefined
  }
  return { status, body, envelope }
}

/* 客户端永远会带上 apiKey（草稿）或 keyRef；Host 不再有"借用默认密钥"这一档。 */
const requestsBeforeTest = requests.length
const testCall = await callRpc(route, 'test', { baseUrl, apiKey: 'test-key' }, 'r1')
check('测试通道返回 200', testCall.status === 200, String(testCall.status))
check('测试通道信封合法', testCall.envelope?.type === 'server-response' && testCall.envelope.rpcId === 'r1', testCall.body)
check('测试通道探针成功（显式 apiKey，模拟 /v1/models 返回 200）', testCall.envelope?.result?.ok === true && testCall.envelope?.result?.value?.ok === true, JSON.stringify(testCall.envelope?.result))

/* test 顺带取回模型列表：一次往返就够，内容必须与 models RPC 完全相同。 */
const testRequests = requests.slice(requestsBeforeTest)
const modelsByRpc = await callRpc(route, 'models', { baseUrl, apiKey: 'test-key' })
const testModels = testCall.envelope?.result?.value?.models
const rpcModels = modelsByRpc.envelope?.result?.value?.models
check(
  'test 成功时返回体带 models，且与 models RPC 的内容一致',
  Array.isArray(testModels) && testModels.length > 0 && JSON.stringify(testModels) === JSON.stringify(rpcModels),
  `test=${JSON.stringify(testModels)} models=${JSON.stringify(rpcModels)}`,
)
check(
  'test 只用一次往返（没有为模型列表再打一遍 /models）',
  testRequests.length === 1 && testRequests[0] === 'GET /v1/models',
  JSON.stringify(testRequests),
)

/* 取模型失败不能影响可达性：200 但正文不是 JSON → test 仍判可达、models 给空数组。 */
const testPlain = await callRpc(route, 'test', { baseUrl: `${origin}/plain`, apiKey: 'test-key' })
check(
  '模型列表取不到时 test 仍判可达、models 为空数组',
  testPlain.envelope?.result?.value?.ok === true
    && Array.isArray(testPlain.envelope?.result?.value?.models)
    && testPlain.envelope.result.value.models.length === 0
    && String(testPlain.envelope.result.value.message).includes('连接成功'),
  JSON.stringify(testPlain.envelope?.result?.value),
)
check(
  '同一端点上 models RPC 仍按失败报错（解析口径没有放宽）',
  (await callRpc(route, 'models', { baseUrl: `${origin}/plain`, apiKey: 'test-key' })).envelope?.result?.ok === false,
  JSON.stringify(testPlain.envelope?.result?.value),
)

/* 500 与 401 这类"真的不可达/密钥被拒"的判定一个字没改，只是也带上空的 models。 */
const testBroken = await callRpc(route, 'test', { baseUrl: `${origin}/broken`, apiKey: 'test-key' })
check(
  '500 仍判不可达（可达性判定未改），models 为空数组',
  testBroken.envelope?.result?.value?.ok === false
    && String(testBroken.envelope.result.value.message).includes('HTTP 500')
    && Array.isArray(testBroken.envelope.result.value.models)
    && testBroken.envelope.result.value.models.length === 0,
  JSON.stringify(testBroken.envelope?.result?.value),
)
const testMissing = await callRpc(route, 'test', { baseUrl: `${origin}/missing`, apiKey: 'test-key' })
check(
  '404 仍判可达（软提示语义未变），models 为空数组',
  testMissing.envelope?.result?.value?.ok === true
    && String(testMissing.envelope.result.value.message).includes('404')
    && Array.isArray(testMissing.envelope.result.value.models)
    && testMissing.envelope.result.value.models.length === 0,
  JSON.stringify(testMissing.envelope?.result?.value),
)

/* ---------------------------------------------------------------- 缺密钥的提示 */

const noKeyRegistered = []
/** 桩必须自洽：`ctx.get('tools')` 与 `ctx.tools` 指向同一个注册表（真实 Cordis 就是同一个）。 */
const noKeyRegistry = { register: (definition) => { noKeyRegistered.push(definition); return () => {} } }
const noKeyServices = { ...services, tools: noKeyRegistry, credentials: { async resolve() { return undefined } } }
const noKeyCtx = {
  ...ctx,
  get: (name) => noKeyServices[name],
  tools: noKeyRegistry,
  inject: (_d, cb) => { cb(noKeyCtx); return () => {} },
}
delete process.env.DSH_IMAGE_BRIDGE_API_KEY
mod.apply(noKeyCtx, { baseUrl, model: 'gpt-image-1' })
const noKeyGenerate = noKeyRegistered.find((tool) => tool.name === 'image_generate')
let message = ''
try {
  await noKeyGenerate.execute({ prompt: 'x' }, exec)
} catch (error) {
  message = error instanceof Error ? error.message : String(error)
}
check('缺密钥时报出可执行的配置指引', message.includes('API Key') && message.includes('设置'), message)

/* ------------------------------------------------------------------ *
 * 多服务商：凭据名推导、baseUrl/模型分派、每次调用重读配置
 *
 * 设置服务用真实形状的桩（远程命名空间信封 + 普通 JSON 值）。旧字段 baseUrl 刻意
 * 指向 /legacy：Host 若没有优先采用 providers，请求就会打到错误地址，断言立刻暴露。
 * ------------------------------------------------------------------ */

const vendorBase = `${origin}/vendor`
const providerRefs = []
const providerTools = []
const providerRoutes = []
/** 设置服务里本行的值；测试中途整体换掉，用来验证"每次调用都重读"。 */
let providerConfigValue = {
  baseUrl: `${origin}/legacy`,
  model: 'legacy-model',
  editModel: 'legacy-edit-model',
  size: '1024x1024',
  saveToWorkspace: true,
  outputDir: 'generated-images',
  timeoutMs: 15000,
  providers: [
    {
      id: 'vendor-one',
      label: 'Vendor One',
      baseUrl: vendorBase,
      keyRef: '',
      models: ['vendor-image-v2', 'vendor-edit-v2'],
      imageModel: 'vendor-image-v2',
      editModel: 'vendor-edit-v2',
    },
    {
      id: 'plain-vendor',
      label: 'Plain Vendor',
      baseUrl: vendorBase,
      keyRef: '',
      models: [],
      imageModel: 'shared-image-model',
      editModel: '',
    },
  ],
  activeProviderId: 'vendor-one',
}
/** providers 原始列表：三级回退用例要把它整体换掉再换回来，单独留一份引用。 */
const providerList = providerConfigValue.providers
/*
 * Host 侧 settings.describe() 的真实形状是「行数组」；远程网关给客户端的是
 * `{ writable, namespaces }` 信封。两种都要能读，所以两种都做成桩。
 */
let providerSettingsMode = 'rows'
const providerSettings = {
  configure() { return () => {} },
  describe() {
    return providerSettingsMode === 'rows'
      ? [{ ns: 'image-bridge-v4', value: providerConfigValue, revision: 1, applies: 'live' }]
      : { writable: true, namespaces: [{ ns: 'image-bridge-v4', value: providerConfigValue, revision: 1 }] }
  },
}
/** 与 noKeyCtx 同理：`ctx.get('tools')` 与 `ctx.tools` 必须是同一个注册表。 */
const providerRegistry = { register: (definition) => { providerTools.push(definition); return () => {} } }
const providerServices = {
  ...services,
  tools: providerRegistry,
  settings: providerSettings,
  credentials: {
    async resolve(ref) {
      providerRefs.push(ref)
      return { value: `key-for-${ref}`, source: 'mock' }
    },
  },
  webServer: { register(entry) { providerRoutes.push(entry); return () => {} } },
}
const providerCtx = {
  ...ctx,
  get: (name) => providerServices[name],
  tools: providerRegistry,
  inject: (_deps, callback) => { callback(providerCtx); return () => {} },
}
mod.apply(providerCtx, {})

const providerGenerate = providerTools.find((tool) => tool.name === 'image_generate')
const providerEdit = providerTools.find((tool) => tool.name === 'image_edit')
check('多服务商配置下同样注册了两个工具', providerGenerate !== undefined && providerEdit !== undefined, providerTools.map((t) => t.name).join(','))

const providerValue = await providerGenerate.execute({ prompt: 'a green square' }, exec)
check(
  '生效服务商的 baseUrl 优先于旧字段',
  typeof lastVendorGenerateBody === 'string' && lastLegacyGenerateBody === undefined,
  `vendor=${Boolean(lastVendorGenerateBody)} legacy=${Boolean(lastLegacyGenerateBody)}`,
)
check('生图用当前服务商的 imageModel', String(lastVendorGenerateBody).includes('vendor-image-v2'), String(lastVendorGenerateBody))
check('凭据名按 id 推导（非字母数字换成下划线）', providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_VENDOR_ONE'), JSON.stringify(providerRefs))
check('推导出的凭据名都符合凭据服务语法', providerRefs.length > 0 && providerRefs.every((ref) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref)), JSON.stringify(providerRefs))
check('请求带上了该服务商自己的密钥', vendorAuth === 'Bearer key-for-DSH_IMAGE_BRIDGE_KEY_VENDOR_ONE', vendorAuth)
check('多服务商结果照常落盘到工作区', Array.isArray(providerValue.savedPaths) && providerValue.savedPaths.length === 1, JSON.stringify(providerValue.savedPaths))

const providerEditValue = await providerEdit.execute({ prompt: 'make it yellow', image_path: 'generated-images/source.png' }, exec)
check('改图走当前服务商的 baseUrl 并返回图片', Array.isArray(providerEditValue.images) && providerEditValue.images.length === 1 && vendorAuth === 'Bearer key-for-DSH_IMAGE_BRIDGE_KEY_VENDOR_ONE', JSON.stringify(providerEditValue.images))
check('改图用当前服务商的 editModel', String(lastVendorEditBody).includes('vendor-edit-v2'), String(lastVendorEditBody).slice(0, 160))

await providerGenerate.execute({ prompt: 'caller override', model: 'caller-model' }, exec)
check('调用时传入的 model 仍然最优先', String(lastVendorGenerateBody).includes('caller-model'), String(lastVendorGenerateBody))

/* 切换当前服务商：配置改完必须立刻生效，说明每次调用都重读了 volatile 配置。 */
providerConfigValue = { ...providerConfigValue, activeProviderId: 'plain-vendor' }
const fallbackEditValue = await providerEdit.execute({ prompt: 'make it pink', image_path: 'generated-images/source.png' }, exec)
check('服务商切换后立刻生效（每次调用都重读设置服务）', providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_PLAIN_VENDOR'), JSON.stringify(providerRefs))
check('editModel 为空时回退到 imageModel', String(lastVendorEditBody).includes('shared-image-model'), String(lastVendorEditBody).slice(0, 160))
check('回退到 imageModel 时也换了密钥', vendorAuth === 'Bearer key-for-DSH_IMAGE_BRIDGE_KEY_PLAIN_VENDOR', vendorAuth)

/*
 * 二级回退：activeProviderId 指向已消失的条目（卡片被改名/删除）时取列表第一个。
 * 设置页就是这么显示的，Host 必须同规则——否则界面说在用 A、请求却打到旧地址。
 */
providerConfigValue = { ...providerConfigValue, activeProviderId: 'missing-provider' }
lastVendorGenerateBody = undefined
providerRefs.length = 0
await providerGenerate.execute({ prompt: 'second level' }, exec)
check('activeProviderId 失效时取列表第一个（二级回退）', String(lastVendorGenerateBody).includes('vendor-image-v2'), String(lastVendorGenerateBody))
check('二级回退用第一个服务商的凭据', providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_VENDOR_ONE') && vendorAuth === 'Bearer key-for-DSH_IMAGE_BRIDGE_KEY_VENDOR_ONE', `${JSON.stringify(providerRefs)} ${vendorAuth}`)
check('二级回退不会打到旧地址', lastLegacyGenerateBody === undefined, String(lastLegacyGenerateBody))

/* ---------------------------------------------------------------- 模型列表 RPC */

const modelsRoute = providerRoutes[0]
check('多服务商上下文也挂了 RPC 路由', modelsRoute !== undefined && modelsRoute.path === RPC_PATH, JSON.stringify(providerRoutes.map((entry) => entry.path)))

/* ① 成功：payload 给 baseUrl + 这张卡片自己的 keyRef（Host 不借用别家的凭据）。 */
providerConfigValue = { ...providerConfigValue, activeProviderId: 'vendor-one' }
const modelsOk = await callRpc(modelsRoute, 'models', { baseUrl: vendorBase, keyRef: 'DSH_IMAGE_BRIDGE_KEY_VENDOR_ONE' })
check('models 方法返回 200', modelsOk.status === 200, String(modelsOk.status))
check(
  'models 成功信封为 { ok:true, value:{ models } }',
  modelsOk.envelope?.type === 'server-response' && modelsOk.envelope.result?.ok === true && Array.isArray(modelsOk.envelope.result.value?.models),
  JSON.stringify(modelsOk.envelope),
)
check(
  'models 过滤掉空 id / 非对象项并保留原顺序',
  JSON.stringify(modelsOk.envelope?.result?.value?.models) === JSON.stringify(['vendor-image-v2', 'vendor-edit-v2']),
  JSON.stringify(modelsOk.envelope?.result?.value?.models),
)
check('models 用显式 keyRef 取到凭据并带上 Authorization', modelsAuth === 'Bearer key-for-DSH_IMAGE_BRIDGE_KEY_VENDOR_ONE', modelsAuth)

/* ①b 旧单服务商卡片：显式传 DSH_IMAGE_BRIDGE_API_KEY 时必须照常工作（不能因为收紧回退而废掉）。 */
providerRefs.length = 0
const legacyRefCall = await callRpc(modelsRoute, 'models', { baseUrl: vendorBase, keyRef: 'DSH_IMAGE_BRIDGE_API_KEY' })
check(
  'models 接受旧凭据名 DSH_IMAGE_BRIDGE_API_KEY（旧配置不失效）',
  legacyRefCall.envelope?.result?.ok === true && modelsAuth === 'Bearer key-for-DSH_IMAGE_BRIDGE_API_KEY' && providerRefs[0] === 'DSH_IMAGE_BRIDGE_API_KEY',
  `${JSON.stringify(providerRefs)} ${modelsAuth}`,
)

/* ② 失败：状态码与服务商自述的 message 都要带进 error.message。 */
const modelsBad = await callRpc(modelsRoute, 'models', { baseUrl: `${origin}/broken`, apiKey: 'explicit-key' })
check(
  'models 失败信封为 { ok:false, error:{ message } }',
  modelsBad.envelope?.result?.ok === false && typeof modelsBad.envelope.result.error?.message === 'string',
  JSON.stringify(modelsBad.envelope),
)
check(
  'models 失败信息含状态码与服务商 message',
  String(modelsBad.envelope?.result?.error?.message).includes('500') && String(modelsBad.envelope?.result?.error?.message).includes('quota exhausted'),
  String(modelsBad.envelope?.result?.error?.message),
)

/* ③ 未知方法不被新端点放宽：仍然 404。 */
const unknownCall = await callRpc(modelsRoute, 'nope', {})
check('未知 RPC 方法仍返回 404', unknownCall.status === 404, String(unknownCall.status))

/* ④ 设置服务换成远程信封形状（{ writable, namespaces }）时同样要能读到 providers。 */
providerSettingsMode = 'envelope'
providerRefs.length = 0
providerConfigValue = { ...providerConfigValue, activeProviderId: 'vendor-one' }
await providerGenerate.execute({ prompt: 'envelope shape' }, exec)
check('设置服务给远程信封形状时也能读到 providers', providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_VENDOR_ONE'), JSON.stringify(providerRefs))

/* ⑤ 凭据解析：payload.apiKey → payload.keyRef（不做第三档"当前生效服务商"回退）。 */
providerSettingsMode = 'rows'
providerRefs.length = 0
const keyedByApiKey = await callRpc(modelsRoute, 'models', { baseUrl: `${origin}/keyed`, apiKey: 'payload-key', keyRef: 'DSH_IMAGE_BRIDGE_KEY_IGNORED' })
check(
  'models 给了 apiKey 就直接用，不查凭据服务',
  keyedByApiKey.envelope?.result?.ok === true && keyedModelsAuth === 'Bearer payload-key' && providerRefs.length === 0,
  `${keyedModelsAuth} refs=${JSON.stringify(providerRefs)}`,
)

providerRefs.length = 0
const keyedByRef = await callRpc(modelsRoute, 'models', { baseUrl: `${origin}/keyed`, keyRef: 'DSH_IMAGE_BRIDGE_KEY_PLAIN_VENDOR' })
check(
  'models 没有 apiKey 时按 payload.keyRef 取凭据（不借用生效服务商的密钥）',
  providerRefs[0] === 'DSH_IMAGE_BRIDGE_KEY_PLAIN_VENDOR' && keyedModelsAuth === 'Bearer key-for-DSH_IMAGE_BRIDGE_KEY_PLAIN_VENDOR',
  `${JSON.stringify(providerRefs)} ${keyedModelsAuth}`,
)
check(
  'models 按 keyRef 取到的凭据能正常拉回列表',
  JSON.stringify(keyedByRef.envelope?.result?.value?.models) === JSON.stringify(['keyed-model']),
  JSON.stringify(keyedByRef.envelope?.result?.value?.models),
)

/* ⑤b 非法 keyRef 等同"没有 keyRef"：不发请求、不借用别家凭据。 */
providerRefs.length = 0
const requestCountBefore = requests.length
const keyedByInvalidRef = await callRpc(modelsRoute, 'models', { baseUrl: `${origin}/keyed`, keyRef: 'not a ref!' })
check(
  '非法 keyRef 被忽略，且不借用生效服务商的密钥',
  keyedByInvalidRef.envelope?.result?.ok === false && requests.length === requestCountBefore && providerRefs.length === 0,
  `${JSON.stringify(keyedByInvalidRef.envelope?.result?.error?.message)} refs=${JSON.stringify(providerRefs)} 新增请求=${requests.length - requestCountBefore}`,
)

/* ------------------------------------------------------------------ *
 * F-3：apiKey 与 keyRef 都为空时，test / models 既不发请求也不借用别家凭据
 * ------------------------------------------------------------------ */

const emptyBefore = requests.length
providerRefs.length = 0
const emptyTest = await callRpc(modelsRoute, 'test', { baseUrl: vendorBase, apiKey: '', keyRef: '' })
const emptyModels = await callRpc(modelsRoute, 'models', { baseUrl: vendorBase, apiKey: '', keyRef: '' })
check(
  'test / models 双空密钥时不发任何 HTTP 请求（跨服务商密钥不会外发）',
  requests.length === emptyBefore,
  `新增请求=${JSON.stringify(requests.slice(emptyBefore))}`,
)
check(
  'test / models 双空密钥时不查凭据服务',
  providerRefs.length === 0,
  JSON.stringify(providerRefs),
)
const emptyMessage = String(emptyModels.envelope?.result?.error?.message ?? '')
check(
  'test / models 双空密钥时返回 ok:false 且提示可操作',
  emptyTest.envelope?.result?.ok === false
    && emptyModels.envelope?.result?.ok === false
    && emptyMessage.includes('API Key')
    && (emptyMessage.includes('保存') || emptyMessage.includes('填写')),
  `${JSON.stringify(emptyTest.envelope?.result?.error?.message)} | ${JSON.stringify(emptyMessage)}`,
)

/* ------------------------------------------------------------------ *
 * F-2：provider.id 的归一与客户端 slugify 同一套规则
 * ------------------------------------------------------------------ */

/* id 全是非 ASCII / 超长时，归一结果必须与客户端派生出的凭据名一致。 */
providerConfigValue = {
  ...providerConfigValue,
  providers: [
    { id: 'zh-智谱', label: '智谱', baseUrl: vendorBase, keyRef: '', models: [], imageModel: 'zh-image', editModel: '' },
    { id: 'a'.repeat(60), label: 'long', baseUrl: vendorBase, keyRef: '', models: [], imageModel: 'long-image', editModel: '' },
    { id: 'My.Vendor', label: 'dotted', baseUrl: vendorBase, keyRef: '', models: [], imageModel: 'dot-image', editModel: '' },
  ],
  activeProviderId: '',
}
providerRefs.length = 0
await providerGenerate.execute({ prompt: 'slug case' }, exec)
check(
  '非 ASCII id 归一后与客户端派生出同一个 keyRef',
  providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_ZH') && !providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_ZH___'),
  JSON.stringify(providerRefs),
)

providerConfigValue = { ...providerConfigValue, activeProviderId: 'a'.repeat(40) }
providerRefs.length = 0
await providerGenerate.execute({ prompt: 'long case' }, exec)
check(
  '超长 id 与客户端一样截断到 40 字符再推导',
  providerRefs.includes(`DSH_IMAGE_BRIDGE_KEY_${'A'.repeat(40)}`) && !providerRefs.includes(`DSH_IMAGE_BRIDGE_KEY_${'A'.repeat(41)}`),
  JSON.stringify(providerRefs),
)

providerConfigValue = { ...providerConfigValue, activeProviderId: 'my-vendor' }
providerRefs.length = 0
await providerGenerate.execute({ prompt: 'dotted case' }, exec)
check(
  '带点的 id 归一成连字符后推导（与客户端一致）',
  providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_MY_VENDOR'),
  JSON.stringify(providerRefs),
)

/* ③ 显式且合法的 keyRef 优先于归一推导；非法 keyRef 忽略并回到推导。 */
providerConfigValue = {
  ...providerConfigValue,
  providers: [{ id: 'zh-智谱', label: '智谱', baseUrl: vendorBase, keyRef: 'DSH_IMAGE_BRIDGE_KEY_CUSTOM_KEEP', models: [], imageModel: 'zh-image', editModel: '' }],
  activeProviderId: '',
}
providerRefs.length = 0
await providerGenerate.execute({ prompt: 'explicit ref' }, exec)
check(
  '显式合法 keyRef 优先于按 id 归一推导',
  providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_CUSTOM_KEEP') && !providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_ZH'),
  JSON.stringify(providerRefs),
)

providerConfigValue = {
  ...providerConfigValue,
  providers: [{ id: 'zh-智谱', label: '智谱', baseUrl: vendorBase, keyRef: 'not a ref!', models: [], imageModel: 'zh-image', editModel: '' }],
}
providerRefs.length = 0
await providerGenerate.execute({ prompt: 'invalid ref' }, exec)
check(
  '非法 keyRef 被忽略，回到按 id 推导',
  providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_ZH') && !providerRefs.includes('not a ref!'),
  JSON.stringify(providerRefs),
)

/* 两侧的 id 归一规则必须同源：同一个正则、同一个长度上限（改了一侧就会在这里红）。 */
const hostSource = await readFile(`${ROOT}/index.js`, 'utf8')
const clientSource = await readFile(`${ROOT}/client.js`, 'utf8')
const ruleOf = (body) => `${/\[\^[^\]]*\]\+/u.exec(body)?.[0] ?? ''}|${/slice\(0, (\d+)\)/u.exec(body)?.[1] ?? ''}`
const hostSlugBody = /function slugifyId\(value\) \{([\s\S]*?)\n\}/u.exec(hostSource)?.[1] ?? ''
const clientSlugBody = /function slugify\(value\) \{([\s\S]*?)\n {4}\}/u.exec(clientSource)?.[1] ?? ''
check(
  'Host 与客户端的 id 归一规则同源（同一正则 + 同一截断长度）',
  hostSlugBody !== '' && ruleOf(hostSlugBody) === ruleOf(clientSlugBody) && ruleOf(hostSlugBody).includes('[^a-z0-9]+') && ruleOf(hostSlugBody).endsWith('|40'),
  `host=${ruleOf(hostSlugBody)} client=${ruleOf(clientSlugBody)}`,
)

/*
 * provider.id 的**派生表**：README 承诺的"纯中文名折叠为空 → 改用地址主机名 → 再不行用
 * provider"此前零覆盖，这里用真实 apply 写出的启动自述把它钉住。
 * 这几条同时是 id 稳定性的基础——凭据名由 id 派生，派生一变，老密钥就失联。
 */
async function idsFromApply(providers, tag) {
  const home = await mkdtemp(join(tmpdir(), `dib-ids-${tag}-`))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const row = {
    baseUrl: 'https://fallback.example/v1',
    model: 'm',
    providers,
    activeProviderId: providers[0]?.id ?? '',
    modelRoutes: { generate: { primary: { providerId: '', model: '' }, fallback: { providerId: '', model: '' } }, edit: { primary: { providerId: '', model: '' }, fallback: { providerId: '', model: '' } } },
    connectTimeoutSeconds: 9,
  }
  const idServices = {
    tools: { register: () => () => {} },
    settings: { describe: () => [{ ns: 'image-bridge-v4', value: row }] },
    attachments: {}, credentials: { async resolve() { return undefined } },
    llm: { async resolveModelInfo() { return {} } },
    fs: {}, connection: { requestRejection: () => undefined }, webServer: { register: () => () => {} },
  }
  const idCtx = { get: (name) => idServices[name], tools: idServices.tools, inject: (_deps, callback) => { callback(idCtx); return () => {} }, effect: (fn) => fn(), logger: { warn() {}, info() {} } }
  const idMod = await import(`${pathToFileURL(`${ROOT}/index.js`).href}?ids=${tag}`)
  idMod.apply(idCtx, row)
  await new Promise((done) => setTimeout(done, 120))
  let ids = []
  try {
    const written = JSON.parse(await readFile(join(home, 'dsh-image-bridge-startup.json'), 'utf8'))
    ids = (written.config?.providers ?? []).map((provider) => provider.id)
  } catch {
    ids = []
  }
  process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
  return ids
}

const idCases = [
  ['纯中文名 + 公网地址 → 用主机名', [{ label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }], ['open-bigmodel-cn']],
  ['纯中文名 + 本机地址 → 用主机名', [{ label: '智谱', baseUrl: 'http://127.0.0.1:8799/v1' }], ['127-0-0-1']],
  ['纯中文名且无地址 → provider 兜底', [{ label: '智谱' }], ['provider']],
  ['英文名 → 折叠成连字符', [{ label: 'My Vendor' }], ['my-vendor']],
  ['无名 + 地址 → 用主机名', [{ baseUrl: 'https://api.example.com/v1' }], ['api-example-com']],
  ['超长名 → 截断 40 字符', [{ label: 'a'.repeat(60) }], ['a'.repeat(40)]],
  ['重名 → 追加 -2', [{ label: 'same' }, { label: 'same' }], ['same', 'same-2']],
]
for (const [label, providers, expected] of idCases) {
  const actual = await idsFromApply(providers, String(expected[0]).slice(0, 8).replace(/[^a-z0-9]/gu, '') || 'case')
  check(
    `provider.id 派生：${label}`,
    JSON.stringify(actual) === JSON.stringify(expected),
    `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`,
  )
}

/* ------------------------------------------------------------------ *
 * 三级回退与启动自述
 *
 * ① activeProviderId 命中 → ② 取列表第一个 → ③ providers 为空时回退旧字段。
 * 每次重新 apply 都会覆写启动自述，所以三级各 apply 一次、各读一次报告，
 * 确认自述里的 provider.level 与实际生效的地址/凭据名一致。
 * ------------------------------------------------------------------ */

/** 读一次启动自述（provider 摘要写在这里，是 Host 侧唯一能看出"用哪一级"的地方）。 */
async function readStartup() {
  await new Promise((done) => setTimeout(done, 250))
  try {
    return JSON.parse(await readFile(join(diagHome, 'dsh-image-bridge-startup.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 换一次配置、重新 apply，返回自述里的 provider 摘要。 */
async function summaryWith(patch) {
  providerConfigValue = { ...providerConfigValue, ...patch }
  mod.apply(providerCtx, {})
  return (await readStartup())?.provider ?? null
}

const summaryActive = await summaryWith({ providers: providerList, activeProviderId: 'plain-vendor' })
check(
  '启动自述标出"命中 activeProviderId"（一级）',
  summaryActive?.level === 'active' && summaryActive.id === 'plain-vendor' && summaryActive.keyRef === 'DSH_IMAGE_BRIDGE_KEY_PLAIN_VENDOR',
  JSON.stringify(summaryActive),
)

const summaryFirst = await summaryWith({ activeProviderId: 'missing-provider' })
check(
  '启动自述标出"取列表第一个"（二级）',
  summaryFirst?.level === 'first' && summaryFirst.id === 'vendor-one' && summaryFirst.requested === 'missing-provider',
  JSON.stringify(summaryFirst),
)

const summaryLegacy = await summaryWith({ providers: [], activeProviderId: '' })
check(
  '启动自述标出"回退旧字段"（三级）',
  summaryLegacy?.level === 'legacy' && summaryLegacy.keyRef === 'DSH_IMAGE_BRIDGE_API_KEY' && summaryLegacy.baseUrl === `${origin}/legacy`,
  JSON.stringify(summaryLegacy),
)

/* 三级不只是自述这么说：请求本身也必须打到旧地址、用旧凭据名。 */
lastLegacyGenerateBody = undefined
legacyAuth = ''
providerRefs.length = 0
await providerGenerate.execute({ prompt: 'level three' }, exec)
check('providers 为空时请求真的打到旧 baseUrl/model', String(lastLegacyGenerateBody).includes('legacy-model'), String(lastLegacyGenerateBody))
check('三级回退用旧的 DSH_IMAGE_BRIDGE_API_KEY', legacyAuth === 'Bearer key-for-DSH_IMAGE_BRIDGE_API_KEY', legacyAuth)

/*
 * 二级回退（选中的服务商不在了 → 用列表第一个）是必要的容错，但同时是**计费风险**：
 * 用户以为在用 A 家，请求实际打到 B 家、走 B 家的密钥与额度。此前这件事只写在启动自述的
 * `level: first` 里，工具路径从不告诉用户。这里钉住"工具结果必须带一条点名警告"，
 * 同时钉住两个"不该打扰"的场景，避免把正常情况也报成异常。
 */
providerConfigValue = { ...providerConfigValue, providers: providerList, activeProviderId: 'missing-provider' }
const swapped = await providerGenerate.execute({ prompt: 'active provider was deleted' }, exec)
const swappedWarnings = (Array.isArray(swapped.warnings) ? swapped.warnings : [swapped.warnings]).filter((entry) => typeof entry === 'string')
check(
  '二级回退时工具结果里有一条点名警告（用户知道这次是谁出的图）',
  // 点名两件事：原本选的是哪个（id），实际用的是哪个（**给人看的名字**，不是内部 id）。
  swappedWarnings.some((entry) => entry.includes('missing-provider') && entry.includes('Vendor One')),
  JSON.stringify(swapped.warnings ?? null),
)

providerConfigValue = { ...providerConfigValue, activeProviderId: 'vendor-one' }
const notSwapped = await providerGenerate.execute({ prompt: 'active provider still there' }, exec)
const notSwappedWarnings = (Array.isArray(notSwapped.warnings) ? notSwapped.warnings : [notSwapped.warnings]).filter((entry) => typeof entry === 'string')
check(
  '正常命中 activeProviderId 时不出这条警告（不打扰）',
  !notSwappedWarnings.some((entry) => entry.includes('已不在列表里')),
  JSON.stringify(notSwapped.warnings ?? null),
)

providerConfigValue = { ...providerConfigValue, activeProviderId: '' }
const neverPicked = await providerGenerate.execute({ prompt: 'no provider ever picked' }, exec)
const neverPickedWarnings = (Array.isArray(neverPicked.warnings) ? neverPicked.warnings : [neverPicked.warnings]).filter((entry) => typeof entry === 'string')
check(
  '从未选过服务商（activeProviderId 为空）时不出这条警告（用列表第一个是预期行为）',
  !neverPickedWarnings.some((entry) => entry.includes('已不在列表里')),
  JSON.stringify(neverPicked.warnings ?? null),
)

/* ------------------------------------------------------------------ *
 * 跨服务商模型路由 + 主/备用模型与「连接预算」
 *
 * 四家服务商各司其职：vendor-one 正常、alt-vendor 正常（用来证明路由用的是它的地址与
 * 凭据）、dead-vendor 一律 404、slow-vendor 拖 600ms 才回图。路由就是
 * modelRoutes.<role>.{primary,fallback} = { providerId, model }。
 * ------------------------------------------------------------------ */

const emptyRoute = () => ({ providerId: '', model: '' })
const emptyRole = () => ({ primary: emptyRoute(), fallback: emptyRoute() })
/** 各司其职的服务商配置（每次改路由都复用同一套 providers/activeProviderId）。 */
const routeProviders = [
  { id: 'vendor-one', label: 'Vendor One', baseUrl: vendorBase, keyRef: '', models: [], imageModel: 'vendor-image-v2', editModel: 'vendor-edit-v2' },
  { id: 'alt-vendor', label: 'Alt Vendor', baseUrl: `${origin}/alt-vendor`, keyRef: '', models: [], imageModel: 'alt-image', editModel: 'alt-edit' },
  { id: 'dead-vendor', label: 'Dead Vendor', baseUrl: `${origin}/dead-vendor`, keyRef: '', models: [], imageModel: 'dead-image', editModel: 'dead-edit' },
  { id: 'flaky-vendor', label: 'Flaky Vendor', baseUrl: `${origin}/flaky`, keyRef: '', models: [], imageModel: 'flaky-image', editModel: '' },
  { id: 'slow-vendor', label: 'Slow Vendor', baseUrl: `${origin}/slow-vendor`, keyRef: '', models: [], imageModel: 'slow-image', editModel: '' },
  /* TEST-NET-1（RFC 5737）是保留给文档的地址，不可路由：TCP 连不上，请求永远发不出去。
     用它验证"连接阶段超时"这条分支不会误报成"服务商没响应"。 */
  { id: 'blackhole-vendor', label: 'Blackhole Vendor', baseUrl: 'http://192.0.2.1', keyRef: '', models: [], imageModel: 'blackhole-image', editModel: '' },
  /* 域名解析不了的地址（`.invalid` 是保留 TLD，必不解析）：一次"连不上"只花几十毫秒，
     用来覆盖"主备都连不上"而不必等备用那固定的 30 秒连接预算。 */
  { id: 'dns-dead-vendor', label: 'DNS Dead Vendor', baseUrl: 'http://dib-nonexistent-host.invalid', keyRef: '', models: [], imageModel: 'dns-dead-image', editModel: '' },
  { id: 'stalled-vendor', label: 'Stalled Vendor', baseUrl: `${slowOrigin}/stalled-vendor`, keyRef: '', models: [], imageModel: 'stalled-image', editModel: '' },
  /* 请求发出很快、响应拖 5s：它必须**成功**——响应时间不再参与是否换备用的判定。 */
  { id: 'slow-header-vendor', label: 'Slow Header Vendor', baseUrl: `${headerOrigin}/slow-header-vendor`, keyRef: '', models: [], imageModel: 'slow-header-image', editModel: '' },
  /* 响应极慢但服务在听：20s 都不回，用来让「调用超时」成为唯一能掐断它的东西。 */
  { id: 'very-slow-vendor', label: 'Very Slow Vendor', baseUrl: `${headerOrigin}/very-slow-vendor`, keyRef: '', models: [], imageModel: 'very-slow-image', editModel: '' },
  { id: 'empty-vendor', label: 'Empty Vendor', baseUrl: `${origin}/empty-vendor`, keyRef: '', models: [], imageModel: 'empty-image', editModel: '' },
  { id: 'task-vendor', label: 'Task Vendor', baseUrl: `${origin}/task-vendor`, keyRef: '', models: [], imageModel: 'task-image', editModel: '' },
  { id: 'urlish-vendor', label: 'Urlish Vendor', baseUrl: `${origin}/urlish-vendor`, keyRef: '', models: [], imageModel: 'urlish-image', editModel: '' },
]
/*
 * 第三个参数是**秒**（与设置页、插件 Config 同一个单位）：它只约束"请求有没有发出去"。
 * 默认 15 秒；要造"连不上"，最小可用值是 1 秒。
 */
const setRoutes = (generate, edit = emptyRole(), connectTimeoutSeconds = 15) => {
  providerConfigValue = {
    ...providerConfigValue,
    providers: routeProviders,
    activeProviderId: 'vendor-one',
    modelRoutes: { generate, edit },
    connectTimeoutSeconds,
  }
}

/* ① 路由命中：用被选中那家服务商的 baseUrl 与凭据，而不是当前生效服务商的。 */
setRoutes({ primary: { providerId: 'alt-vendor', model: 'alt-image' }, fallback: emptyRoute() })
providerRefs.length = 0
lastAltGenerateBody = undefined
lastVendorGenerateBody = undefined
const routedValue = await providerGenerate.execute({ prompt: 'routed primary' }, exec)
check(
  '① 路由命中时用该服务商的 baseUrl（不是生效服务商的）',
  typeof lastAltGenerateBody === 'string' && String(lastAltGenerateBody).includes('alt-image') && lastVendorGenerateBody === undefined,
  `alt=${Boolean(lastAltGenerateBody)} vendor=${Boolean(lastVendorGenerateBody)}`,
)
check(
  '① 且用该服务商自己的凭据（没有借用生效服务商的密钥）',
  providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_ALT_VENDOR')
    && !providerRefs.includes('DSH_IMAGE_BRIDGE_KEY_VENDOR_ONE')
    && altAuth === 'Bearer key-for-DSH_IMAGE_BRIDGE_KEY_ALT_VENDOR',
  `${JSON.stringify(providerRefs)} ${altAuth}`,
)
check('① 结果里的模型是路由选中的那个', routedValue.model === 'alt-image', String(routedValue.model))

/* ①b 主用未配时才轮到"当前生效服务商的 imageModel"（现状不受影响）。 */
setRoutes(emptyRole())
lastVendorGenerateBody = undefined
const noRouteValue = await providerGenerate.execute({ prompt: 'no route' }, exec)
check('①b 没有路由时仍用当前生效服务商的 imageModel', noRouteValue.model === 'vendor-image-v2' && String(lastVendorGenerateBody).includes('vendor-image-v2'), String(noRouteValue.model))

/* ①c 改图走 routes.edit：用的是那家服务商的 edits 端点与它自己的凭据。 */
setRoutes(emptyRole(), { primary: { providerId: 'alt-vendor', model: 'alt-edit' }, fallback: emptyRoute() })
providerRefs.length = 0
lastAltEditBody = undefined
lastVendorEditBody = undefined
const routedEditValue = await providerEdit.execute({ prompt: 'routed edit', image_path: 'generated-images/source.png' }, exec)
check(
  '①c 改图命中 routes.edit：打到该服务商的 edits 端点并用它的凭据',
  String(lastAltEditBody).includes('alt-edit')
    && lastVendorEditBody === undefined
    && altAuth === 'Bearer key-for-DSH_IMAGE_BRIDGE_KEY_ALT_VENDOR'
    && routedEditValue.model === 'alt-edit',
  `altEdit=${Boolean(lastAltEditBody)} vendorEdit=${Boolean(lastVendorEditBody)} model=${routedEditValue.model}`,
)

/* ⑦ 路由指向的服务商没有可用凭据 → 明确报错，且不得借用别家的密钥（F-3 原则）。 */
const healthyCredentials = providerServices.credentials
providerServices.credentials = { async resolve() { return undefined } }
setRoutes({ primary: { providerId: 'alt-vendor', model: 'alt-image' }, fallback: { providerId: 'vendor-one', model: 'vendor-image-v2' } })
lastAltGenerateBody = undefined
const requestsBeforeNoKey = requests.length
let routeNoKeyError = ''
try {
  await providerGenerate.execute({ prompt: 'no key for route' }, exec)
} catch (error) {
  routeNoKeyError = error instanceof Error ? error.message : String(error)
}
providerServices.credentials = healthyCredentials
check(
  '⑦ 路由命中的服务商没有凭据时明确报错且不发请求',
  routeNoKeyError.includes('DSH_IMAGE_BRIDGE_KEY_ALT_VENDOR')
    && routeNoKeyError.includes('API Key')
    && lastAltGenerateBody === undefined
    && requests.length === requestsBeforeNoKey,
  `${routeNoKeyError} | 新增请求=${requests.length - requestsBeforeNoKey}`,
)

/* ⑦e 路由指向一个**不存在**的服务商（改名/删除卡片后残留）。真机事故：路由里存着 id `other`、
      而卡片实际是 `others` → 找不到服务商 → 旧实现静默掉到「当前生效服务商的 imageModel」，
      把**别的服务商的模型名**发到了这家地址上，换回一句 404 Model not exist，真正的错因完全看不出来。

      现在的语义分两种情况，都要断言：
        a) 没有可用备用 → 明确报错（点名那个 id）、一个请求都不发；
        b) 有可用备用   → 直接走备用（不必先等一个注定失败的请求），并**警告路由已失效**。 */
setRoutes({ primary: { providerId: 'ghost-vendor', model: 'ghost-image' }, fallback: emptyRole() })
const requestsBeforeGhostSolo = requests.length
let ghostRouteError = ''
try {
  await providerGenerate.execute({ prompt: 'route points at a deleted provider, no fallback' }, exec)
} catch (error) {
  ghostRouteError = error instanceof Error ? error.message : String(error)
}
check(
  '⑦e-1 没有可用备用时：明确报错并点名那个服务商 id（不再静默掉档）',
  ghostRouteError.includes('ghost-vendor'),
  ghostRouteError === '' ? '(没有抛错，静默掉档了)' : ghostRouteError,
)
check(
  '⑦e-2 且一个请求都不发（绝不把别家的模型/密钥发到错的地址）',
  requests.length === requestsBeforeGhostSolo,
  `新增请求=${requests.length - requestsBeforeGhostSolo}`,
)

setRoutes({ primary: { providerId: 'ghost-vendor', model: 'ghost-image' }, fallback: { providerId: 'vendor-one', model: 'vendor-image-v2' } })
lastVendorGenerateBody = undefined
const requestsBeforeGhostFallback = requests.length
const ghostWithFallback = await providerGenerate.execute({ prompt: 'stale route, good fallback' }, exec)
const ghostFallbackRequests = requests.slice(requestsBeforeGhostFallback)
check(
  '⑦e-3 有可用备用时直接走备用出图（不为一个注定失败的主用白等）',
  ghostWithFallback.model === 'vendor-image-v2' && String(lastVendorGenerateBody).includes('vendor-image-v2'),
  `${ghostWithFallback.model}`,
)
check(
  '⑦e-4 且只打了备用那一次请求（没有向不存在的服务商发任何请求）',
  ghostFallbackRequests.length === 1 && ghostFallbackRequests[0].includes('/vendor/'),
  JSON.stringify(ghostFallbackRequests),
)
check(
  '⑦e-5 并如实警告"路由指向的服务商已不在"',
  typeof ghostWithFallback.warnings === 'string' || Array.isArray(ghostWithFallback.warnings)
    ? JSON.stringify(ghostWithFallback.warnings).includes('ghost-vendor')
    : false,
  JSON.stringify(ghostWithFallback.warnings ?? null),
)

/* ⑦f 备用路由指向不存在的服务商时，主用照常走，但要么明确告知、要么如实放弃备用，
      不能把"不存在的服务商"当成一个可用的备用。 */
setRoutes({ primary: { providerId: 'vendor-one', model: 'vendor-image-v2' }, fallback: { providerId: 'ghost-vendor', model: 'ghost-image' } })
lastVendorGenerateBody = undefined
const ghostFallbackValue = await providerGenerate.execute({ prompt: 'fallback points at a deleted provider' }, exec)
check(
  '⑦f 备用的服务商不存在时主用照常出图（不被坏备用拖累）',
  ghostFallbackValue.model === 'vendor-image-v2' && String(lastVendorGenerateBody).includes('vendor-image-v2'),
  `${ghostFallbackValue.model}`,
)

/* ② 主模型 404 → 自动改用备用模型并成功。 */
setRoutes({ primary: { providerId: 'dead-vendor', model: 'dead-image' }, fallback: { providerId: 'vendor-one', model: 'vendor-image-v2' } })
lastVendorGenerateBody = undefined
const requestsBeforeFallback = requests.length
const fallbackValue = await providerGenerate.execute({ prompt: 'fallback case' }, exec)
check(
  '② 主模型 404 时自动改用备用模型并成功',
  fallbackValue.model === 'vendor-image-v2' && String(lastVendorGenerateBody).includes('vendor-image-v2'),
  `${fallbackValue.model} ${String(lastVendorGenerateBody).slice(0, 80)}`,
)
check(
  '② 先打主模型、失败后才打备用（顺序正确）',
  requests.slice(requestsBeforeFallback).join(' | ') === 'POST /dead-vendor/images/generations | POST /vendor/images/generations',
  JSON.stringify(requests.slice(requestsBeforeFallback)),
)
check(
  '② 结果里说明这次是备用模型出的图',
  Array.isArray(fallbackValue.warnings) && fallbackValue.warnings.some((warning) => warning.includes('备用模型')),
  JSON.stringify(fallbackValue.warnings),
)

/* ③ 主模型答得慢（600ms）→ **不再**中止、更不换备用：响应时间已经完全不参与判定。
      连接预算用默认的 15 秒（本地连接毫秒级完成），所以这条只钉"慢响应不被误杀"。 */
setRoutes({ primary: { providerId: 'slow-vendor', model: 'slow-image' }, fallback: { providerId: 'vendor-one', model: 'vendor-image-v2' } })
lastVendorGenerateBody = undefined
const requestsBeforeSlow = requests.length
const slowValue = await providerGenerate.execute({ prompt: 'slow responder case' }, exec)
check(
  '③ 服务商答得慢也照旧出图（响应时间不再触发中止或换备用）',
  slowValue.model === 'slow-image' && lastVendorGenerateBody === undefined,
  `model=${slowValue.model} 备用收到请求=${typeof lastVendorGenerateBody === 'string'}`,
)
check(
  '③ 且只打了主模型那一次请求（慢 ≠ 换人，避免白花备用的钱）',
  requests.slice(requestsBeforeSlow).join(' | ') === 'POST /slow-vendor/images/generations'
    && slowValue.warnings === undefined,
  `${JSON.stringify(requests.slice(requestsBeforeSlow))} warnings=${JSON.stringify(slowValue.warnings)}`,
)
check(
  '③ 主模型的请求确实发出去过（不是压根没发就成功）',
  requests.slice(requestsBeforeSlow).some((entry) => entry.includes('/slow-vendor/')),
  JSON.stringify(requests.slice(requestsBeforeSlow)),
)

/* ④ 备用没配 → 直接把主模型的错误报出来。 */
setRoutes({ primary: { providerId: 'dead-vendor', model: 'dead-image' }, fallback: emptyRoute() })
let noFallbackError = ''
try {
  await providerGenerate.execute({ prompt: 'no fallback' }, exec)
} catch (error) {
  noFallbackError = error instanceof Error ? error.message : String(error)
}
check('④ 备用未配置时直接报主模型的错（含模型名与原因）', noFallbackError.includes('dead-image') && noFallbackError.includes('404'), noFallbackError)

/* ⑤ 取消不是失败：exec.signal 已中止时绝不尝试备用。 */
setRoutes({ primary: { providerId: 'slow-vendor', model: 'slow-image' }, fallback: { providerId: 'vendor-one', model: 'vendor-image-v2' } })
const cancelController = new AbortController()
const cancelExec = { ...exec, signal: cancelController.signal }
setTimeout(() => cancelController.abort(new Error('用户取消')), 80)
const requestsBeforeCancel = requests.length
let cancelError = ''
try {
  await providerGenerate.execute({ prompt: 'cancel case' }, cancelExec)
} catch (error) {
  cancelError = error instanceof Error ? error.message : String(error)
}
const cancelRequests = requests.slice(requestsBeforeCancel)
check(
  '⑤ exec.signal 取消时不尝试备用（请求只发了主模型那一次）',
  cancelError.includes('已中止') && cancelRequests.length >= 1 && cancelRequests.every((entry) => entry.includes('/slow-vendor/')),
  `${cancelError} | ${JSON.stringify(cancelRequests)}`,
)

/* ⑥ 请求**已经发出**之后传输才断：绝不重发。
     重发一次非幂等的 POST，服务商可能已经生成并计费两次，所以这里钉"服务器只见到一次请求"。 */
setRoutes(emptyRole())
providerConfigValue = { ...providerConfigValue, activeProviderId: 'flaky-vendor' }
flakyAttempts = 0
lastFlakyGenerateBody = undefined
const requestsBeforeFlaky = requests.length
let flakyError = ''
try {
  await providerGenerate.execute({ prompt: 'flaky case' }, exec)
} catch (error) {
  flakyError = error instanceof Error ? error.message : String(error)
}
check(
  '⑥ 请求已经发出后断了：不重发（服务器只收到一次 POST，避免重复计费）',
  flakyAttempts === 1
    && requests.slice(requestsBeforeFlaky).filter((entry) => entry.includes('/flaky/')).length === 1
    && lastFlakyGenerateBody === undefined,
  `attempts=${flakyAttempts} 请求=${JSON.stringify(requests.slice(requestsBeforeFlaky))}`,
)
check(
  '⑥ 且如实说清"请求已经发出、不重发"（不是含糊的失败）',
  flakyError.includes('请求已经发出') && flakyError.includes('不重发'),
  flakyError,
)

/* ⑥b 备用也失败时，错误里要能同时看到两次尝试的模型与原因。 */
setRoutes({ primary: { providerId: 'dead-vendor', model: 'dead-image' }, fallback: { providerId: 'task-vendor', model: 'task-image' } })
let bothFailError = ''
try {
  await providerGenerate.execute({ prompt: 'both fail' }, exec)
} catch (error) {
  bothFailError = error instanceof Error ? error.message : String(error)
}
check(
  '⑥b 备用也失败时错误里同时有两次尝试的模型与原因',
  bothFailError.includes('dead-image')
    && bothFailError.includes('404')
    && bothFailError.includes('task-image')
    && (bothFailError.includes('没有 data 数组') || bothFailError.includes('没有返回任何可用的图片数据')),
  bothFailError,
)

/* ------------------------------------------------------------------ *
 * ⑧ 200 但没有可用图片（空 data / 任务态）也算"这次没出图" → 换备用
 *
 * 从用户视角，"回包成功但一张图都没解出来"和"连接失败"一样都是没出图；真机上
 * 模型不支持该端点、data 为空、返回任务态都会长成这样。边界：只有**确实解析不出
 * 任何可用图片**才算失败，正常出图（哪怕一张）绝不能因此重试（会重复计费）。
 * ------------------------------------------------------------------ */

/* ⑧ 主模型 200 + data 为空 → 自动改用备用并成功出图，且只多打一次请求。 */
setRoutes({ primary: { providerId: 'empty-vendor', model: 'empty-image' }, fallback: { providerId: 'vendor-one', model: 'vendor-image-v2' } })
lastVendorGenerateBody = undefined
const requestsBeforeEmpty = requests.length
const emptyValue = await providerGenerate.execute({ prompt: 'empty data case' }, exec)
check(
  '⑧ 主模型 200 但 data 为空 → 自动改用备用并成功出图',
  emptyValue.model === 'vendor-image-v2' && String(lastVendorGenerateBody).includes('vendor-image-v2'),
  String(emptyValue.model),
)
check(
  '⑧ 且确实只打了两次请求（主一次、备用一次）',
  requests.slice(requestsBeforeEmpty).join(' | ') === 'POST /empty-vendor/images/generations | POST /vendor/images/generations',
  JSON.stringify(requests.slice(requestsBeforeEmpty)),
)
check(
  '⑧ warning 说明是备用出的图，并带上"没有可用图片"这个原因',
  Array.isArray(emptyValue.warnings)
    && emptyValue.warnings.some((warning) => warning.includes('备用模型') && warning.includes('没有返回任何可用的图片数据')),
  JSON.stringify(emptyValue.warnings),
)

/* ⑧b 任务态回包（200、没有 data 数组）同样触发备用。 */
setRoutes({ primary: { providerId: 'task-vendor', model: 'task-image' }, fallback: { providerId: 'vendor-one', model: 'vendor-image-v2' } })
lastVendorGenerateBody = undefined
const requestsBeforeTask = requests.length
const taskValue = await providerGenerate.execute({ prompt: 'task state case' }, exec)
check(
  '⑧b 200 返回任务态（没有 data 数组）同样换备用',
  taskValue.model === 'vendor-image-v2' && requests.slice(requestsBeforeTask).length === 2,
  `${taskValue.model} ${JSON.stringify(requests.slice(requestsBeforeTask))}`,
)

/* ⑨ 正常出图（哪怕只有一张）绝不触发备用：请求数必须仍是 1。 */
setRoutes({ primary: { providerId: 'vendor-one', model: 'vendor-image-v2' }, fallback: { providerId: 'alt-vendor', model: 'alt-image' } })
lastAltGenerateBody = undefined
altAuth = ''
const requestsBeforeNormal = requests.length
const normalValue = await providerGenerate.execute({ prompt: 'normal single image' }, exec)
check(
  '⑨ 正常出图不触发备用（请求数=1，防止重复计费）',
  requests.slice(requestsBeforeNormal).join(' | ') === 'POST /vendor/images/generations'
    && lastAltGenerateBody === undefined
    && normalValue.warnings === undefined,
  `${JSON.stringify(requests.slice(requestsBeforeNormal))} alt=${Boolean(lastAltGenerateBody)} warnings=${JSON.stringify(normalValue.warnings)}`,
)

/* ⑨b 主备都拿不到图片时，错误要能看出两次都是"回包没有可用图片"，而不是网络/状态码问题。 */
setRoutes({ primary: { providerId: 'empty-vendor', model: 'empty-image' }, fallback: { providerId: 'task-vendor', model: 'task-image' } })
let noImageError = ''
try {
  await providerGenerate.execute({ prompt: 'no image on both' }, exec)
} catch (error) {
  noImageError = error instanceof Error ? error.message : String(error)
}
check(
  '⑨b 主备都没图片时错误里同时说明两次都是"回包无可用图片"',
  noImageError.includes('empty-image')
    && noImageError.includes('task-image')
    && (noImageError.match(/没有返回任何可用的图片数据|没有 data 数组/gu) ?? []).length >= 2,
  noImageError,
)

/* ⑨c 边界：图片已产出、只是下载失败 → 硬错误、不换备用（那已经是一次计过费的生成）。 */
setRoutes({ primary: { providerId: 'urlish-vendor', model: 'urlish-image' }, fallback: { providerId: 'vendor-one', model: 'vendor-image-v2' } })
const requestsBeforeUrlish = requests.length
let downloadError = ''
try {
  await providerGenerate.execute({ prompt: 'download failure' }, exec)
} catch (error) {
  downloadError = error instanceof Error ? error.message : String(error)
}
check(
  '⑨c 图片只是下载失败时不换备用（避免重复计费）',
  downloadError.includes('下载生成的图片失败')
    && requests.slice(requestsBeforeUrlish).filter((entry) => entry.includes('/vendor/')).length === 0,
  `${downloadError} | ${JSON.stringify(requests.slice(requestsBeforeUrlish))}`,
)

/* ------------------------------------------------------------------ *
 * ⑦ 时间只用来判"连接"：请求发出去之后，服务商想多久都不再换备用
 *
 * 判据来自 undici 的 `undici:request:bodySent`（诊断通道）：它一旦触发，本次尝试就脱离连接
 * 预算，响应快慢只剩整次调用的上限 `timeoutMs` 兜底。用例覆盖三个分支：
 *   ⑦a 发出前慢但最终发得出去 + 连接预算给够 → 必须成功（连接耗时确实算在预算里）；
 *   ⑦b 根本连不上（TEST-NET-1 黑洞）→ 必须报"连接阶段"、说清用户设的秒数、且不发请求；
 *   ⑦b-3 主备都连不上 → 最终错误以「模型连接失败」开头并点名两次尝试；
 *   ⑦c 发出很快、服务商拖 5s → 必须**成功**（响应时间不再参与判定，这就是这次改动的全部意义）。
 * 只测"慢响应仍会超时"是测不出新语义的——那正是被删掉的旧行为。
 * ------------------------------------------------------------------ */

/* ⑦a 发出前慢 1.5s，但服务商答得很快，连接预算 2 秒 → 必须成功出图。
      注：这是**健壮性哨兵**，证明的是"连接耗时算在预算里但没超"；证明"发出后不再计时"的是 ⑦c。 */
setRoutes({ primary: { providerId: 'stalled-vendor', model: 'stalled-image' }, fallback: { providerId: 'vendor-one', model: 'vendor-image-v2' } }, emptyRole(), 2)
lastStalledVendorBody = undefined
lastVendorGenerateBody = undefined
const stalledStartedAt = Date.now()
const stalledValue = await providerGenerate.execute({ prompt: 'slow send, fast answer' }, exec)
const stalledElapsed = Date.now() - stalledStartedAt
check(
  '⑦a 插件确实拿到了"请求真正发出"的时刻（订阅在当前 Node 上有效）',
  typeof mod.lastRequestSentMoment() === 'number' && mod.lastRequestSentMoment() >= stalledStartedAt,
  `lastRequestSentMoment=${mod.lastRequestSentMoment()}`,
)
check(
  '⑦a 发出前慢但发得出去：连接预算 2 秒时主模型仍成功出图（没被误判成超时）',
  stalledValue.model === 'stalled-image' && lastVendorGenerateBody === undefined,
  `model=${stalledValue.model} 总耗时=${stalledElapsed}ms`,
)

/* ⑦b 连不上（不可路由地址）：请求发不出去 → 必须报"连接阶段"，不能甩锅给服务商。
      连接预算取最小可用值 **1 秒**：黑地址上 TCP 永远建不起来，1 秒足够确定"没发出去"，
      这条也就不会真的等默认的 15 秒。 */
setRoutes({ primary: { providerId: 'blackhole-vendor', model: 'blackhole-image' }, fallback: emptyRole() }, emptyRole(), 1)
const requestsBeforeBlackhole = requests.length
let connectPhaseError = ''
try {
  await providerGenerate.execute({ prompt: 'unreachable host' }, exec)
} catch (error) {
  connectPhaseError = error instanceof Error ? error.message : String(error)
}
check(
  '⑦b 发不出去时：报"连接阶段…没把请求发出去"，并把用户设的秒数说给他听',
  connectPhaseError.includes('连接阶段')
    && connectPhaseError.includes('你设的连接超时是 1 秒')
    && connectPhaseError.includes('blackhole-image'),
  `实际=${connectPhaseError === '' ? '(没有抛错)' : connectPhaseError}`,
)
const blackholeVerdict = mod.lastBudgetVerdict()
check(
  '⑦b 判定依据是"请求从没发出去"：一个包都没发，且诊断值读得到（seenSentAt=0）',
  requests.length === requestsBeforeBlackhole
    && blackholeVerdict?.seenSentAt === 0
    && blackholeVerdict?.connectTimeoutMs === 1000,
  `新增请求=${requests.length - requestsBeforeBlackhole} verdict=${JSON.stringify(blackholeVerdict)}`,
)
check(
  '⑦b 最终错误以「模型连接失败：」开头，并告诉用户去哪儿自查',
  connectPhaseError.startsWith('模型连接失败：') && connectPhaseError.includes('设置 → 生图桥'),
  connectPhaseError,
)

/* ⑦b-2 连不上**必须真的切备用**：⑦b 只钉住了错误文案，这里钉行为本身。
       主用是不可路由地址（请求压根发不出去），备用是活的模拟服务商 → 结果必须来自备用，
       且备用确实收到了请求；结果里的警告要同时说清"为什么没成"与"已改用谁"。
       连接预算取 1 秒，所以这条不会真的等 15 秒（备用的 30 秒固定预算只算连接，本地连接够快）。 */
setRoutes({ primary: { providerId: 'blackhole-vendor', model: 'blackhole-image' }, fallback: { providerId: 'vendor-one', model: 'vendor-image-v2' } }, emptyRole(), 1)
lastVendorGenerateBody = undefined
const connectSwapValue = await providerGenerate.execute({ prompt: 'unreachable primary must swap' }, exec)
check(
  '⑦b-2 连接阶段超时（连不上）→ 真的改用备用模型出图，且备用收到了请求',
  connectSwapValue.model === 'vendor-image-v2' && String(lastVendorGenerateBody).includes('vendor-image-v2'),
  `model=${connectSwapValue.model} 备用收到请求=${typeof lastVendorGenerateBody === 'string'}`,
)
const connectSwapWarning = (Array.isArray(connectSwapValue.warnings) ? connectSwapValue.warnings : []).join(' | ')
check(
  '⑦b-2 警告里同时有点名的失败原因（连接阶段）与"已改用备用模型"',
  connectSwapWarning.includes('连接阶段') && connectSwapWarning.includes('已改用备用模型') && connectSwapWarning.includes('vendor-image-v2'),
  connectSwapWarning === '' ? '(没有警告)' : connectSwapWarning,
)

/* ⑦b-3 主备都连不上 → 用户看到的必须是那句固定的「模型连接失败」，并且两次尝试都点名。
       备用刻意用**解析不了**的域名（`.invalid` 是保留 TLD，必不解析）：一次失败只花几十毫秒，
       不会让这条用例真去烧备用那固定的 30 秒连接预算。 */
setRoutes({ primary: { providerId: 'blackhole-vendor', model: 'blackhole-image' }, fallback: { providerId: 'dns-dead-vendor', model: 'dns-dead-image' } }, emptyRole(), 1)
const bothDeadStartedAt = Date.now()
let bothDeadError = ''
try {
  await providerGenerate.execute({ prompt: 'both providers unreachable' }, exec)
} catch (error) {
  bothDeadError = error instanceof Error ? error.message : String(error)
}
const bothDeadElapsed = Date.now() - bothDeadStartedAt
check(
  '⑦b-3 主备都连不上：错误以「模型连接失败：」开头，并点名两次尝试',
  bothDeadError.startsWith('模型连接失败：')
    && bothDeadError.includes('blackhole-image')
    && bothDeadError.includes('dns-dead-image'),
  bothDeadError === '' ? '(没有抛错)' : bothDeadError,
)
check(
  '⑦b-3 并分别说清主用（连接阶段）与备用（DNS 解析失败）的原因，以及去哪儿自查',
  bothDeadError.includes('连接阶段')
    && bothDeadError.includes('ENOTFOUND')
    && bothDeadError.includes('设置 → 生图桥'),
  bothDeadError,
)
check(
  '⑦b-3 备用走的是快速失败（没有把固定的 30 秒连接预算烧掉）',
  bothDeadElapsed < 5000,
  `耗时=${bothDeadElapsed}ms`,
)

/* ⑦c 反过来钉住新语义：请求发出很快、服务商拖 5s，连接预算只给 1 秒 → 仍然必须成功出图。
      慢的是**响应**不是连接，所以成功本身就证明响应时间不参与任何判定；备用一次都不该被碰。 */
setRoutes({ primary: { providerId: 'slow-header-vendor', model: 'slow-header-image' }, fallback: { providerId: 'alt-vendor', model: 'alt-image' } }, emptyRole(), 1)
slowHeaderStartAt = 0
slowHeaderEndAt = 0
lastAltGenerateBody = undefined
const slowHeaderStartedAt = Date.now()
const slowHeaderValue = await providerGenerate.execute({ prompt: 'slow responder must still win' }, exec)
const slowHeaderElapsed = Date.now() - slowHeaderStartedAt
check(
  '⑦c 服务商拖 5s 也必须成功出图（响应时间不再触发中止）',
  slowHeaderValue.model === 'slow-header-image' && slowHeaderElapsed >= SLOW_HEADER_DELAY_MS - 100,
  `model=${slowHeaderValue.model} 总耗时=${slowHeaderElapsed}ms`,
)
check(
  '⑦c 且一次都没换备用（"慢"不再等于"这家不行"）',
  lastAltGenerateBody === undefined && slowHeaderValue.warnings === undefined,
  `备用收到请求=${typeof lastAltGenerateBody === 'string'} warnings=${JSON.stringify(slowHeaderValue.warnings)}`,
)

/*
 * ⑦d 「调用超时」必须**按调用时重读的配置**生效，并兜住"服务商就是不回"的那一头。
 *
 * 旧实现把它当工具注册期的快照（`timeoutMs: resolved.timeoutMs`），而 README 承诺这些字段
 * 可以在线改写——于是用户在设置页把超时从 180 秒改成 1 秒，实际毫无变化。这条用一个
 * 20 秒都不回的服务商 + 1 秒预算来钉住：小预算必须真的把整次调用掐断，并说清超了多久。
 * 连接预算取 9 秒（远大于 1 秒的调用超时）：掐断必须来自「调用超时」，而不是连接阶段。
 */
const timeoutBefore = providerConfigValue.timeoutMs
providerConfigValue = { ...providerConfigValue, timeoutMs: 1000 }
setRoutes({ primary: { providerId: 'very-slow-vendor', model: 'very-slow-image' }, fallback: emptyRole() }, emptyRole(), 9)
let callTimeoutError = ''
try {
  await providerGenerate.execute({ prompt: 'call budget should fire' }, exec)
} catch (error) {
  callTimeoutError = error instanceof Error ? error.message : String(error)
}
providerConfigValue = { ...providerConfigValue, timeoutMs: timeoutBefore }
check(
  '⑦d 「调用超时」按调用时重读的配置生效（改成 1 秒就真的 1 秒掐断）',
  callTimeoutError.includes('整次调用超过 1000ms'),
  callTimeoutError || '(没有报错)',
)

/* ---------------------------------------------------------------- 收尾 */

server.closeAllConnections?.()
await new Promise((closed) => server.close(closed))
slowServer.closeAllConnections?.()
await new Promise((closed) => slowServer.close(closed))
headerServer.closeAllConnections?.()
await new Promise((closed) => headerServer.close(closed))
await new Promise((done) => setTimeout(done, 300))
await rm(workRoot, { recursive: true, force: true })
await rm(diagHome, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(`\nSUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
process.exitCode = failed.length === 0 ? 0 : 1
