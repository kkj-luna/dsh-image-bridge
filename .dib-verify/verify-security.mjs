/**
 * 安全边界验收：服务商**返回的图片地址**与**接口回包大小**。
 *
 * 为什么单独一套：这两件事的失败模式是"替别人发请求"与"被别人的回包吃光内存"，
 * 都不是功能测试会碰到的路径——正常的 mock 只会返回一张合法图片地址。
 * 这里用一个刻意"恶意"的模拟服务商来触发它们：
 *   - 回包里给内网地址（云元数据 169.254.169.254、本机、私网）→ 必须拒收，且**一个请求都不发**；
 *   - 回包里给超长正文 → 必须在上限处停下，而不是读到内存爆掉。
 *
 * 另一条被审查点名的边界：`baseUrl` 的校验策略**故意与图片地址不同**——
 * 用户自己填的接口地址允许本机（本地生图服务、本地 mock 都是正当用法），
 * 只拦协议与形态。这条也在这里钉住，免得以后有人"顺手"把私网也拦掉。
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_DIR, resolveDshBin, resolveProfileDir } from './dsh-paths.mjs'

process.env.DSH_PROFILE_DIR = resolveProfileDir()
process.argv[1] = resolveDshBin()
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

/** 记录"我们的进程替服务商发出去的所有请求"，用来断言 SSRF 没被触发。 */
const outbound = []
/** RPC 用例的应答开关：'json' 时对 `/models` 回一个合法 JSON。 */
let rpcMode = 'image'

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const url = request.url
    if (url.startsWith('/v1/images/generations')) {
      const body = Buffer.concat(chunks).toString('utf8')
      const target = /"target":"([^"]+)"/u.exec(body)?.[1] ?? 'private'
      if (target === 'huge') {
        // 声明一个很大的 content-length，然后持续吐数据：客户端必须在上限处停下。
        response.writeHead(200, { 'content-type': 'application/json' })
        const filler = `"${'A'.repeat(1024 * 1024)}"`
        for (let index = 0; index < 64; index += 1) response.write(filler)
        response.end()
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
    // 任何别的路径都是"我们不该发出去的请求"：记账并回一张图。
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

const workRoot = await mkdtemp(join(tmpdir(), 'dib-sec-'))
const registered = []
const credentials = new Map([['DSH_IMAGE_BRIDGE_KEY_PROVIDER', 'key-for-provider']])
const providerConfigValue = {
  baseUrl: origin,
  model: 'sec-image',
  editModel: '',
  size: '1024x1024',
  saveToWorkspace: true,
  outputDir: 'generated-images',
  timeoutMs: 30000,
  providers: [{ id: 'provider', label: 'Provider', baseUrl: origin, keyRef: '', models: [], imageModel: 'sec-image', editModel: '' }],
  activeProviderId: 'provider',
  modelRoutes: { generate: { primary: { providerId: '', model: '' }, fallback: { providerId: '', model: '' } }, edit: { primary: { providerId: '', model: '' }, fallback: { providerId: '', model: '' } } },
  fallbackAfterMs: 9000,
}
const providerServices = {
  tools: { register: (tool) => registered.push(tool) },
  attachments: { async saveImage() { return { attachmentId: 'att-1', mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 } } },
  credentials: { async resolve(ref) { const value = credentials.get(ref); return value === undefined ? undefined : { value } } },
  fs: {},
  llm: { listProviders: () => [] },
  logger: { warn() {}, info() {} },
}
const scope = {
  get: (name) => providerServices[name],
  provide: () => {},
  effect: (fn) => fn(),
  on: () => {},
  logger: { warn() {}, info() {} },
  inject: (_deps, callback) => { callback(scope); return () => {} },
}
const ctx = {
  get: scope.get,
  tools: providerServices.tools,
  inject: scope.inject,
  effect: scope.effect,
  on: scope.on,
  logger: scope.logger,
  fs: scope.fs,
  config: { get: () => providerConfigValue },
}

const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)
mod.apply(ctx)
const generate = registered.find((tool) => tool.name === 'image_generate')
if (generate === undefined) throw new Error('image_generate 没有注册成功，安全验收无法进行')
const exec = { signal: undefined, agent: undefined, session: undefined }

function configOf() {
  return { ...providerConfigValue, providers: [{ ...providerConfigValue.providers[0] }] }
}
const config = { get: () => configOf() }

/* 让插件通过 ctx.get('config') 之类的路径也能拿到同一份配置。 */
providerServices.config = config
scope.config = config

/* ---------------------------------------------------------------- 用例 */

/** 每个用例换一个 prompt，服务商据此决定回什么（见上面的 target 解析）。 */
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
    error.includes('已拒绝请求') || error.includes('私有网段') || error.includes('本机'),
    error || '(没有报错)',
  )
  check(
    `① 且我们一个请求都没替它发出去（SSRF 未触发）`,
    requests.length === 0,
    JSON.stringify(requests),
  )
}

{
  const { error, requests } = await attempt('huge')
  check(
    '② 回包超大 → 在上限处停下，不把内存读爆',
    error.includes('上限') || error.includes('超过'),
    error || '(没有报错)',
  )
  check('② 且没有把超长正文当成有效图片', requests.length === 0, JSON.stringify(requests))
}

/*
 * baseUrl 策略：用户自己填的地址**允许**本机（本地生图服务是正当用法），只拦协议与形态；
 * 而**空地址**必须直接失败——那是真机事故的另一半：地址为空时旧实现回退到"当前生效服务商"
 * 的地址，于是拿 B 的密钥去问 A 的地址。两条都通过 RPC 通道验。
 */
{
  const reply = (status, payload) => { rpcStatus = status; rpcBody = JSON.stringify(payload) }

  // 本机地址应被接受（服务商在应答，返回 200 与合法 JSON）。
  rpcMode = 'json'
  let localError = ''
  try {
    await callRpc('models', { baseUrl: origin, apiKey: 'k1' })
  } catch (error) {
    localError = error instanceof Error ? error.message : String(error)
  }
  check('③ 本机 baseUrl 被接受（不被误判成私网而拒收）', localError === '', localError)
  check('③ 且确实打到了那个本机地址', outbound.some((entry) => entry.includes('/models')), JSON.stringify(outbound))

  // 空地址必须直接失败，且**不能**回退到当前生效服务商的地址。
  const requestsBefore = outbound.length
  let emptyError = ''
  try {
    await callRpc('models', { baseUrl: '', apiKey: 'k1' })
  } catch (error) {
    emptyError = error instanceof Error ? error.message : String(error)
  }
  check('③ 空 baseUrl 明确报错「请先填写接口地址」', emptyError.includes('没有可用的接口地址'), emptyError || '(没有报错)')
  check('③ 且没有回退到生效服务商的地址去发请求', outbound.length === requestsBefore, JSON.stringify(outbound.slice(requestsBefore)))
}

/* ---------------------------------------------------------------- 收尾 */

server.closeAllConnections?.()
await new Promise((closed) => server.close(closed))
await rm(workRoot, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(`\nSUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
process.exitCode = failed.length === 0 ? 0 : 1
