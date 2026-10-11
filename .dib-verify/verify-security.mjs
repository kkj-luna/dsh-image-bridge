/**
 * 安全边界验收：服务商**返回的图片地址**与**接口回包大小**，外加 baseUrl 的校验策略。
 *
 * 为什么单独一套：这两件事的失败模式是"替别人发请求"与"被别人的回包吃光内存"，
 * 都不是功能测试会碰到的路径——正常的 mock 只返回一张合法图片地址。
 * 这里用一个刻意"恶意"的模拟服务商来触发它们：
 *   - 回包里给内网地址（云元数据 169.254.169.254、本机、私网）→ 必须拒收，且**一个请求都不发**；
 *   - 回包里给超长正文 → 必须在上限处停下，而不是读到内存爆掉。
 * 另一条被审查点名的边界：`baseUrl` 的策略**故意与图片地址不同**——用户自己填的接口地址
 * 允许本机（本地生图服务、本地 mock 都是正当用法），只拦协议与形态；但**空地址必须直接失败**，
 * 绝不能回退到"当前生效服务商"的地址（那正是真机事故的另一半）。
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_DIR, resolveDshBin, resolveProfileDir } from './dsh-paths.mjs'

process.env.DSH_PROFILE_DIR = resolveProfileDir()
process.argv[1] = resolveDshBin()
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dib-sec-home-'))
const ROOT = PLUGIN_DIR

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'ok   ' : 'FAIL '} ${name}${condition || detail === undefined ? '' : ` — ${detail}`}`)
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 记录"我们的进程替服务商发出去的所有请求"，用来断言 SSRF 没有被触发。 */
const outbound = []
/** `/models` 的应答开关：RPC 用例需要它回一个合法 JSON。 */
let rpcMode = 'image'
/**
 * 重定向用例的"第二跳"服务器。
 *
 * 单独起一个：这样"守卫只看了第一跳"这件事可以用**它有没有被访问**来判定，
 * 而不是靠读错误文案。历史上这个洞就是靠文案看不出来的（第一跳是合法地址）。
 */
const redirectHits = []
const redirectTarget = createServer((request, response) => {
  redirectHits.push(`${request.method} ${request.url}`)
  response.writeHead(200, { 'content-type': 'image/png' })
  response.end(PNG)
})
await new Promise((ready) => redirectTarget.listen(0, '127.0.0.1', ready))
const redirectTargetPort = redirectTarget.address().port

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const url = request.url
    const body = Buffer.concat(chunks).toString('utf8')
    /*
     * 用 body 里的 prompt 判定"这是一次生图请求"，而不是靠路径前缀：
     * 本验收在意的是"服务商回了什么"，路径细节属于别的套件的范围。
     *
     * 暗号：
     *   - `target:<名字>` → 回**恶意形态**（内网地址 / 超大正文 / 只会 RST 的地址）；
     *   - `hop:<端口>` → 回一个指向本机某个端口、它自己会 302 到别处的地址；
     *   - `blackhole:<端口>` → 回一个指向"只会 RST"的本机端口；
     *   - `many` → 一次回很多条目；
     *   - `plain` → 回一张**正常的内联图片**，用于"正常路径仍然可用"这类对照用例
     *     （必须成功，否则"拒绝了该拒的"就无从区分"把功能整体改坏了"）。
     */
    const target = /"prompt":"target:([a-z]+)"/u.exec(body)?.[1]
    const blackhole = /"prompt":"blackhole:(\d+)"/u.exec(body)?.[1]
    if (blackhole !== undefined) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${blackhole}/img.png` }] }))
      return
    }
    const hopTo = /"prompt":"hop:(\d+)"/u.exec(body)?.[1]
    if (hopTo !== undefined) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${hopTo}/hop` }] }))
      return
    }
    if (target === undefined && /"prompt":"plain/u.test(body)) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
      return
    }
    if (target === 'many') {
      // 12 个条目：插件必须只采纳上限内的张数，并如实说明截断了。
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: Array.from({ length: 12 }, () => ({ b64_json: PNG.toString('base64') })) }))
      return
    }
    if (target !== undefined) {
      if (target === 'huge') {
        // 先声明一个很大的 content-length，然后持续吐数据：客户端必须按**声明**就停下。
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) })
        const filler = `"${'A'.repeat(512 * 1024)}"`
        for (let index = 0; index < 24; index += 1) response.write(filler)
        response.end('"}')
        return
      }
      if (target === 'hugechunked') {
        /*
         * **不报 content-length**（分块传输），持续吐 160 MiB。
         *
         * 这是"只信声明"那一层的照妖镜：声明式预检在这里无事可做，只有"边读边计数"
         * 才能在越过上限时停下。旧实现是 `response.text()` 全量读完再比长度，
         * 于是整段正文会先被吃进内存（160 MiB 足以让内存断言与"读一点就停"区分开）。
         */
        response.writeHead(200, { 'content-type': 'application/json' })
        const filler = `"${'B'.repeat(512 * 1024)}"`
        for (let index = 0; index < 320; index += 1) {
          if (response.writableEnded || response.destroyed) break
          response.write(filler)
        }
        response.end('"}')
        return
      }
      const link = target === 'metadata'
        ? 'http://169.254.169.254/latest/meta-data/'
        : target === 'loopback'
          ? `http://127.0.0.1:${server.address().port}/internal-secret`
          : target === 'private'
            ? 'http://10.0.0.5/secret.png'
            : target === 'mapped'
              // 环回地址的 IPv4-mapped 写法：URL 归一化后是 [::ffff:7f00:1]，字符串前缀匹配会漏
              ? `http://[::ffff:127.0.0.1]:${server.address().port}/internal-secret`
              : target === 'mappedmetadata'
                ? 'http://[::ffff:169.254.169.254]/latest/meta-data/'
                : 'http://10.0.0.5/secret.png'
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ url: link }] }))
      return
    }
    outbound.push(`${request.method} ${url}`)
    if (url === '/hop') {
      // 第一跳：302 到另一个回环端口。守卫必须在这一跳把它拦下来。
      response.writeHead(302, { location: `http://127.0.0.1:${redirectTargetPort}/redirected-secret` })
      response.end()
      return
    }
    if (url.startsWith('/models') && rpcMode === 'json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'sec-image' }] }))
      return
    }
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(PNG)
  })
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const origin = `http://127.0.0.1:${server.address().port}`

/* ---------------------------------------------------------------- 假的 Cordis ctx */

const registered = []
const routes = []
const workRoot = await mkdtemp(join(tmpdir(), 'dib-sec-work-'))
/*
 * 把诊断日志也指到临时目录：本套件要灌日志验证"总量封顶 + 轮转"，绝不能在用户真实的
 * `~/.dsh` 里灌 1 MiB 垃圾。插件在**调用时**读 `DSH_HOME`（不是加载时），所以这里设置有效。
 */
const logHome = await mkdtemp(join(tmpdir(), 'dib-sec-home-'))
process.env.DSH_HOME = logHome

/** 与插件 `effectiveConfigOf` 的读取路径对齐：设置服务给一行，行里带 providers。 */
const rowValue = {
  baseUrl: origin,
  model: 'sec-image',
  editModel: '',
  size: '1024x1024',
  saveToWorkspace: true,
  outputDir: 'generated-images',
  timeoutMs: 30000,
  providers: [{ id: 'provider', label: 'Provider', baseUrl: origin, keyRef: '', models: [], imageModel: 'sec-image', editModel: '' }],
  activeProviderId: 'provider',
  modelRoutes: {
    generate: { primary: { providerId: '', model: '' }, fallback: { providerId: '', model: '' } },
    edit: { primary: { providerId: '', model: '' }, fallback: { providerId: '', model: '' } },
  },
  connectTimeoutSeconds: 1,
}

const services = {
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  settings: { describe: () => [{ ns: 'image-bridge-v4', value: rowValue }] },
  attachments: {
    async saveImage({ mediaType, data, name }) {
      return { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType, bytes: data.byteLength, width: 1, height: 1, name }
    },
  },
  credentials: { async resolve(ref) { return ref === 'DSH_IMAGE_BRIDGE_KEY_PROVIDER' ? { value: 'key-for-provider' } : undefined } },
  llm: { async resolveModelInfo() { return { inputModalities: ['image', 'text'] } }, listProviders: () => [] },
  fs: {
    async resolve(path, opts) { return { displayPath: path, hostPath: join(opts?.cwd ?? workRoot, path) } },
    async stat() { return { version: 'v1' } },
    async readBytes(target) { throw new Error('本验收不读文件') },
  },
  connection: { requestRejection: () => undefined },
  webServer: { register(route) { routes.push(route); return () => {} } },
}
const ctx = {
  get: (name) => services[name],
  tools: services.tools,
  inject: (_deps, callback) => { callback(ctx); return () => {} },
  effect: (fn) => fn(),
  logger: { warn() {}, info() {} },
}

const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)
mod.apply(ctx, rowValue)
const generate = registered.find((tool) => tool.name === 'image_generate')
if (generate === undefined) throw new Error('image_generate 没有注册成功，安全验收无法进行')

const exec = { signal: undefined, agent: { session: { header: { cwd: workRoot } } }, session: undefined }

/** RPC 桩：直接调用插件注册的那条路由，与 verify-host.mjs 同一套。 */
const rpcRoute = routes.find((route) => String(route.path).includes('/dsh-image-bridge'))
if (rpcRoute === undefined) throw new Error('插件没有注册 RPC 路由，安全验收无法进行')

async function callRpc(method, payload, rpcId = `sec-${method}`) {
  const requestBody = JSON.stringify({ type: 'client-request', rpcId, method, payload })
  const fakeRequest = {
    method: 'POST',
    url: `/dsh-image-bridge/${method}`,
    headers: { 'content-type': 'application/json' },
    on(event, listener) {
      if (event === 'data') listener(Buffer.from(requestBody, 'utf8'))
      if (event === 'end') listener()
      return this
    },
  }
  let body
  const fakeResponse = { writeHead() { return this }, end(text) { body = text } }
  await rpcRoute.handler(fakeRequest, fakeResponse)
  const envelope = (() => { try { return JSON.parse(body) } catch { return undefined } })()
  const message = envelope?.result?.ok === false ? (envelope.result.error?.message ?? 'RPC 失败') : ''
  return { message, envelope }
}

/* ---------------------------------------------------------------- 用例 */

async function attempt(target) {
  outbound.length = 0
  let error = ''
  try {
    await generate.execute({ prompt: `target:${target}` }, exec)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  return { error, requests: [...outbound] }
}

for (const [target, label] of [['metadata', '云元数据 169.254.169.254'], ['loopback', '本机 127.0.0.1'], ['private', '私网 10.0.0.5']]) {
  const { error, requests } = await attempt(target)
  check(
    `① 服务商返回的图片地址指向${label} → 拒收`,
    error.includes('已拒绝请求'),
    error || '(没有报错)',
  )
  check(
    '① 且我们一个请求都没替它发出去（SSRF 未触发）',
    requests.length === 0,
    JSON.stringify(requests),
  )
}

{
  const { error } = await attempt('huge')
  check(
    '② 回包超大 → 在上限处停下，不把内存读爆',
    error.includes('上限') || error.includes('超过'),
    error || '(没有报错)',
  )
}

/* ------------------------------------------------------------------ *
 * ②b 分块回包：**不报 content-length** 时的上限
 *
 * 上一组（②）走的是"声明式预检"：服务商自己报了 64 MiB，所以在上限处直接拒答。
 * 真正的风险是**不报长度**（分块传输）或谎报长度：那时只能靠"边读边计数"。
 * 旧实现是 `response.text()` 全量读完再比长度，于是 160 MiB 会先被读进内存。
 * 这里不仅断言报错，还断言**内存没有按正文规模增长**——只看错误文案的话，
 * "读完再报错"和"读到上限就停"是分不出来的。
 * ------------------------------------------------------------------ */
{
  const before = process.memoryUsage().rss
  const { error } = await attempt('hugechunked')
  const growth = process.memoryUsage().rss - before
  check(
    '②b 不报 content-length 的分块回包也在上限处停下',
    error.includes('上限') || error.includes('超过'),
    error || '(没有报错)',
  )
  check(
    '②b 且没有被整体读进内存（正文 160 MiB，增量应远小于它）',
    growth < 80 * 1024 * 1024,
    `RSS 增量 ${(growth / 1024 / 1024).toFixed(1)} MiB`,
  )
}

/* ------------------------------------------------------------------ *
 * ①b/①c 换个写法也要拦住：IPv4-mapped IPv6 与重定向
 *
 * 这些形态都实测绕过过旧守卫，逐条钉住：
 *   - `[::ffff:127.0.0.1]`：URL 归一化成 `[::ffff:7f00:1]`，字符串前缀 `/^(…|::ffff:127\.)/`
 *     永远匹配不到 → 环回放行；
 *   - `[::ffff:169.254.169.254]`：同一个洞，目标是云元数据；
 *   - 302：守卫只看了第一个 URL 字符串，跟随重定向后不再复检。
 * 判定一律用**目标服务器有没有被访问**，不靠错误文案。
 * ------------------------------------------------------------------ */
{
  for (const [target, label] of [['mapped', 'IPv4-mapped 环回 [::ffff:127.0.0.1]'], ['mappedmetadata', 'IPv4-mapped 云元数据 [::ffff:169.254.169.254]']]) {
    const { error, requests } = await attempt(target)
    check(`①b 图片地址用${label} → 拒收`, error.includes('已拒绝请求'), error || '(没有报错)')
    check('①b 且一个请求都没替它发出去', requests.length === 0, JSON.stringify(requests))
  }

  /* 合法第一跳（本机地址是正当用法）302 到另一个端口：必须拒绝跟随。 */
  redirectHits.length = 0
  outbound.length = 0
  let hopError = ''
  try {
    await generate.execute({ prompt: `hop:${server.address().port}` }, exec)
  } catch (caught) {
    hopError = caught instanceof Error ? caught.message : String(caught)
  }
  check(
    '①c 合法第一跳 302 到内网端口 → 拒绝跟随（不是只看第一跳）',
    hopError.includes('重定向') || hopError.includes('拒绝'),
    hopError || '(没有报错)',
  )
  check('①c 且重定向目标一个请求都没收到', redirectHits.length === 0, JSON.stringify(redirectHits))

  /*
   * 反向对照：守卫不能把"名字里带 fc/fd"的合法主机名误判成私网。
   * 旧写法 `/^(…|fc|fd)/` 不锚定 IPv6 字面量，`fdic.gov`、`fc2.com` 这类域名会被拒收。
   * 直接喂函数判定，避免本机 DNS 依赖。
   */
  const guard = mod.__testImageUrlRejection
  check(
    '①d 守卫对合法主机名不误判（fdic.gov / fc2.com / fcdn.example.com）',
    typeof guard === 'function'
      && guard('https://fdic.gov/a.png') === undefined
      && guard('https://fc2.com/a.png') === undefined
      && guard('https://fcdn.example.com/a.png') === undefined,
    typeof guard === 'function' ? '函数已导出但判定不符' : '（插件没有导出 __testImageUrlRejection）',
  )
  check(
    '①d 同时仍然拦住真正的 IPv6 私网/链路本地（fd00::1 / fe80::1 / ::1）',
    typeof guard === 'function'
      && guard('http://[fd00::1]/a.png') !== undefined
      && guard('http://[fe80::1]/a.png') !== undefined
      && guard('http://[::1]/a.png') !== undefined,
    typeof guard === 'function' ? '函数已导出但判定不符' : '（插件没有导出 __testImageUrlRejection）',
  )
}

/* ------------------------------------------------------------------ *
 * ②c 一次回包的条目数封顶
 *
 * 请求只发 `n: 1`，但回包内容由服务商决定：每个条目都会 saveImage + 在工作区落一个文件。
 * 旧实现照单全收（实测 500 个条目 → 500 个附件 + 500 个文件）。
 * ------------------------------------------------------------------ */
{
  let saved = 0
  const originalAttachments = services.attachments
  services.attachments = {
    async saveImage({ mediaType, data, name }) {
      saved += 1
      return { attachmentId: `sha256:${String(saved).padStart(64, '0')}`, mediaType, bytes: data.byteLength, width: 1, height: 1, name }
    },
  }
  let value
  let error = ''
  try {
    value = await generate.execute({ prompt: 'target:many' }, exec)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    services.attachments = originalAttachments
  }
  check(
    '②c 一次回包给 12 个条目 → 只采纳上限内的张数，且附件写入次数一致',
    error === '' && value !== undefined && value.images.length > 0 && value.images.length <= 4 && saved === value.images.length,
    error || `saveImage ${saved} 次，images=${value?.images?.length}`,
  )
  check(
    '②c 且如实告知被截断（不是静默丢弃）',
    Array.isArray(value?.warnings) && value.warnings.some((line) => line.includes('只采纳')),
    JSON.stringify(value?.warnings ?? []),
  )
}

/* ------------------------------------------------------------------ *
 * ②d 凭据名不能当"读环境变量"的入口
 *
 * 只校验形状时，`keyRef: "AWS_SECRET_ACCESS_KEY"` 会被照单接受，再由 `resolveApiKey`
 * 回退读同名环境变量，最后当 `Bearer` 发给**同一次请求里指定的** baseUrl——
 * 一个名字输入框就变成了"读宿主任意环境变量并外发"的原语（实测可复现）。
 * ------------------------------------------------------------------ */
{
  const marker = 'CANARY-LEAK-MARKER-VALUE'
  process.env.AWS_SECRET_ACCESS_KEY = marker
  const seen = []
  const probe = createServer((request, response) => {
    seen.push(request.headers.authorization ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe' }] }))
  })
  await new Promise((ready) => probe.listen(0, '127.0.0.1', ready))
  const probeOrigin = `http://127.0.0.1:${probe.address().port}`
  try {
    await callRpc('models', { baseUrl: probeOrigin, keyRef: 'AWS_SECRET_ACCESS_KEY' }, 'sec-keyref')
    check('②d 命名空间外的 keyRef 不会被读成环境变量发出去', seen.every((header) => !header.includes(marker)), JSON.stringify(seen))
    // 对照：本插件自己的名字仍然照常工作（用没在凭据服务注册过的名字，验环境变量回退这条路还通）。
    process.env.DSH_IMAGE_BRIDGE_KEY_ENVFALLBACK = marker
    await callRpc('models', { baseUrl: probeOrigin, keyRef: 'DSH_IMAGE_BRIDGE_KEY_ENVFALLBACK' }, 'sec-keyref-ok')
    check('②d 且本插件命名空间内的 keyRef 照常可用（对照，没有把功能改坏）', seen.some((header) => header.includes(marker)), JSON.stringify(seen))
    delete process.env.DSH_IMAGE_BRIDGE_KEY_ENVFALLBACK
  } finally {
    delete process.env.AWS_SECRET_ACCESS_KEY
    probe.closeAllConnections?.()
    await new Promise((done) => probe.close(done))
  }
}

/* ------------------------------------------------------------------ *
 * ①e 重试不能丢掉超时与取消
 *
 * 旧实现的兜底重试会 `delete init.signal`：下载的 15 秒超时与调用方取消都挂在那个信号上，
 * 于是"先 RST 再黑洞"的服务商能让工具调用永久挂住（实测插件预算 3 秒、调用方 1.5 秒取消，
 * 调用依然不返回）。
 * ------------------------------------------------------------------ */
{
  const blackhole = createServer((request, response) => {
    request.socket.destroy()
    void response
  })
  await new Promise((ready) => blackhole.listen(0, '127.0.0.1', ready))
  const controller = new AbortController()
  const startedAt = Date.now()
  const running = generate.execute({ prompt: `blackhole:${blackhole.address().port}` }, {
    signal: controller.signal,
    agent: { session: { header: { cwd: workRoot } } },
    session: undefined,
  }).then(() => 'settled').catch(() => 'settled')
  setTimeout(() => controller.abort(new Error('caller-cancel')), 1500)
  const settled = await Promise.race([
    running.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ])
  const elapsed = Date.now() - startedAt
  check(
    '①e 调用方取消后，下载重试也必须跟着结束（不会永久挂住）',
    settled === true && elapsed < 8000,
    `settled=${settled} 用时 ${elapsed}ms`,
  )
  blackhole.closeAllConnections?.()
  await new Promise((done) => blackhole.close(done))
}

/* baseUrl 策略：本机地址可用；空地址必须直接失败且不回退。 */
{
  rpcMode = 'json'
  const local = await callRpc('models', { baseUrl: origin, apiKey: 'k1' })
  check('③ 本机 baseUrl 被接受（不被误判成私网而拒收）', local.message === '', local.message || '(失败)')
  check('③ 且确实打到了那个本机地址的 /models', outbound.some((entry) => entry.includes('/models')), JSON.stringify(outbound))

  const before = outbound.length
  const empty = await callRpc('models', { baseUrl: '', apiKey: 'k1' })
  check('③ 空 baseUrl 明确报错「没有可用的接口地址」', empty.message.includes('没有可用的接口地址'), empty.message || '(没有报错)')
  check('③ 且没有回退到生效服务商的地址去发请求', outbound.length === before, JSON.stringify(outbound.slice(before)))

  const badProtocol = await callRpc('models', { baseUrl: 'file:///etc/passwd', apiKey: 'k1' })
  check('③ 非 http/https 协议被拒（file: 之类不该碰）', badProtocol.message.includes('不支持的协议'), badProtocol.message || '(没有报错)')
}

/* ---------------------------------------------------------------- 收尾 */

/* ------------------------------------------------------------------ *
 * ④ 落盘不能跟着符号链接走出工作区
 *
 * 词法检查（`relative()` 不以 `..` 开头）挡不住 symlink：工作区里一个指向外部的
 * `generated-images` 链接，拼接出来的路径"看起来"在工作区内，实际写到了外面。
 * 这条既验拒绝路径，也验**正常路径仍然能写**——只验前者的话，把功能整体改坏也能通过。
 * ------------------------------------------------------------------ */
{
  const outsideDir = await mkdtemp(join(tmpdir(), 'dib-sec-outside-'))
  const linkWorkspace = await mkdtemp(join(tmpdir(), 'dib-sec-link-'))
  let symlinkMade = false
  try {
    await symlink(outsideDir, join(linkWorkspace, 'generated-images'), 'junction')
    symlinkMade = true
  } catch {
    /* Windows 上无权限建链接时跳过这一条（不伪装成通过） */
  }
  if (symlinkMade) {
    outbound.length = 0
    /*
     * 注意断言的对象：落盘失败**不该**让整次调用失败——图已经生成、已经计费，丢结果更糟。
     * 这里刻意**不 catch 抛错**，而是看返回值里的 `warnings`：拒绝原因必须出现在那里，
     * 同时磁盘上一个字节都不能落到工作区外。
     */
    let linkValue
    let linkError = ''
    try {
      linkValue = await generate.execute({ prompt: 'plain symlink escape' }, { ...exec, agent: { session: { header: { cwd: linkWorkspace } } } })
    } catch (error) {
      linkError = error instanceof Error ? error.message : String(error)
    }
    const outsideNames = await readdir(outsideDir).catch(() => [])
    const linkNames = await readdir(join(linkWorkspace, 'generated-images')).catch(() => [])
    const warnings = Array.isArray(linkValue?.warnings) ? linkValue.warnings : []
    const refused = warnings.some((entry) => String(entry).includes('符号链接'))
    check(
      '④ 工作区里的目录链接指向外部时，落盘被拒绝（以警告降级，不丢已生成的图）',
      linkError === '' && refused && outsideNames.length === 0 && linkNames.length === 0,
      JSON.stringify({ linkError: linkError.slice(0, 80), refused, outsideNames, linkNames, warnings: warnings.map((entry) => String(entry).slice(0, 60)) }),
    )
  } else {
    check('④ 工作区里的目录链接指向外部时，保存被拒绝且没有写到外面', false, '（本机无法创建符号链接，无法验证）')
  }

  /* 红-绿的另一半：普通工作区必须照常写入，别把正常路径一起挡了。 */
  const plainWorkspace = await mkdtemp(join(tmpdir(), 'dib-sec-plain-'))
  outbound.length = 0
  let plainError = ''
  try {
    await generate.execute({ prompt: 'plain write' }, { ...exec, agent: { session: { header: { cwd: plainWorkspace } } } })
  } catch (error) {
    plainError = error instanceof Error ? error.message : String(error)
  }
  const plainFiles = await readdir(join(plainWorkspace, 'generated-images')).catch(() => [])
  check(
    '④ 普通工作区照常写入生成的图片（防护没有把正常路径挡掉）',
    plainError === '' && plainFiles.length === 1 && plainFiles[0].endsWith('.png'),
    JSON.stringify({ plainError: plainError.slice(0, 80), plainFiles }),
  )
  /*
   * 清理要**单独容错**：Windows 上删除含 junction 的目录可能抛 ENOTEMPTY（目标目录里的文件
   * 还在被删的过程中），那是环境问题，不该把"验收结论"一起带走。断言已经跑完，清理失败
   * 只记录一行提示。
   */
  const cleanup = async (target) => { await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}) }
  await cleanup(outsideDir)
  await cleanup(linkWorkspace)
  await cleanup(plainWorkspace)
}

/* ------------------------------------------------------------------ *
 * ⑤ 诊断日志总量封顶 + 轮转
 *
 * 这条通道由浏览器驱动，Host 没有观测手段，所以必须存在；但要是一个出错循环就能把用户磁盘
 * 一路写满，那就是拒绝服务。原先只有"单条长度上限"，没有总量与速率上限。
 * ------------------------------------------------------------------ */
{
  const logPath = join(logHome, 'dsh-image-bridge-client.log')
  const bigDetail = 'x'.repeat(8000)
  // 灌到肯定超过 1 MiB：每条约 8 KiB，200 条约 1.6 MiB
  for (let index = 0; index < 200; index += 1) {
    await callRpc('log', { level: 'info', message: `flood-${index}`, detail: bigDetail }, `flood-${index}`)
  }
  const mainSize = await stat(logPath).then((info) => info.size).catch(() => 0)
  check(
    '⑤ 灌 200 条大日志后，主日志不超过 1 MiB（总量封顶）',
    mainSize > 0 && mainSize <= 1024 * 1024 + 20 * 1024,
    `主日志 ${mainSize} 字节`,
  )
  check(
    '⑤ 速率上限先于总量上限生效：200 条里只有 60 条落盘（其余被丢弃并已计数）',
    mainSize < 60 * 9000 + 20 * 1024,
    `主日志 ${mainSize} 字节 ≈ ${Math.round(mainSize / 8192)} 条`,
  )
  /*
   * 轮转单独验：预置一个"历史累积超过上限"的日志，再让插件写一条——它必须先轮转再写。
   * 不能靠上面的灌流量来触发轮转：**速率上限会先把写入挡住**，日志根本长不到上限
   * （这也正是上面那条断言在测的事）。
   */
  /*
   * 丢弃痕迹要在**覆盖之前**取证：下面为了验轮转会把主日志整个覆盖掉，之后再读就没这条了。
   * （这也说明取证时机本身就是断言的一部分——晚一步证据就没了。）
   */
  const floodText = await readFile(logPath, 'utf8').catch(() => '')
  const dropNotice = floodText.split('\n').find((line) => line.includes('已丢弃')) ?? ''
  check(
    '⑤ 被限流时留下"丢了 N 条"的痕迹（否则会把丢弃误读成没发生）',
    dropNotice !== '',
    dropNotice.slice(0, 150) || '(主日志里没有丢弃提示)',
  )

  await writeFile(logPath, `${'y'.repeat(1100 * 1024)}\n`)
  const beforeRotate = await stat(logPath).then((info) => info.size)
  /*
   * 上一个窗口已经被 200 条灌满，直接写会被"丢弃"而不是轮转（那正是限流在生效）。
   * 这里让插件把窗口基准往前挪 10 秒，等价于"过了十分钟再来一条"——生产的限流规则没变，
   * 变的只是测试驱动时间的方式；用 sleep 等 10 秒既慢又不可靠。
   */
  mod.advanceLogWindowForTest(10000)
  await callRpc('log', { level: 'info', message: 'after-rotate', detail: 'short' }, 'after-rotate')
  const rotatedSize = await stat(`${logPath}.1`).then((info) => info.size).catch(() => 0)
  const afterRotate = await stat(logPath).then((info) => info.size).catch(() => 0)
  check(
    '⑤ 日志达到上限时轮转到 .1，主日志重新开始（不会无限增长）',
    beforeRotate > 1024 * 1024 && rotatedSize > 1024 * 1024 && afterRotate < 64 * 1024,
    JSON.stringify({ beforeRotate, rotatedSize, afterRotate }),
  )
  /* 轮转后主日志里应当有那条新记录；而"丢弃提示"可能在主日志或轮转文件里，两处都查。 */
  const logText = await readFile(logPath, 'utf8').catch(() => '')
  const rotatedText = await readFile(`${logPath}.1`, 'utf8').catch(() => '')
  check(
    '⑤ 轮转后新记录进主日志、旧内容进 .1（没有把内容弄丢）',
    logText.includes('after-rotate') && rotatedText.includes('yyyy'),
    JSON.stringify({ hasNew: logText.includes('after-rotate'), hasOld: rotatedText.includes('yyyy') }),
  )
}

server.closeAllConnections?.()
await new Promise((closed) => server.close(closed))
redirectTarget.closeAllConnections?.()
await new Promise((closed) => redirectTarget.close(closed))
await rm(workRoot, { recursive: true, force: true })
await rm(logHome, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(`\nSUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
process.exitCode = failed.length === 0 ? 0 : 1
