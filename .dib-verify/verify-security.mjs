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
import { mkdtemp, rm } from 'node:fs/promises'
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

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const url = request.url
    const body = Buffer.concat(chunks).toString('utf8')
    /*
     * 用 body 里的 prompt 判定"这是一次生图请求"，而不是靠路径前缀：
     * 本验收在意的是"服务商回了什么"，路径细节属于别的套件的范围。
     */
    const target = /"prompt":"target:([a-z]+)"/u.exec(body)?.[1]
    if (target !== undefined) {
      if (target === 'huge') {
        // 先声明一个很大的 content-length，然后持续吐数据：客户端必须在上限处停下。
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) })
        const filler = `"${'A'.repeat(512 * 1024)}"`
        for (let index = 0; index < 24; index += 1) response.write(filler)
        response.end('"}')
        return
      }
      const link = target === 'metadata'
        ? 'http://169.254.169.254/latest/meta-data/'
        : target === 'loopback'
          ? `http://127.0.0.1:${server.address().port}/internal-secret`
          : 'http://10.0.0.5/secret.png'
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ url: link }] }))
      return
    }
    outbound.push(`${request.method} ${url}`)
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

server.closeAllConnections?.()
await new Promise((closed) => server.close(closed))
await rm(workRoot, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(`\nSUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
process.exitCode = failed.length === 0 ? 0 : 1
