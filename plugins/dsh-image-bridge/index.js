/**
 * 生图桥 · Host 半。
 *
 * 给没有生图/修图能力的模型接上外部生图模型：
 *
 * - 注册 `image_generate` 与 `image_edit` 两个工具，把外部接口返回的图片提交为
 *   **持久图片附件**（`ctx.attachments.saveImage`），并在会话工作区里另存一份真实文件；
 * - 配置分两处存：可公开的接口地址/模型等走本插件的 `Config`（Web 设置页写入，
 *   字段必须是 volatile 才允许在线改写），API Key 走 `credentials` 服务
 *   （落在 $DSH_HOME/.credentials.yaml，不回传浏览器、不写进 profile 的 YAML）；
 * - 提供一条与 `/api` 同等防护的环回 RPC 通道，供设置页做「测试连接」。
 *
 * 面向模型的渲染按调用路由的图片输入能力分叉：路由声明 `image` 输入时把图片作为
 * image 内容块随工具结果下发（模型能直接看到），否则只下发文本与文件路径，避免不支持
 * 图片输入的模型在请求阶段被适配器以 UNSUPPORTED_CONTENT 拒绝。
 *
 * 面向界面的渲染走 `output.presentationMeta`：图片引用与保存路径恒久化在
 * `tool/result` 的 meta 上，客户端半的自定义 `tool.call.toolview` 据此显示图片，
 * 与模型是否有视觉能力无关。
 *
 * @module dsh-image-bridge
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/*
 * dsh 自带依赖的解析。
 *
 * profile 里的插件目录通常是指向工作区的链接，而 Node 按真实路径解析裸模块名，
 * 于是从工作区出发找不到 profile 或 dsh 安装目录的 node_modules。这里按顺序尝试
 * 多个基准，任一条路走通即可，任何一项失败都只降级该能力，绝不让整个插件无法激活：
 *
 * 1. CLI 入口所在位置 —— 与任何环境变量无关，能直接命中 dsh 安装目录；
 * 2. DSH_PROFILE_DIR —— profile 自己安装的依赖（例如别的插件带进来的 schemastery）；
 * 3. DSH_HOME、当前工作目录 —— 兜底。
 */
const RESOLVE_BASES = [
  ...process.argv.slice(1),
  process.env.DSH_PROFILE_DIR === undefined ? undefined : join(process.env.DSH_PROFILE_DIR, 'package.json'),
  process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, 'package.json'),
  join(process.cwd(), 'package.json'),
].filter((base) => typeof base === 'string' && base !== '')

async function loadOptional(specifier) {
  const attempts = []
  try {
    return await import(specifier)
  } catch (error) {
    attempts.push({ strategy: 'import', base: specifier, error: String(error?.code ?? error?.message ?? error) })
  }
  for (const base of RESOLVE_BASES) {
    try {
      return { default: createRequire(base)(specifier) }
    } catch (error) {
      attempts.push({ strategy: 'createRequire', base, error: String(error?.code ?? error?.message ?? error) })
    }
  }
  LAST_RESOLUTION_FAILURE = { specifier, attempts }
  return undefined
}

/** 最近一次解析失败的全部尝试记录；供降级自诊断写出。 */
let LAST_RESOLUTION_FAILURE

/**
 * 工具定义包装。
 *
 * `loadOptional` 走 `createRequire` 兜底时返回的是 `{ default: 模块 }` 包装，走运行时
 * import 时是模块命名空间——两种形状都要能取到 `defineTool`。
 *
 * 这一点很要紧：恒等兜底不会把参数从「作者格式」编译成 JSON Schema，`ctx.tools.register`
 * 的 schema 校验随即抛错，结果是**一个工具都注册不上**（而 Config 因为单独做了
 * `.default` 解包仍然正常，于是表现为「配置表在、工具不见」）。
 */
const toolsModule = await loadOptional('@deepseek-ai/dsh-tools')
const defineTool = toolsModule?.defineTool ?? toolsModule?.default?.defineTool ?? ((options) => options)

/** Config Schema 构造器；缺失时不再导出 Config，只保留 profile patch 配置。 */
const schemastery = await loadOptional('@deepseek-ai/schemastery')
const z = schemastery === undefined ? undefined : schemastery.default ?? schemastery

export const name = '@local/image-bridge'

/** 工具注册表是唯一的硬依赖；其余服务在 apply 内按需注入。 */
export const inject = ['tools']

/**
 * 可公开的接口配置。
 *
 * 每个字段都标了 `volatile()`：settings 服务只允许在线改写 volatile 字段
 * （非 volatile 会在写入时被 `Config field "x" is not volatile` 拒绝）。
 * 写作命名空间就是本插件行的 id —— `image-bridge`。
 */
export const Config = z === undefined ? undefined : z.object({
  baseUrl: z
    .string()
    .default('https://api.openai.com/v1')
    .volatile()
    .description('图片接口基础地址（OpenAI 兼容）。生图走 {baseUrl}/images/generations，改图走 {baseUrl}/images/edits。'),
  model: z.string().default('gpt-image-1').volatile().description('生图模型名，例如 gpt-image-1、cogview-4、Kwai-Kolors/Kolors。'),
  editModel: z.string().default('').volatile().description('改图模型名；留空时沿用生图模型。'),
  size: z.string().default('1024x1024').volatile().description('默认尺寸，例如 1024x1024、1024x1536、1536x1024。'),
  saveToWorkspace: z.boolean().default(true).volatile().description('是否把生成的图片另存为会话工作区里的文件。'),
  outputDir: z.string().default('generated-images').volatile().description('工作区内的保存目录（相对路径，不能跳出工作区）。'),
  timeoutMs: z.number().default(180000).volatile().description('单次生图/改图请求的超时毫秒数。'),
})

/** API Key 在 credentials 服务里的引用名（同时作为环境变量回退名）。 */
const API_KEY_REF = 'DSH_IMAGE_BRIDGE_API_KEY'

/** 设置页「测试连接」用的环回 RPC 通道。 */
const RPC_CHANNEL = '/dsh-image-bridge'

/** 图片值对象的属性表：两种用法共享，只有外层包装不同。 */
const IMAGE_VALUE_PROPERTIES = {
  attachmentId: { type: 'string', required: true },
  mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
  bytes: { type: 'integer', required: true },
  width: { type: 'integer', required: true },
  height: { type: 'integer', required: true },
  name: { type: 'string' },
}

/** 图片结果值：与内置 `read_image` 的输出结构保持一致，界面按同一套字段消费。 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: IMAGE_VALUE_PROPERTIES,
}

/**
 * 数组 `items` 位置专用的一份。
 *
 * 值 schema DSL 不允许 `items` 上出现根级 `required`——属性值位置可以（内置
 * `read_image` 正是那样用的），数组元素位置不行，否则 `defineTool` 编译输出 schema 时
 * 直接抛 `UNSUPPORTED_SCHEMA`，而 `apply` 会因此在注册工具时整体失败。
 */
const IMAGE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: IMAGE_VALUE_PROPERTIES,
}

/** 工具输出 Schema：`images` 是持久附件引用，`savedPaths` 是工作区里的真实文件。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    images: { type: 'array', required: true, items: IMAGE_ITEM_SCHEMA },
    model: { type: 'string', required: true },
    prompt: { type: 'string', required: true },
    size: { type: 'string' },
    revisedPrompts: { type: 'array', items: { type: 'string' } },
    savedPaths: { type: 'array', items: { type: 'string' } },
    imageCapable: { type: 'boolean', required: true },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/** 截断接口回显，避免把整段错误正文灌进模型上下文。 */
function truncate(text, limit = 600) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

function normalizedConfig(config) {
  const value = config !== null && typeof config === 'object' ? config : {}
  const baseUrl = typeof value.baseUrl === 'string' && value.baseUrl.trim() !== ''
    ? value.baseUrl.trim().replace(/\/+$/u, '')
    : 'https://api.openai.com/v1'
  const model = typeof value.model === 'string' && value.model.trim() !== '' ? value.model.trim() : 'gpt-image-1'
  const editModel = typeof value.editModel === 'string' && value.editModel.trim() !== '' ? value.editModel.trim() : model
  return {
    baseUrl,
    model,
    editModel,
    size: typeof value.size === 'string' && value.size.trim() !== '' ? value.size.trim() : '1024x1024',
    saveToWorkspace: value.saveToWorkspace !== false,
    outputDir: typeof value.outputDir === 'string' && value.outputDir.trim() !== '' ? value.outputDir.trim() : 'generated-images',
    timeoutMs: Number.isFinite(value.timeoutMs) && value.timeoutMs > 0 ? value.timeoutMs : 180000,
  }
}

/**
 * 取本次调用可用的 API Key。
 *
 * 首选 credentials 服务（Web 设置页写的就是它），其次环境变量。逐次解析、不缓存，
 * 这样用户在设置页改完 Key 之后无需重启即可生效。
 */
async function resolveApiKey(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(API_KEY_REF)
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') return resolved.value
    } catch {
      /* 回退到环境变量 */
    }
  }
  const ambient = process.env[API_KEY_REF]
  return typeof ambient === 'string' ? ambient.trim() : ''
}

function asciiAt(bytes, offset, text) {
  if (bytes.length < offset + text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

/** 以魔数判定图片类型；判定不出时由调用方回退。 */
function sniffMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp'
  if (bytes.length >= 6 && (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a'))) return 'image/gif'
  return undefined
}

function authHeaders(apiKey) {
  return apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }
}

async function readJsonResponse(response) {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`图片接口返回 ${response.status} ${response.statusText}：${truncate(text) || '(空响应)'}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`图片接口返回的不是 JSON：${truncate(text) || '(空响应)'}`)
  }
}

/** 把接口回包里的一项转成字节；支持 `b64_json` 与 `url` 两种返回形态。 */
async function bytesOfItem(item, signal) {
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    return new Uint8Array(Buffer.from(item.b64_json, 'base64'))
  }
  if (typeof item.url === 'string' && item.url.length > 0) {
    const response = await fetchResilient(item.url, {}, signal)
    if (!response.ok) throw new Error(`下载生成的图片失败：${response.status} ${response.statusText}`)
    return new Uint8Array(await response.arrayBuffer())
  }
  return undefined
}

async function collectImages(payload, signal) {
  const data = Array.isArray(payload?.data) ? payload.data : undefined
  if (data === undefined) {
    throw new Error(`图片接口返回里没有 data 数组：${truncate(JSON.stringify(payload ?? null))}`)
  }
  const out = []
  for (const item of data) {
    if (item === null || typeof item !== 'object') continue
    const bytes = await bytesOfItem(item, signal)
    if (bytes === undefined || bytes.length === 0) continue
    const mediaType = sniffMediaType(bytes) ?? 'image/png'
    out.push({
      bytes,
      mediaType,
      ...(typeof item.revised_prompt === 'string' && item.revised_prompt !== '' ? { revisedPrompt: item.revised_prompt } : {}),
    })
  }
  if (out.length === 0) throw new Error('图片接口没有返回任何可用的图片数据')
  return out
}

/** 生成的文件名：时间戳 + 提示词片段，便于用户在工作区里认出来。 */
function fileNameFor(prompt, mediaType, index, total) {
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '').replace('T', '-')
  const slug = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  const suffix = total > 1 ? `-${index + 1}` : ''
  return `image-${stamp}${suffix}${slug === '' ? '' : `-${slug}`}.${EXTENSIONS[mediaType] ?? 'png'}`
}

/** 把字节写进会话工作区；目录逃出工作区时拒绝，绝不越界写文件。 */
async function writeWorkspaceCopy(cwd, outputDir, fileName, bytes) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const root = resolve(cwd)
  const dir = isAbsolute(outputDir) ? resolve(outputDir) : resolve(root, outputDir)
  const rel = relative(root, dir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`outputDir 必须位于会话工作区内，当前配置解析为工作区之外：${outputDir}`)
  }
  await mkdir(dir, { recursive: true })
  const target = join(dir, fileName)
  await writeFile(target, bytes)
  return target
}

/**
 * 当前调用路由是否声明了图片输入能力。
 * 与内置 `read_image` 的判定同源：请求头里的路由优先，其次 Agent 选项。
 */
async function routeSupportsImage(ctx, exec) {
  const llm = ctx.get('llm')
  if (llm === undefined) return false
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  if (provider === undefined || model === undefined) return false
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

/** 面向模型的文本信封；图片本身走相邻的 image 块或工作区文件。 */
function envelopeOf(value) {
  const lines = [`<generated_images model="${value.model}" count="${value.images.length}">`]
  value.images.forEach((image, index) => {
    lines.push(`  <image index="${index + 1}" type="${image.mediaType}" size="${image.width}x${image.height}" bytes="${image.bytes}" />`)
  })
  for (const file of value.savedPaths ?? []) lines.push(`  <file>${file}</file>`)
  lines.push(value.imageCapable
    ? '  <note>图片已随本次结果附带，可直接查看。</note>'
    : '  <note>当前模型不支持图片输入，图片未随结果下发；请把上面的文件路径交给用户，或用支持视觉的模型读取该文件。</note>')
  for (const warning of value.warnings ?? []) lines.push(`  <warning>${warning}</warning>`)
  lines.push('</generated_images>')
  return lines.join('\n')
}

/**
 * 展开 fetch 的失败原因。
 *
 * undici 对网络层失败只抛一句 `fetch failed`，真正的原因（DNS、TLS、连接被拒、
 * 代理、超时…）藏在 `error.cause` 链里。不展开的话，用户和排查者都只能看到一个
 * 无从下手的错误。
 */
function describeFetchFailure(error, url) {
  const parts = []
  let current = error
  while (current !== undefined && current !== null && parts.length < 5) {
    const name = current.name === undefined ? 'Error' : String(current.name)
    const message = current.message === undefined ? String(current) : String(current.message)
    const code = current.code === undefined ? '' : ` [${current.code}]`
    const detail = `${name}: ${message}${code}`
    if (!parts.includes(detail)) parts.push(detail)
    current = current.cause
  }
  return `请求 ${url} 失败：${parts.join('  ←  ')}`
}

/** 带根因展开的 fetch 包装。 */
async function fetchOrExplain(url, init) {
  try {
    return await fetch(url, init)
  } catch (error) {
    throw new Error(describeFetchFailure(error, url))
  }
}

/** 把执行信号的状态描述成一行文字。 */
function describeSignal(signal) {
  if (signal === undefined || signal === null) return '未提供'
  if (signal.aborted !== true) return '未中止'
  const reason = signal.reason
  return `已中止(${reason === undefined ? '无原因' : String(reason?.message ?? reason)})`
}

/**
 * 带诊断与一次兜底重试的 fetch。
 *
 * 诊断：undici 对发送前的失败也只抛 `fetch failed`，把信号状态和原因链一起报出来，
 * 才能区分"信号已中止导致根本没发包"和"连接层失败"。
 *
 * 兜底：**仅在调用方没有要求中止时**（信号未中止）去掉信号重试一次——此时放弃信号
 * 不违背取消语义，因为没有任何人要求停止。若信号已中止则直接报错，绝不继续发请求。
 */
async function fetchResilient(url, init, signal) {
  try {
    return await fetch(url, init)
  } catch (error) {
    const first = describeFetchFailure(error, url)
    const state = describeSignal(signal)
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      throw new Error(`${first}（exec.signal ${state}）`)
    }
    const retryInit = { ...init }
    delete retryInit.signal
    try {
      return await fetch(url, retryInit)
    } catch (retryError) {
      throw new Error(`${first}（exec.signal ${state}）；去掉信号重试仍失败：${describeFetchFailure(retryError, url)}`)
    }
  }
}

/** 统一的对外请求：生图走 JSON，改图走 multipart。 */
async function requestImages({ config, apiKey, kind, prompt, size, model, n, file, signal }) {
  if (apiKey === '') {
    throw new Error(`尚未配置生图接口密钥：请在「设置 → 生图桥」里填入 API Key，或设置环境变量 ${API_KEY_REF}。`)
  }
  const url = `${config.baseUrl}/images/${kind === 'edit' ? 'edits' : 'generations'}`
  let payload
  if (kind === 'edit') {
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt)
    if (size !== undefined && size !== '') form.append('size', size)
    form.append('image', new Blob([file.bytes], { type: file.mediaType }), file.name)
    const response = await fetchResilient(url, { method: 'POST', headers: authHeaders(apiKey), body: form }, signal)
    payload = await readJsonResponse(response)
  } else {
    const body = { model, prompt }
    if (size !== undefined && size !== '') body.size = size
    if (Number.isFinite(n) && n > 1) body.n = n
    const response = await fetchResilient(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify(body),
    }, signal)
    payload = await readJsonResponse(response)
  }
  return await collectImages(payload, signal)
}

/**
 * 落实一次生图结果：存附件、写工作区文件、组装工具值。
 * @returns 输出 Schema 声明的规范值。
 */
async function settleImages(args) {
  const { ctx, exec, config, prompt, size, model, images } = args
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('没有挂载附件服务，无法保存生成的图片')

  const values = []
  const savedPaths = []
  const warnings = []
  const revisedPrompts = []
  const cwd = exec.agent?.session?.header?.cwd

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]
    const fileName = fileNameFor(prompt, image.mediaType, index, images.length)
    if (image.revisedPrompt !== undefined) revisedPrompts.push(image.revisedPrompt)

    let ref
    try {
      ref = await attachments.saveImage({ data: image.bytes, mediaType: image.mediaType, name: fileName })
    } catch (error) {
      throw new Error(`保存生成的图片失败：${error instanceof Error ? error.message : String(error)}`)
    }
    values.push({
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    })

    if (config.saveToWorkspace) {
      try {
        const path = await writeWorkspaceCopy(cwd, config.outputDir, fileName, image.bytes)
        if (path !== undefined) savedPaths.push(path)
        else warnings.push('本次调用没有会话工作区，图片只保存在附件库里。')
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error))
      }
    }
  }

  const imageCapable = await routeSupportsImage(ctx, exec)
  return {
    images: values,
    model,
    prompt,
    ...(size === undefined || size === '' ? {} : { size }),
    ...(revisedPrompts.length === 0 ? {} : { revisedPrompts }),
    ...(savedPaths.length === 0 ? {} : { savedPaths }),
    imageCapable,
    ...(warnings.length === 0 ? {} : { warnings: [...new Set(warnings)] }),
  }
}

/** 两个工具共用的输出声明：模型面按视觉能力分叉，界面面恒久化图片引用。 */
const OUTPUT = {
  schema: OUTPUT_SCHEMA,
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: envelopeOf(value) }]
    if (value.imageCapable === true) {
      for (const image of value.images) {
        blocks.push({
          type: 'image',
          attachment: {
            attachmentId: image.attachmentId,
            mediaType: image.mediaType,
            bytes: image.bytes,
            width: image.width,
            height: image.height,
            ...(image.name === undefined ? {} : { name: image.name }),
          },
        })
      }
    }
    return blocks
  },
  presentationMeta: (_args, value) => ({
    model: value.model,
    prompt: value.prompt,
    images: value.images,
    ...(value.savedPaths === undefined ? {} : { savedPaths: value.savedPaths }),
    imageCapable: value.imageCapable,
  }),
}

/**
 * 探测接口可达性与密钥有效性。
 *
 * 用 `GET {baseUrl}/models` 做轻量探针：它不产生生图费用，OpenAI 兼容服务普遍提供。
 * 404 只当作「不提供该列表」的软提示，401/403 才是密钥问题。
 */
async function probeConnection({ baseUrl, apiKey, signal }) {
  if (apiKey === '') return { ok: false, message: `尚未保存 API Key。请在上方填入后点击「保存」，或设置环境变量 ${API_KEY_REF}。` }
  const url = `${baseUrl.replace(/\/+$/u, '')}/models`
  try {
    const response = await fetch(url, { method: 'GET', headers: authHeaders(apiKey), signal })
    const text = await response.text()
    if (response.ok) return { ok: true, message: `连接成功：GET ${url} → ${response.status}` }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `密钥被拒绝（HTTP ${response.status}）：${truncate(text, 200)}` }
    }
    if (response.status === 404) return { ok: true, message: `接口可达：GET ${url} → 404，该服务可能不提供模型列表，这不影响生图。` }
    return { ok: false, message: `接口返回 HTTP ${response.status}：${truncate(text, 200)}` }
  } catch (error) {
    return { ok: false, message: `无法连接 ${url}：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 解析失败时的降级自诊断。
 *
 * 正常情况下这一步不会发生。真发生时，插件仍然可用（工具有效，只是没有配置表单，
 * 因为 Config 需要 schemastery），但失败原因是环境相关的、光看日志很难定位，
 * 所以把环境事实与每条解析尝试写到用户目录下的一个小文件里，便于一步定位。
 */
async function reportDegradedStart(ctx, failure) {
  const detail = {
    at: new Date().toISOString(),
    plugin: 'dsh-image-bridge',
    problem: '未能解析 @deepseek-ai/schemastery，因此没有导出 Config，设置页的配置表单不会出现。',
    impact: 'image_generate / image_edit 仍可用；配置只能通过 profile 的 cordis.patch.yml 与 DSH_IMAGE_BRIDGE_API_KEY 提供。',
    environment: {
      argv: process.argv,
      execPath: process.execPath,
      cwd: process.cwd(),
      DSH_PROFILE: process.env.DSH_PROFILE ?? null,
      DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR ?? null,
      DSH_HOME: process.env.DSH_HOME ?? null,
    },
    resolveBases: RESOLVE_BASES,
    attempts: failure === undefined ? [] : failure.attempts,
  }
  const bases = [
    process.env.DSH_HOME === undefined ? undefined : process.env.DSH_HOME,
    join(homedir(), '.dsh'),
  ].filter((base) => typeof base === 'string' && base !== '')
  for (const base of bases) {
    try {
      await mkdir(base, { recursive: true })
      const file = join(base, 'dsh-image-bridge-degraded.json')
      await writeFile(file, `${JSON.stringify(detail, null, 2)}\n`)
      ctx.logger?.warn?.(`dsh-image-bridge: 未能加载 @deepseek-ai/schemastery，配置表单不可用；诊断已写入 %s`, file)
      return
    } catch {
      /* 换下一个可写位置 */
    }
  }
  ctx.logger?.warn?.('dsh-image-bridge: 未能加载 @deepseek-ai/schemastery，且没有可写的诊断位置。')
}

export function apply(ctx, config) {
  const resolved = normalizedConfig(config)
  const steps = []
  const note = (step) => steps.push(step)
  const finish = (extra) => writeStartupReport({
    steps,
    services: {
      tools: ctx.get('tools') !== undefined,
      attachments: ctx.get('attachments') !== undefined,
      fs: ctx.get('fs') !== undefined,
      credentials: ctx.get('credentials') !== undefined,
      llm: ctx.get('llm') !== undefined,
      webServer: ctx.get('webServer') !== undefined,
      connection: ctx.get('connection') !== undefined,
    },
    config: resolved,
    ...extra,
  })

  if (z === undefined) {
    note('schemastery 未解析，配置表单不可用')
    void reportDegradedStart(ctx, LAST_RESOLUTION_FAILURE)
  } else {
    note('Config schema 就绪')
  }

  /*
   * 工具直接注册在插件自己的 ctx 上，**不**放进 `ctx.inject(['attachments'], …)` 回调里：
   * 注册本身不需要附件服务，只有执行时才需要（settleImages 会自行检查并给出明确错误）。
   * 否则一旦那个回调没有触发，就会静默地一个工具都注册不上——这类失败极难察觉。
   */
  try {
    if (ctx.get('tools') === undefined) throw new Error('tools 服务未挂载，无法注册工具')
    ctx.tools.register(defineTool({
      name: 'image_generate',
      description: '用外部生图模型按提示词生成图片，并把结果保存为可查看的图片。当用户要求画图、生成插画/图标/海报，或需要任何图像产物时使用；本工具不依赖当前模型自身的绘图能力。',
      parameters: {
        prompt: { type: 'string', required: true, description: '图片内容的描述，越具体越好（主体、风格、构图、光线、文字等）。' },
        size: { type: 'string', description: `图片尺寸，例如 1024x1024、1024x1536、1536x1024。默认 ${resolved.size}。` },
        model: { type: 'string', description: `覆盖默认生图模型（当前默认 ${resolved.model}）。` },
      },
      output: OUTPUT,
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt === '') throw new Error('prompt 不能为空')
        const size = typeof args.size === 'string' && args.size.trim() !== '' ? args.size.trim() : resolved.size
        const model = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : resolved.model
        const apiKey = await resolveApiKey(ctx)
        const images = await requestImages({ config: resolved, apiKey, kind: 'generate', prompt, size, model, n: 1, signal: exec.signal })
        return await settleImages({ ctx, exec, config: resolved, prompt, size, model, images })
      },
    }))

    ctx.tools.register(defineTool({
      name: 'image_edit',
      description: '用外部生图模型按提示词修改一张已有图片（局部重绘、换风格、增删元素等）。图片来自会话工作区里的文件路径。',
      parameters: {
        prompt: { type: 'string', required: true, description: '要如何修改这张图，例如「把背景换成夜晚的街道」。' },
        image_path: { type: 'string', required: true, description: '待修改图片的路径，由文件系统后端解析。' },
        size: { type: 'string', description: `输出尺寸，默认沿用原图或配置里的 ${resolved.size}。` },
        model: { type: 'string', description: `覆盖默认改图模型（当前默认 ${resolved.editModel}）。` },
      },
      output: OUTPUT,
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt === '') throw new Error('prompt 不能为空')
        const imagePath = typeof args.image_path === 'string' ? args.image_path.trim() : ''
        if (imagePath === '') throw new Error('image_path 不能为空')
        const fs = ctx.get('fs')
        if (fs === undefined) throw new Error('没有挂载文件系统服务，无法读取待修改的图片')
        const cwd = exec.agent?.session?.header?.cwd
        const target = await fs.resolve(imagePath, cwd === undefined ? {} : { cwd })
        const info = await fs.stat(target, exec.signal)
        if (info === undefined) throw new Error(`找不到待修改的图片：${imagePath}`)
        const bytes = await fs.readBytes(target, exec.signal, 20 * 1024 * 1024)
        const mediaType = sniffMediaType(bytes)
        if (mediaType === undefined) throw new Error(`不是受支持的图片格式（PNG/JPEG/WebP/GIF）：${imagePath}`)
        const size = typeof args.size === 'string' && args.size.trim() !== '' ? args.size.trim() : resolved.size
        const model = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : resolved.editModel
        const name = imagePath.split(/[\\/]/u).pop() ?? 'source.png'
        const apiKey = await resolveApiKey(ctx)
        const images = await requestImages({ config: resolved, apiKey, kind: 'edit', prompt, size, model, file: { bytes, mediaType, name }, signal: exec.signal })
        return await settleImages({ ctx, exec, config: resolved, prompt, size, model, images })
      },
    }))
    note('两个工具已注册')
  } catch (error) {
    note(`工具注册失败：${error instanceof Error ? error.message : String(error)}`)
    void finish({ error: error instanceof Error ? error.stack : String(error) })
    throw error
  }

  registerTestRoute(ctx, resolved)
  note('测试通道已挂载')
  void finish({})
}

/**
 * 启动自述。
 *
 * `apply` 是否跑完、依赖服务是否就位、工具注册到哪一步——这些在 Host 侧没有日志可看，
 * 但一旦出错就是「插件装了却什么也没发生」。每次激活都覆写这份报告，便于直接定位。
 */
async function writeStartupReport(detail) {
  const report = { at: new Date().toISOString(), plugin: '@local/dsh-image-bridge', ...detail }
  const bases = [
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : undefined,
    join(homedir(), '.dsh'),
  ].filter((base) => typeof base === 'string' && base !== '')
  for (const base of bases) {
    try {
      await mkdir(base, { recursive: true })
      await writeFile(join(base, 'dsh-image-bridge-startup.json'), `${JSON.stringify(report, null, 2)}\n`)
      return
    } catch {
      /* 换下一个可写位置 */
    }
  }
}

/**
 * 浏览器侧诊断的落盘位置。
 *
 * 客户端半跑在浏览器里，它在加载或渲染期出的问题，Host 侧没有任何观测手段——
 * 只能由客户端主动回报。写在用户目录下，便于直接查看。
 */
function clientLogPath() {
  const base = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(base, 'dsh-image-bridge-client.log')
}

/** 追加一条客户端诊断；字段都做了长度上限，避免日志被灌爆。 */
async function appendClientLog(payload) {
  const level = typeof payload.level === 'string' ? payload.level.slice(0, 32) : 'info'
  const message = typeof payload.message === 'string' ? payload.message.slice(0, 2000) : ''
  const detail = typeof payload.detail === 'string' ? payload.detail.slice(0, 8000) : ''
  const path = clientLogPath()
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${new Date().toISOString()}\t${level}\t${message}\t${detail.replace(/\s+/gu, ' ')}\n`)
  return { written: true, path }
}

/** 设置页的测试通道：与 `/api` 走同一道来源与会话栅栏。 */
function registerTestRoute(ctx, resolved) {
  ctx.inject(['connection', 'webServer'], (routeCtx) => {
    const connection = routeCtx.get('connection')
    const webServer = routeCtx.get('webServer')
    if (connection === undefined || webServer === undefined) return
    routeCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: RPC_CHANNEL,
      handler: async (request, response) => {
        const rejection = connection.requestRejection(request)
        if (rejection !== undefined) {
          response.writeHead(rejection)
          response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(404)
          response.end('not found')
          return
        }
        const pathname = String(request.url ?? '').split('?')[0] ?? ''
        const endpoint = pathname === `${RPC_CHANNEL}/test`
          ? 'test'
          : pathname === `${RPC_CHANNEL}/log`
            ? 'log'
            : undefined
        if (endpoint === undefined) {
          response.writeHead(404)
          response.end('not found')
          return
        }
        const mediaType = String(request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
        if (mediaType !== 'application/json') {
          response.writeHead(415)
          response.end('content type must be application/json')
          return
        }
        let body
        try {
          body = await readJsonBody(request)
        } catch {
          response.writeHead(400)
          response.end('body is not JSON')
          return
        }
        const message = parseEnvelope(body)
        if (message === undefined || message.method !== endpoint) {
          response.writeHead(400)
          response.end('invalid client-request message')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        try {
          const payload = message.payload !== null && typeof message.payload === 'object' ? message.payload : {}
          if (endpoint === 'log') {
            // 浏览器侧的问题在 Host 这里没有别的观测手段，落成文件才能定位。
            const written = await appendClientLog(payload)
            response.end(envelopeOf2(message.rpcId, { ok: true, value: written }))
            return
          }
          const baseUrl = typeof payload.baseUrl === 'string' && payload.baseUrl.trim() !== '' ? payload.baseUrl.trim() : resolved.baseUrl
          const apiKey = typeof payload.apiKey === 'string' && payload.apiKey !== '' ? payload.apiKey : await resolveApiKey(ctx)
          response.end(envelopeOf2(message.rpcId, { ok: true, value: await probeConnection({ baseUrl, apiKey, signal: undefined }) }))
        } catch (error) {
          response.end(envelopeOf2(message.rpcId, {
            ok: false,
            error: { code: endpoint === 'log' ? 'log-failed' : 'probe-failed', message: error instanceof Error ? error.message : String(error), details: {} },
          }))
        }
      },
    }), 'image-bridge: test route')
  })
}

/** 只接受本通道认识的信封字段，其余一律当作非法请求。 */
function parseEnvelope(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.type !== 'client-request') return undefined
  if (typeof value.rpcId !== 'string' || value.rpcId.length === 0) return undefined
  if (typeof value.method !== 'string' || value.method.length === 0) return undefined
  return { rpcId: value.rpcId, method: value.method, payload: value.payload }
}

/** 客户端只解析这一种响应体。 */
function envelopeOf2(rpcId, result) {
  return JSON.stringify({ type: 'server-response', rpcId, result })
}

/** 读取一个 JSON 请求体，超过 64 KiB 直接拒绝。 */
function readJsonBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    const decoder = new TextDecoder()
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 64 * 1024) {
        rejectPromise(new Error('body too large'))
        return
      }
      chunks.push(decoder.decode(chunk, { stream: true }))
    })
    request.on('end', () => {
      try {
        chunks.push(decoder.decode())
        resolvePromise(JSON.parse(chunks.join('')))
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error('body is not JSON'))
      }
    })
    request.on('error', (error) => rejectPromise(error instanceof Error ? error : new Error('request stream failed')))
  })
}
