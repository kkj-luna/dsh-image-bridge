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
import diagnostics from 'node:diagnostics_channel'
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

export const name = '@local/dsh-image-bridge'

/** 工具注册表是唯一的硬依赖；其余服务在 apply 内按需注入。 */
export const inject = ['tools']

/**
 * 一条模型路由的 schema：模型可以选**任何**已配置服务商下的，所以必须带 providerId——
 * 地址与凭据都取自那家服务商，不是当前生效的那家。
 */
const routeEndpointSchema = () => z.object({
  providerId: z.string().default('').description('服务商 id；留空表示这一档没配。'),
  model: z.string().default('').description('该服务商下的模型名。'),
})

/**
 * 可公开的接口配置。
 *
 * 每个字段都标了 `volatile()`：settings 服务只允许在线改写 volatile 字段
 * （非 volatile 会在写入时被 `Config field "x" is not volatile` 拒绝）。
 * 写作命名空间就是本插件行的 id —— `image-bridge`。
 *
 * 多服务商是叠加在旧字段之上的一层：`providers` 非空时接口地址/模型/密钥都按
 * 「当前生效的服务商」走（`activeProviderId` 命中优先，没命中就取列表第一个）；
 * 只有 `providers` 为空时才整体回退到 baseUrl/model/editModel，
 * 因此老的（单服务商）配置不改也能继续用。
 *
 * `modelRoutes` 再往上一层：为生图/修图各指定主用与备用模型（可跨服务商），
 * 主用失败或迟迟拿不到响应头时自动改用备用。
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
  providers: z
    .array(z.object({
      id: z.string().default('').description('服务商标识；同时用来推导凭据名 DSH_IMAGE_BRIDGE_KEY_<ID>。'),
      label: z.string().default('').description('设置页里显示的名字；留空时用 id。'),
      baseUrl: z.string().default('').description('该服务商的接口基础地址（OpenAI 兼容）。'),
      keyRef: z.string().default('').description('该服务商的凭据名；留空时按 id 推导。'),
      models: z.array(z.string()).default([]).description('该服务商的模型列表（设置页拉取后写入）。'),
      imageModel: z.string().default('').description('该服务商的生图模型名。'),
      editModel: z.string().default('').description('该服务商的改图模型名；留空时沿用生图模型。'),
    }))
    .default([])
    .volatile()
    .description('多个生图服务商；非空时以 activeProviderId 选中的那一项为准。'),
  activeProviderId: z.string().default('').volatile().description('当前生效的服务商 id；为空或找不到时回退到上面的 baseUrl/model。'),
  modelRoutes: z
    .object({
      generate: z.object({ primary: routeEndpointSchema().default({}), fallback: routeEndpointSchema().default({}) }).default({}),
      edit: z.object({ primary: routeEndpointSchema().default({}), fallback: routeEndpointSchema().default({}) }).default({}),
    })
    .default({})
    .volatile()
    .description('生图/修图的模型路由：每项 { providerId, model }，可跨服务商选择；fallback 是主用失败或超时后的备用模型。'),
  fallbackAfterMs: z.number().default(90000).volatile().description('主模型「请求发出后」多久没拿到响应头就改用备用模型（毫秒）。连接耗时不计入这个预算；整次调用的上限仍是 timeoutMs。同步生图接口常常要几十秒，这个值别设太小。'),
})

/** API Key 在 credentials 服务里的引用名（同时作为环境变量回退名）。 */
const API_KEY_REF = 'DSH_IMAGE_BRIDGE_API_KEY'

/** 多服务商模式下每个服务商各自的凭据名前缀：`DSH_IMAGE_BRIDGE_KEY_<ID>`。 */
const PROVIDER_KEY_PREFIX = 'DSH_IMAGE_BRIDGE_KEY_'

/** 凭据服务接受的 ref 形状；推导出来的名字必须落在它里面，否则凭据服务会拒绝。 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 拉取模型列表的超时毫秒数；列表接口只是给设置页选模型用，不能久等。 */
const MODELS_TIMEOUT_MS = 15000

/**
 * 主模型"请求发出后多久还没拿到响应头就换备用"的默认预算。
 *
 * 为什么是 90000 而不是更小：同步生图接口憋几十秒是常态（实测跨境到阿里云 MaaS 的
 * qwen-image-3.0 用了 42–61 秒才回响应头），15 秒级的预算会让正常的慢生成被误判成失败、
 * 白白切到备用。这里的语义是"值不值得再等"，不是"服务商坏了"——真正的总上限由 timeoutMs 管。
 * 设置页可改写（留空或不合法即用这个默认值）。
 */
const DEFAULT_FALLBACK_AFTER_MS = 90000

/** 超时后那次探活的超时：健康检查必须快，慢的探活本身没有诊断价值。 */
const PROVIDER_PROBE_TIMEOUT_MS = 4000

/** 连接阶段的宽限：只为防止"一直连不上"拖到 timeoutMs 上限，不参与响应头预算。 */
const CONNECT_GRACE_MS = 10000

/** 设置页「测试连接」用的环回 RPC 通道。 */
const RPC_CHANNEL = '/dsh-image-bridge'

/** 通道上可用的方法名；拼在通道前缀后面就是端点路径。 */
const RPC_ENDPOINTS = ['test', 'log', 'models']

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

/**
 * 本插件在 profile 里的行 id —— 同时就是设置命名空间。
 * 客户端 `client.js` 的 `SETTINGS_NS` 必须与它一致。
 */
const SETTINGS_NS = 'image-bridge-v4'

/** 解出本插件的行 id 候选（fiber 上取到的 + 常量，去重）。 */
function settingsNamespaceCandidates(ctx) {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)
  }
  try { push(ctx?.fiber?.entry?.options?.id) } catch { /* 忽略 */ }
  try { push(ctx?.fiber?.entry?.id) } catch { /* 忽略 */ }
  push(SETTINGS_NS)
  return out
}

/**
 * 取当前生效的配置，并报告它来自哪里。
 *
 * 配置字段全部标了 `volatile`。按 `dsh-settings` 的定义，这类字段是
 * "editable without remounting"——改**不会**重新挂载插件（`applies: 'live'`），
 * 也就是说挂载期拿到的 `config` 里未必有它们，用户保存的值只存在于设置服务。
 * 所以每次调用都重新问一次设置服务，按优先级取第一个真正带值的来源：
 *
 *   ① 设置服务里本行（按行 id 候选匹配）的 `value`；
 *   ② `ctx.fiber.config`（若上下文里的 fiber 正好是本插件的）；
 *   ③ 挂载期传入的 `config`（保底，通常只剩 Schema 默认值）。
 * ①②都落空时再做一次兜底扫描：取任意一行里带非空 baseUrl 的，并记下它的 ns，
 * 便于事后判断到底是哪一行在真正生效。
 */
function effectiveConfigOf(ctx, applyConfig) {
  const candidates = settingsNamespaceCandidates(ctx)
  try {
    const service = ctx?.get?.('settings')
    if (service !== undefined && service !== null && typeof service.describe === 'function') {
      const described = service.describe()
      /*
       * 两种形状都要认：
       *   · 设置服务直接把行数组交出来（SettingsForms.describe 的原样返回）；
       *   · 远程命名空间信封 { writable, namespaces: [{ ns, value }] }——客户端读到的就是这个，
       *     一开始只认数组，于是明明数据在、工具却读不到，回退成了 Schema 默认值。
       */
      const rows = Array.isArray(described)
        ? described
        : (described !== null && typeof described === 'object' && Array.isArray(described.namespaces) ? described.namespaces : [])
      const valueOf = (row) => (row.value ?? row.values ?? row.config ?? null)
      /*
       * 「可用」的判定：这一行至少填了接口地址，或者带了服务商列表。
       * 多服务商配置里 baseUrl 可能整片留空，只认 baseUrl 会把整行判成不可用，
       * 于是工具悄悄退回 Schema 默认值（默认 OpenAI 地址 + 没有密钥）。
       */
      const usable = rows.filter((item) => {
        const value = item !== null && typeof item === 'object' ? plainValueOf(valueOf(item)) : null
        if (value === null || typeof value !== 'object') return false
        if (nonEmptyString(value.baseUrl) !== '') return true
        const providers = plainValueOf(value.providers)
        return Array.isArray(providers) && providers.length > 0
      })
      for (const ns of candidates) {
        const row = usable.find((item) => item.ns === ns)
        if (row !== undefined) return { config: normalizedConfig(valueOf(row)), source: `settings:${row.ns}` }
      }
      if (usable.length > 0) return { config: normalizedConfig(valueOf(usable[0])), source: `settings(扫描):${usable[0].ns}` }
    }
  } catch {
    /* 设置服务不可用 */
  }
  try {
    const live = ctx?.fiber?.config
    if (live !== null && typeof live === 'object') {
      const providers = plainValueOf(live.providers)
      const hasProviders = Array.isArray(providers) && providers.length > 0
      if (nonEmptyString(live.baseUrl) !== '' || hasProviders) {
        return { config: normalizedConfig(live), source: 'fiber' }
      }
    }
  } catch {
    /* fiber 可能不可访问 */
  }
  const apply = applyConfig !== null && typeof applyConfig === 'object' ? applyConfig : {}
  const applyProviders = plainValueOf(apply.providers)
  if (nonEmptyString(apply.baseUrl) !== '' || (Array.isArray(applyProviders) && applyProviders.length > 0)) {
    return { config: normalizedConfig(apply), source: 'apply' }
  }
  return { config: normalizedConfig(apply), source: `apply(默认值) ns=${candidates.join('/')}` }
}

/** 解出本插件的行 id（优先取自 fiber，取不到则用常量）。 */
function settingsNamespaceOf(ctx) {
  try {
    const id = ctx?.fiber?.entry?.options?.id
    if (typeof id === 'string' && id !== '') return id
  } catch {
    /* 取不到就用常量 */
  }
  return SETTINGS_NS
}


/**
 * 取一个配置字段的原始值。
 *
 * volatile 字段在「已解析的配置」里不是普通值，而是 cosmokit 的冻结引用
 * （`{ get(), [Symbol.for('cosmokit.volatile.write')] }`）——直接读会拿到对象而不是
 * 字符串/数组。设置服务交出来的已经是普通值，这里统一兜一层，两种来源都能用。
 */
function plainValueOf(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return value
    }
  }
  return value
}

/** 取一个非空字符串字段（去两端空白）；不是非空字符串时给回退值。 */
function nonEmptyString(value, fallback = '') {
  const raw = plainValueOf(value)
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback
}

/**
 * 服务商的凭据名：`DSH_IMAGE_BRIDGE_KEY_<ID>`。
 *
 * ID 是 provider.id 转大写、非 [A-Za-z0-9] 的字符一律换成下划线，因此推导结果必然
 * 匹配 /^[A-Za-z_][A-Za-z0-9_]*$/，凭据服务不会因为名字形状拒绝它。
 */
function providerKeyRef(id) {
  const normalized = nonEmptyString(id).toUpperCase().replace(/[^A-Za-z0-9]/gu, '_')
  return `${PROVIDER_KEY_PREFIX}${normalized}`
}

/**
 * 一个服务商实际使用的凭据名：显式且合法的 keyRef 优先，否则按**归一后的 id** 推导。
 *
 * 刻意收 id 与 declared 两个参数而不是整个 provider 对象：归一（slugify）必须发生在
 * 推导之前，直接传原始记录会让"要不要先归一"变成一个到处都要记得的口头约定——
 * F-2 那个两侧凭据名不一致的缺陷就是这么来的。形状不合法的 keyRef 一律忽略。
 */
function providerCredentialRef(id, declared) {
  const explicit = nonEmptyString(declared)
  return explicit !== '' && CREDENTIAL_REF_PATTERN.test(explicit) ? explicit : providerKeyRef(id)
}

/**
 * provider.id 的归一：**与客户端 `client.js` 的 `slugify` 同一套规则**
 * （小写、非 [a-z0-9] 折叠成 '-'、去掉首尾 '-'、截断 40 字符）。
 *
 * id 是凭据名的派生基准，两侧必须逐字一致：手改 profile 塞进来的 `id: 'zh-智谱'`
 * 若 Host 不归一，它就会去 `DSH_IMAGE_BRIDGE_KEY_ZH___` 取密钥，而设置页按
 * `DSH_IMAGE_BRIDGE_KEY_ZH` 判断"密钥未配置"——用户照界面提示存了密钥，工具仍报缺密钥。
 */
function slugifyId(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
}

/** 接口地址里的主机名，作为 id 的兜底来源（与客户端 `hostSlugOf` 同规则）。 */
function hostSlugOf(baseUrl) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/iu.exec(String(baseUrl === null || baseUrl === undefined ? '' : baseUrl))
  if (match === null) return ''
  return slugifyId(match[1].replace(/^[^@]*@/u, '').replace(/:[0-9]+$/u, ''))
}

/** 列表内唯一的 id：重复时追加 -2、-3…（与客户端 `uniqueId` 同规则；id 撞了就会串密钥）。 */
function uniqueId(seed, taken) {
  const base = seed === '' ? 'provider' : seed
  if (!taken.includes(base)) return base
  let index = 2
  while (taken.includes(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

/**
 * 一个服务商条目的规范化；字段可能来自设置服务（普通 JSON），也可能来自手改的 profile。
 *
 * id 的派生顺序与客户端 `normalizeProvider` 完全一致：slug(id) → slug(label) → 地址主机名，
 * 撞名时追加 -2/-3…（所以必须按列表顺序共用一个 `taken`）。显式且合法的 keyRef 仍然最优先，
 * 否则按归一后的 id 推导。
 */
function normalizeProvider(raw, taken = []) {
  const unwrapped = plainValueOf(raw)
  const value = unwrapped !== null && typeof unwrapped === 'object' && !Array.isArray(unwrapped) ? unwrapped : {}
  const label = nonEmptyString(value.label)
  const baseUrl = nonEmptyString(value.baseUrl).replace(/\/+$/u, '')
  const declaredId = slugifyId(nonEmptyString(value.id))
  const seed = declaredId !== '' ? declaredId : slugifyId(label) !== '' ? slugifyId(label) : hostSlugOf(baseUrl)
  const id = uniqueId(seed, taken)
  taken.push(id)
  const models = plainValueOf(value.models)
  return {
    id,
    label: label === '' ? id : label,
    baseUrl,
    keyRef: providerCredentialRef(id, value.keyRef),
    models: Array.isArray(models) ? models.map((item) => nonEmptyString(item)).filter((item) => item !== '') : [],
    imageModel: nonEmptyString(value.imageModel),
    editModel: nonEmptyString(value.editModel),
  }
}

function normalizedConfig(config) {
  const unwrapped = plainValueOf(config)
  const value = unwrapped !== null && typeof unwrapped === 'object' && !Array.isArray(unwrapped) ? unwrapped : {}
  const baseUrl = nonEmptyString(value.baseUrl).replace(/\/+$/u, '')
  const model = nonEmptyString(value.model, 'gpt-image-1')
  const editModel = nonEmptyString(value.editModel, model)
  const providers = plainValueOf(value.providers)
  const taken = []
  const timeoutMs = plainValueOf(value.timeoutMs)
  return {
    baseUrl: baseUrl === '' ? 'https://api.openai.com/v1' : baseUrl,
    model,
    editModel,
    size: nonEmptyString(value.size, '1024x1024'),
    saveToWorkspace: plainValueOf(value.saveToWorkspace) !== false,
    outputDir: nonEmptyString(value.outputDir, 'generated-images'),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180000,
    // 列表整体保留（与设置页一致）：哪怕某一项还没填全，也要占着它那一格 id，否则两侧会错位。
    providers: Array.isArray(providers) ? providers.map((raw) => normalizeProvider(raw, taken)) : [],
    activeProviderId: nonEmptyString(value.activeProviderId),
    modelRoutes: normalizedRoutes(value.modelRoutes),
    /*
     * 只接受**正整数**毫秒——与客户端 `parseFallbackMs` 同一口径。
     * 早先这里是 `Number.isFinite(...) && > 0`，于是 Host 认 1.5，而客户端要整数：
     * 手改配置写个浮点，工具会照它执行，界面却把它洗成默认值，两边看到的不是同一个数。
     */
    fallbackAfterMs: Number.isInteger(plainValueOf(value.fallbackAfterMs)) && plainValueOf(value.fallbackAfterMs) > 0
      ? plainValueOf(value.fallbackAfterMs)
      : DEFAULT_FALLBACK_AFTER_MS,
  }
}

/** 一条模型路由（`{ providerId, model }`）的归一；任一项为空都表示"这一档没配"。 */
function normalizedRoute(raw) {
  const value = plainValueOf(raw)
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return { providerId: nonEmptyString(source.providerId), model: nonEmptyString(source.model) }
}

/** 生图/修图两个角色的主用与备用路由；形状恒定，取值方不必再防 undefined。 */
function normalizedRoutes(raw) {
  const value = plainValueOf(raw)
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const role = (key) => {
    const entry = plainValueOf(source[key])
    const scoped = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
    return { primary: normalizedRoute(scoped.primary), fallback: normalizedRoute(scoped.fallback) }
  }
  return { generate: role('generate'), edit: role('edit') }
}

/**
 * 当前生效的服务商，三级回退：
 *
 *   ① `activeProviderId` 命中列表里的某一项 —— 用户明确选中的那个；
 *   ② 没命中（为空、或指向已被改名/删除的条目）而列表非空 —— 取列表第一个。
 *      设置页就是这么纠偏显示的，Host 必须同规则，否则界面说的和实际用的不是一家；
 *   ③ 列表为空 —— 返回 undefined，调用方整体回退到旧的 baseUrl/model/editModel。
 */
function activeProviderOf(config) {
  const list = Array.isArray(config?.providers) ? config.providers : []
  if (list.length === 0) return undefined
  const id = typeof config.activeProviderId === 'string' ? config.activeProviderId : ''
  if (id !== '') {
    const matched = list.find((provider) => provider.id === id)
    if (matched !== undefined) return matched
  }
  return list[0]
}

/** 三级回退当前落在哪一级：`active` / `first` / `legacy`。 */
function providerLevelOf(config) {
  const list = Array.isArray(config?.providers) ? config.providers : []
  if (list.length === 0) return 'legacy'
  const id = typeof config.activeProviderId === 'string' ? config.activeProviderId : ''
  return id !== '' && list.some((provider) => provider.id === id) ? 'active' : 'first'
}

/**
 * 启动自述里的「当前在用谁」摘要。
 *
 * 这份文件是 Host 侧唯一的可视化入口，所以把回退级别（level）与真正生效的
 * baseUrl/模型/凭据名一起写进去——只看配置列表本身分不清"配了"和"真的在用"。
 * 只写凭据名，不写密钥本身。
 */
function activeProviderSummary(config) {
  const level = providerLevelOf(config)
  const provider = activeProviderOf(config)
  if (provider === undefined) {
    return {
      level,
      requested: config.activeProviderId,
      id: '',
      label: '',
      baseUrl: config.baseUrl,
      keyRef: API_KEY_REF,
      imageModel: config.model,
      editModel: config.editModel,
    }
  }
  const fallbackModel = provider.imageModel === '' ? config.model : provider.imageModel
  return {
    level,
    requested: config.activeProviderId,
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    keyRef: providerCredentialRef(provider.id, provider.keyRef),
    imageModel: fallbackModel,
    editModel: provider.editModel === '' ? fallbackModel : provider.editModel,
  }
}

/**
 * 把配置折算成「当前生效服务商的接口参数」。
 *
 * 服务商模式下：baseUrl 取服务商的，密钥名取 `DSH_IMAGE_BRIDGE_KEY_<ID>`，
 * 生图模型取 imageModel、改图模型取 editModel（为空则回退 imageModel，再回退旧 model）。
 * 回退模式下一切照旧，密钥名仍是 DSH_IMAGE_BRIDGE_API_KEY。
 *
 * `role` 决定用哪一档模型名：`generate` 用 imageModel，`edit` 用 editModel。
 */
function endpointFor(config, role) {
  const provider = activeProviderOf(config)
  const legacyModel = role === 'edit' ? config.editModel : config.model
  if (provider === undefined) {
    return { provider: undefined, baseUrl: config.baseUrl, model: legacyModel, keyRef: API_KEY_REF, label: '' }
  }
  if (provider.baseUrl === '') {
    throw new Error(`服务商「${provider.label}」还没有填写接口地址（baseUrl）：请在「设置 → 生图桥」里补全后再试。`)
  }
  const imageModel = provider.imageModel === '' ? config.model : provider.imageModel
  return {
    provider,
    baseUrl: provider.baseUrl,
    model: role === 'edit' && provider.editModel !== '' ? provider.editModel : imageModel,
    keyRef: providerCredentialRef(provider.id, provider.keyRef),
    label: provider.label,
  }
}

/**
 * 解析一条模型路由。
 *
 * - `none`：这一档没配（providerId 或 model 为空），或指向的服务商已经不存在——
 *   调用方按契约继续往下一档回退；
 * - `ready`：命中服务商且凭据可用，端点带上**那家服务商**的 baseUrl 与 keyRef；
 * - `unavailable`：配了但用不了（缺 baseUrl、缺凭据）。绝不借用别家服务商的密钥（F-3）。
 */
async function resolveModelRoute({ ctx, config, route }) {
  const providerId = nonEmptyString(route?.providerId)
  const model = nonEmptyString(route?.model)
  if (providerId === '' || model === '') return { kind: 'none' }
  const provider = (Array.isArray(config.providers) ? config.providers : []).find((item) => item.id === providerId)
  if (provider === undefined) {
    /*
     * 路由配着，但它点名的那家服务商**不在了**（改过名字、删过卡片、手改过配置）。
     *
     * 这里绝不能返回 'none' 让调用方静默掉到下一档：下一档用的是「当前生效服务商」的
     * imageModel，于是会出现"拿 A 家的模型名去问 B 家的地址"——真机上就是这么炸的：
     * 路由里是 id `other`、卡片实际叫 `others`，结果把 A 家的模型名发到 B 家，
     * 换回一句 `404 Model not exist`，排查时完全看不出真正的错在哪。
     * 明确报错比一个看起来像"服务商拒绝了这个模型"的 404 有用得多。
     */
    return {
      kind: 'unavailable',
      message: `模型路由指向的服务商「${providerId}」不在服务商列表里（可能是改过名字或删掉了这张卡片），没有发出任何请求。请在「设置 → 生图桥」的「模型」区块里重新选一次模型。`,
    }
  }
  if (provider.baseUrl === '') {
    return { kind: 'unavailable', message: `模型路由指向的服务商「${provider.label}」没有填写接口地址（baseUrl）。` }
  }
  const keyRef = providerCredentialRef(provider.id, provider.keyRef)
  const apiKey = await resolveApiKey(ctx, keyRef)
  if (apiKey === '') {
    return { kind: 'unavailable', message: `模型路由指向的服务商「${provider.label}」没有可用的 API Key（凭据名 ${keyRef}）。` }
  }
  return { kind: 'ready', endpoint: { provider, baseUrl: provider.baseUrl, model, keyRef, apiKey, label: provider.label } }
}

/** 取某个端点的密钥；拿不到就按该端点自己的凭据名报错（不跨服务商借用）。 */
async function keyForEndpoint(ctx, endpoint) {
  const apiKey = await resolveApiKey(ctx, endpoint.keyRef)
  if (apiKey === '') {
    throw new Error(`尚未配置生图接口密钥：凭据 ${endpoint.keyRef} 里没有密钥，请在「设置 → 生图桥」里填入 API Key 并保存，或设置环境变量 ${endpoint.keyRef}。`)
  }
  return apiKey
}

/**
 * 组装本次调用要尝试的端点序列（主用 + 可选备用）。
 *
 * 主用的解析顺序：`args.model` → `modelRoutes.<role>.primary` → 当前生效服务商的
 * imageModel/editModel → 旧字段（后两档由 endpointFor 负责）。备用只来自
 * `modelRoutes.<role>.fallback`；它没配、或指向的服务商不可用，就等于"没有备用"，
 * 但要把原因留着，好在主用失败时如实说明为什么没换成。
 *
 * 每条路由都用**它自己那家服务商**的 baseUrl 与凭据：跨服务商选择模型不等于借用密钥。
 */
async function imageAttemptPlan({ ctx, config, role, requestedModel }) {
  const routes = config.modelRoutes[role]
  const primaryRoute = await resolveModelRoute({ ctx, config, route: routes.primary })
  const fallbackRoute = await resolveModelRoute({ ctx, config, route: routes.fallback })
  const fallback = fallbackRoute.kind === 'ready' ? fallbackRoute.endpoint : undefined
  const fallbackNote = fallbackRoute.kind === 'unavailable' ? fallbackRoute.message : undefined

  /*
   * 主用**构造期**就会失败的情况：路由指向的服务商不在、缺地址、缺凭据，或显式给了 model
   * 但当前生效服务商拿不到密钥。
   *
   * 这类失败**不能直接 throw**：备用已经配好并可用时，它本来能救这次调用——"网络失败换备用"
   * 的承诺必须在"配置失败"上同样成立，否则用户会看到"配了备用却从不上场"。
   * 所以先把失败原因收下来，等备用解析完再决定：有可用备用 → 只用备用并带上原因；
   * 一个都不剩 → 明确报出来（不发任何请求）。
   */
  let primaryFailure
  let primary
  if (primaryRoute.kind === 'unavailable') {
    primaryFailure = primaryRoute.message
  } else if (requestedModel !== '') {
    const endpoint = endpointFor(config, role)
    try {
      primary = { ...endpoint, model: requestedModel, apiKey: await keyForEndpoint(ctx, endpoint) }
    } catch (error) {
      primaryFailure = error instanceof Error ? error.message : String(error)
    }
  } else if (primaryRoute.kind === 'ready') {
    primary = primaryRoute.endpoint
  } else {
    const endpoint = endpointFor(config, role)
    try {
      primary = { ...endpoint, apiKey: await keyForEndpoint(ctx, endpoint) }
    } catch (error) {
      primaryFailure = error instanceof Error ? error.message : String(error)
    }
  }

  if (primaryFailure !== undefined) {
    if (fallback !== undefined) return { primary: undefined, fallback, primaryNote: primaryFailure, fallbackNote }
    throw new Error(`${primaryFailure}${fallbackNote === undefined ? '' : `（备用模型也不可用：${fallbackNote}）`}`)
  }
  return { primary, ...(fallback === undefined ? {} : { fallback }), ...(fallbackNote === undefined ? {} : { fallbackNote }) }
}

/**
 * 取本次调用可用的 API Key。
 *
 * 首选 credentials 服务（Web 设置页写的就是它），其次环境变量。逐次解析、不缓存，
 * 这样用户在设置页改完 Key 之后无需重启即可生效。
 *
 * `ref` 是本次要用的凭据名：单服务商模式是 DSH_IMAGE_BRIDGE_API_KEY，多服务商模式是
 * 该服务商自己的 `DSH_IMAGE_BRIDGE_KEY_<ID>`。**刻意不跨名字回退**——把 A 服务商的密钥
 * 发给 B 服务商，比报一个明确的"缺少密钥"糟糕得多。
 */
async function resolveApiKey(ctx, ref = API_KEY_REF) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') return resolved.value
    } catch {
      /* 回退到环境变量 */
    }
  }
  const ambient = process.env[ref]
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

/** 下载服务商返回的图片时的上限与超时：与改图上传的 20MiB 对齐，避免被超大响应打爆内存。 */
const IMAGE_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15000

/**
 * 服务商返回的图片地址能不能去取？
 *
 * 只允许 `http` / `https`，并拒绝环回与私有网段。理由：这个 URL 是**对方给的**，
 * 无条件去 fetch 就等于替它发内网请求（SSRF）——云元数据地址 `169.254.169.254`、
 * 局域网设备、本机服务都能被它借我们的进程探一遍；`file:` 之类的协议更不该碰。
 * 注意这是纵深防御：真实生图服务商给的都是公网 https 地址，拦掉这些不影响正常使用。
 */
function imageUrlRejection(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return '地址不是合法的 URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `不支持的协议 ${parsed.protocol}`
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.endsWith('.local')) {
    return '指向本机/本地网络'
  }
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/u.test(host)) return '指向私有网段'
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./u.test(host)) return '指向私有网段'
  if (/^(fe80:|fc|fd|::ffff:127\.)/iu.test(host)) return '指向私有网段'
  return undefined
}

/**
 * 服务商填的接口地址能不能用？
 *
 * 与图片地址**刻意不同**：这里只校验协议，**允许**本机与私网。
 * 因为这是用户自己在设置页填的、明确的意思表示——本地生图服务（Ollama、LM Studio、
 * 本地 mock、内网网关）都是正当用法，本机 Harness 的配置里就有一个 `http://127.0.0.1:...`
 * 的常规配置。SSRF 的风险面在"别人给的地址"（见 imageUrlRejection），不在用户自己的地址。
 * 返回 `undefined` 表示通过。
 */
function baseUrlRejection(baseUrl) {
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    return '不是合法的 URL（应形如 https://api.example.com/v1）'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `不支持的协议 ${parsed.protocol}`
  if (parsed.hostname === '') return '缺少主机名'
  return undefined
}


/** 生图接口 JSON 回包的上限：防止服务商返回无界正文把内存吃光（正常回包远小于它）。 */
const JSON_RESPONSE_MAX_BYTES = 32 * 1024 * 1024

/**
 * 读取响应正文，带**上限**与**取消**。
 *
 * 响应头到手只是"对方开始答了"，正文可能几 MB、也可能永远不结束。旧实现直接 `text()`：
 * 既没有上限（恶意/故障服务商可以让内存放大），也不理 `exec.signal`（用户取消后照样读到底）。
 * 这里用 Promise.race 把正文读取和取消信号赛跑——不改动 fetch 语义，也不依赖流的中断细节。
 */
async function readCappedText(response, { signal, limitBytes = JSON_RESPONSE_MAX_BYTES } = {}) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new Error(`接口回包声明 ${declared} 字节，超过 ${limitBytes} 字节上限`)
  }
  let onAbort
  const aborted = new Promise((_resolve, reject) => {
    if (signal === undefined || signal === null) return
    if (signal.aborted === true) {
      reject(new Error('已被调用方取消'))
      return
    }
    onAbort = () => reject(new Error('已被调用方取消'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const text = await Promise.race([
      response.text(),
      aborted,
    ])
    if (typeof text === 'string' && text.length > limitBytes) {
      throw new Error(`接口回包超过 ${limitBytes} 字节上限`)
    }
    return text
  } finally {
    if (onAbort !== undefined && signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort)
  }
}

async function readJsonResponse(response, signal) {
  const text = await readCappedText(response, { signal })
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
    // 这个地址是服务商给的，不是我们选的：先过 SSRF 白名单，再限时限长。
    const rejection = imageUrlRejection(item.url)
    if (rejection !== undefined) {
      throw new Error(`下载生成的图片失败：服务商返回的图片地址${rejection}，已拒绝请求（${truncate(item.url)}）`)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`download-timeout`)), IMAGE_DOWNLOAD_TIMEOUT_MS)
    const forward = () => controller.abort(signal?.reason)
    if (signal !== undefined && signal !== null) signal.addEventListener('abort', forward, { once: true })
    try {
      const response = await fetchResilient(item.url, { signal: controller.signal }, controller.signal)
      if (!response.ok) throw new Error(`下载生成的图片失败：${response.status} ${response.statusText}`)
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > IMAGE_DOWNLOAD_MAX_BYTES) {
        throw new Error(`下载生成的图片失败：响应声明 ${declared} 字节，超过 ${IMAGE_DOWNLOAD_MAX_BYTES} 字节上限`)
      }
      // 分块读取并在累计超限时立刻中止：只信 content-length 挡不住不报长度的服务端。
      const reader = response.body?.getReader()
      if (reader === undefined) return new Uint8Array(await response.arrayBuffer())
      const chunks = []
      let total = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done === true) break
        total += value.length
        if (total > IMAGE_DOWNLOAD_MAX_BYTES) {
          await reader.cancel().catch(() => {})
          throw new Error(`下载生成的图片失败：响应超过 ${IMAGE_DOWNLOAD_MAX_BYTES} 字节上限`)
        }
        chunks.push(value)
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }
      return merged
    } finally {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', forward)
    }
  }
  return undefined
}

/**
 * "这次调用没有产出任何可用图片"。
 *
 * 与"图片已经产出、只是传输失败"（下载 url 形态的图片失败）刻意分开：前者可以换备用模型
 * 重试，后者不能——服务商已经生成并计费了，再生成一次就是重复计费。
 */
class NoImageError extends Error {
  name = 'NoImageError'
}

async function collectImages(payload, signal) {
  const data = Array.isArray(payload?.data) ? payload.data : undefined
  if (data === undefined) {
    throw new NoImageError(`图片接口返回里没有 data 数组：${truncate(JSON.stringify(payload ?? null))}`)
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
  if (out.length === 0) throw new NoImageError('图片接口没有返回任何可用的图片数据')
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
    // 首次**带上**调用方的信号：不然取消/超时根本传不到网络层，这里只会打印一句"已中止"。
    return await fetch(url, signal === undefined || signal === null ? init : { ...init, signal })
  } catch (error) {
    const first = describeFetchFailure(error, url)
    const state = describeSignal(signal)
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      throw new Error(`${first}（exec.signal ${state}）`)
    }
    // 只有在"没人要求中止"时才去掉信号重试一次；此时放弃信号不违背取消语义。
    const retryInit = { ...init }
    delete retryInit.signal
    try {
      return await fetch(url, retryInit)
    } catch (retryError) {
      throw new Error(`${first}（exec.signal ${state}）；去掉信号重试仍失败：${describeFetchFailure(retryError, url)}`)
    }
  }
}

/**
 * "这次请求真正发出去了"的时刻。
 *
 * 为什么需要它：`fetch()` 一调用就要先解析 DNS、建 TCP、握 TLS，这些时间**不是**服务商
 * 的响应时间。旧实现从调用 fetch 起就开始算预算，于是连接慢（跨境、代理、冷连接）会白白
 * 吃掉"多久没响应就换备用"的额度，甚至出现"请求还没送到就已经超时"——报的却是服务商超时。
 *
 * 取值来源是 undici 自己的诊断通道（`node:diagnostics_channel`，Node 内置、不引第三方依赖）：
 * `undici:request:bodySent` 在请求体写完、请求真正上线时触发。实测（跨境到阿里云 MaaS）：
 * 请求发出 @381ms、响应头 @60818ms —— 连接只占 0.6%，服务商处理占了 99.4%。
 *
 * 用途是**诊断与推迟起算**，不是安全边界：拿不到事件时（通道被改名、非 fetch 路径）就
 * 退化回"从调用开始算"，也就是旧行为，绝不会因此不设预算。
 */
let lastRequestSentAt = 0
/**
 * 请求发出事件的序号：发出时递增。
 *
 * 为什么用序号而不是"比较时间戳"：同毫秒内 `bodySent` 可能正好等于本次尝试的开始时刻，
 * 用 `>` 比较会把"已发出"判成"没发出"（真机上就这样：startedAt 与 moduleSentAt 逐毫秒相同）。
 * 任何基于"时间差"的推断，在计时器分辨率面前都是不可靠的；序号没有这个问题。
 * 极小的残留可能：并发多请求时序号会跟着最后一个事件走，那种情况下预算只会更宽松、不会误杀。
 */
let requestSentSeq = 0
try {
  diagnostics.subscribe('undici:request:bodySent', () => {
    lastRequestSentAt = Date.now()
    requestSentSeq += 1
  })
} catch {
  // 订阅失败（旧 Node、通道缺失）只意味着退回旧行为，不是错误。
}

/**
 * 只读诊断：最近一次"请求真正发出"的时刻（`0` = 没拿到，此时预算退回从调用开始算）。
 *
 * 导出它是为了**可验证**：响应头预算是否有正确跳过"发出前"的时间，断言必须能读到这个值，
 * 否则测试只能间接猜（"连接慢"这类用例很容易造不出效果却看起来通过）。
 * 也供维护者手工核对通道在当前 Node 上是否可用。
 */
export function lastRequestSentMoment() {
  return lastRequestSentAt
}

/** 只读诊断：最近一次预算判定的原始数值，用来解释"为什么判成了连接阶段"。 */
export function lastBudgetVerdict() {
  return lastBudgetVerdictValue
}

let lastBudgetVerdictValue = null

/** 响应头预算的判定依据：以"请求发出时刻"为基准的**固定**截止时刻，连接阶段另有宽限上限。 */
function headerBudgetOf({ budgetMs, startedAt, connectGraceMs }) {
  /** 本次尝试开始时的发出事件序号：只有它变大，才说明"这一次的请求确实发出去了"。 */
  const startSeq = requestSentSeq
  return {
    /**
     * 请求真正发出的时刻（0 = 还没发出）。
     *
     * **必须惰性读取**：构造预算的那一刻请求必然还没发出去（`lastRequestSentAt` 还是旧值或 0），
     * 若在这里快照一次，之后永远读不到"已发出"，每次超时都会被判成"发出前"——第一版就是这么错的。
     *
     * 判定用**事件序号**而不是"比较时间戳"：请求常常与本次尝试落在同一毫秒，用 `>` 比较会把
     * "已发出"误判成"没发出"（真机上就是：startedAt 与 moduleSentAt 逐毫秒相同）——第二版错在这里。
     * 任何基于时间差的推断都受计时器分辨率摆布，序号不会。
     * 极小残留：并发多请求时序号跟着最后一个事件走，那种情况下预算只会更宽松，不会误杀。
     */
    requestSentAt() {
      if (requestSentSeq > startSeq) {
        // 事件时刻可能早于 startedAt 同毫秒，夹到 startedAt，保证"发出后"从不为负。
        return lastRequestSentAt > 0 ? Math.max(lastRequestSentAt, startedAt) : startedAt
      }
      // 序号没动：订阅不可用（序号恒为 0）时退回"时间戳不早于开始"的宽松判定。
      return requestSentSeq === 0 && lastRequestSentAt >= startedAt ? lastRequestSentAt : 0
    },
    /** 请求已发出后还剩多少毫秒（未发出时视为无限，交给连接宽限管）。 */
    remaining() {
      const sentAt = this.requestSentAt()
      return sentAt === 0 ? Number.POSITIVE_INFINITY : Math.max(0, budgetMs - (Date.now() - sentAt))
    },
    /** 发出前的等待用了多少毫秒（未发出时返回已等待时长）。 */
    connectMs() {
      const sentAt = this.requestSentAt()
      return Math.round((sentAt === 0 ? Date.now() : sentAt) - startedAt)
    },
    /**
     * 计时器该定多久。
     *
     * 关键是"截止时刻固定、不随事件刷新"：
     *   已发出 → 发出时刻 + 预算；
     *   未发出 → 开始 + min(连接宽限, 预算)。
     * 若按"每次重算剩余量"来重置计时器，连接宽限会把服务商的慢响应也当成连接时间，
     * 等于把预算悄悄放宽到宽限值——那也是被测试抓到过的一版错误。
     */
    nextDelayMs() {
      const sentAt = this.requestSentAt()
      const deadline = sentAt === 0
        ? startedAt + Math.min(connectGraceMs, budgetMs)
        : sentAt + budgetMs
      return Math.max(1, deadline - Date.now())
    },
  }
}

/**
 * 一次"到响应头为止"的请求尝试。
 *
 * 两个中止来源：`exec.signal`（调用方取消）与 `fallbackAfterMs` 预算（响应头超时）。
 * 请求发出去之后两者没有区别，差别只在失败时怎么解释——**取消不是失败**，绝不能因此
 * 改用备用模型；超时才轮到备用上场。预算只算到拿到响应头为止：头一到就撤销计时器，
 * 之后读 body 不受它限制（整次调用的上限仍由工具的 timeoutMs 管）。
 *
 * **预算从"请求真正发出"起算**（见 headerBudgetOf）：DNS / TCP / TLS 不占额度，且截止时刻
 * 固定不随事件刷新。连接阶段另有 `connectGraceMs` 上限（且不超过预算本身），只为防止
 * "一直连不上"把整次调用拖到 timeoutMs；正常的跨境连接（实测 381ms）远低于它。
 *
 * 网络层失败保留既有的"去掉 exec.signal 重试一次"兜底（fetchResilient 的行为），
 * 但重试时换成只带预算的信号——否则"多久没响应头就换人"会在重试路径上失效。
 *
 * @returns {{kind:'response', response}|{kind:'timeout'|'cancelled'|'failed', error}}
 */
async function attemptWithHeaderBudget({ url, init, signal, budgetMs, connectGraceMs = 10000 }) {
  const budget = new AbortController()
  const startedAt = Date.now()
  let expired = false
  let timer
  const headerBudget = headerBudgetOf({ budgetMs, startedAt, connectGraceMs })
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(fire, Math.max(1, headerBudget.nextDelayMs()))
  }
  function fire() {
    lastBudgetVerdictValue = {
      startedAt,
      moduleSentAt: lastRequestSentAt,
      seenSentAt: headerBudget.requestSentAt(),
      now: Date.now(),
      budgetMs,
      connectMs: headerBudget.connectMs(),
    }
    // 还没发出去 = 连接阶段超了宽限：如实说是连接没建立，别说成"服务商没响应"。
    if (headerBudget.requestSentAt() === 0) {
      expired = true
      budget.abort(new Error('connect-timeout'))
      return
    }
    const left = headerBudget.remaining()
    if (left > 0) {
      // 计时器在"请求发出"的同一瞬间先响了：按剩余额度重新计时，不误判超时。
      timer = setTimeout(fire, left)
      return
    }
    expired = true
    budget.abort(new Error('header-timeout'))
  }
  arm()
  const forwardAbort = () => budget.abort(signal?.reason)
  const callerAborted = () => signal !== undefined && signal !== null && signal.aborted === true
  if (callerAborted()) budget.abort(signal.reason)
  else if (signal !== undefined && signal !== null) signal.addEventListener('abort', forwardAbort, { once: true })
  try {
    let response
    try {
      response = await fetch(url, { ...init, signal: budget.signal })
    } catch (error) {
      const first = describeFetchFailure(error, url)
      // 先看取消：调用方要求停止时，任何"重试/换人"都是错的。
      if (callerAborted()) return { kind: 'cancelled', error: new Error(`${first}（exec.signal ${describeSignal(signal)}）`) }
      if (expired) return { kind: 'timeout', error: new Error(timeoutNote(first, headerBudget, budgetMs)) }
      try {
        response = await fetch(url, { ...init, signal: budget.signal })
      } catch (retryError) {
        if (callerAborted()) return { kind: 'cancelled', error: new Error(`${first}（exec.signal ${describeSignal(signal)}）`) }
        if (expired) return { kind: 'timeout', error: new Error(timeoutNote(first, headerBudget, budgetMs)) }
        return { kind: 'failed', error: new Error(`${first}（exec.signal ${describeSignal(signal)}）；去掉信号重试仍失败：${describeFetchFailure(retryError, url)}`) }
      }
    }
    return { kind: 'response', response }
  } finally {
    clearTimeout(timer)
    if (signal !== undefined && signal !== null) signal.removeEventListener('abort', forwardAbort)
  }
}

/** 超时文案：请求发出后超时算服务商问题，连接阶段超时算连接问题，两者不能混为一谈。 */
function timeoutNote(first, headerBudget, budgetMs) {
  if (headerBudget.requestSentAt() === 0) {
    return `${first}（连接阶段超过 ${Math.round(headerBudget.connectMs())}ms 仍未把请求发出去；响应头预算 ${budgetMs}ms 不包含连接时间）`
  }
  return `${first}（请求发出后超过 ${budgetMs}ms 仍未拿到响应头；连接耗时 ${headerBudget.connectMs()}ms 不计入这个预算）`
}

/** 按端点拼出一次生图/改图请求：生图走 JSON，改图走 multipart。 */
function imageRequestSpec({ endpoint, kind, prompt, size, model, n, file }) {
  const url = `${endpoint.baseUrl}/images/${kind === 'edit' ? 'edits' : 'generations'}`
  if (kind === 'edit') {
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt)
    if (size !== undefined && size !== '') form.append('size', size)
    form.append('image', new Blob([file.bytes], { type: file.mediaType }), file.name)
    return { url, init: { method: 'POST', headers: authHeaders(endpoint.apiKey), body: form } }
  }
  const body = { model, prompt }
  if (size !== undefined && size !== '') body.size = size
  if (Number.isFinite(n) && n > 1) body.n = n
  return {
    url,
    init: { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(endpoint.apiKey) }, body: JSON.stringify(body) },
  }
}

/**
 * 超时之后的一次探活：这家服务商现在是活的吗？
 *
 * 为什么需要它：客户端**看不到对方有没有收到请求**——HTTP 没有"已收到"确认，1xx 中间响应
 * 在 fetch 里也拿不到（实测 `103 Early Hints` 不触发任何回调）。所以"响应头超时"这一条
 * 错误信息本身分不清两种完全不同的处境：
 *   - 服务商已经挂了 / 地址不通：再等多久都没用，应该马上去修配置；
 *   - 服务商正在慢慢生成（同步接口憋几十秒很常见，实测 42–61 秒）：只是我们等不了。
 * 探活能给出可操作的区分：打一个**便宜且不产生生图费用**的 `GET {baseUrl}/models`，
 * 通了就说明"服务在、密钥有效"，问题在"这次生成太慢"。
 *
 * 刻意保守：任何 HTTP 响应都算"活着"（404/401 也说明服务器在应答）；探活自身失败或超时
 * 只作为**软提示**附在错误后面，绝不改变原先的失败判定，也不影响是否换备用。
 */
async function probeProviderAlive(endpoint, signal) {
  if (endpoint === undefined || typeof endpoint.baseUrl !== 'string' || endpoint.baseUrl === '') return ''
  const budget = new AbortController()
  const forward = () => budget.abort(signal?.reason)
  signal?.addEventListener?.('abort', forward, { once: true })
  const timer = setTimeout(() => budget.abort(new Error('probe-timeout')), PROVIDER_PROBE_TIMEOUT_MS)
  const startedAt = Date.now()
  try {
    const response = await fetch(`${endpoint.baseUrl}/models`, {
      method: 'GET',
      headers: authHeaders(endpoint.apiKey),
      signal: budget.signal,
    })
    return `（超时后探活：${endpoint.baseUrl}/models ${Date.now() - startedAt}ms 内应答 HTTP ${response.status}——服务商是活的、密钥有效，这次只是生成慢；可把「主模型超时」调大）`
  } catch (error) {
    if (signal !== undefined && signal !== null && signal.aborted === true) return ''
    return `（超时后探活：${endpoint.baseUrl}/models 也连不上——服务商当前不可达，不只是这次慢：${describeFetchFailure(error, `${endpoint.baseUrl}/models`)}）`
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', forward)
  }
}

/**
 * 一次取图尝试：只负责"发出请求并拿到可用图片"。
 *
 * 网络失败、响应头超时、非 2xx（含回包不是 JSON）、以及**回包正常但解析不出任何可用图片**
 * 都不在这里抛，而是交回上层决定要不要换备用——从用户视角这四种都是"这次没出图"。
 * 图片已经产出、只是传输失败（url 形态下载失败）才是硬错误：那是已经计过费的一次生成，
 * 换备用会重复计费。
 */
async function requestImagesOnce({ endpoint, kind, prompt, size, model, n, file, signal, budgetMs }) {
  const spec = imageRequestSpec({ endpoint, kind, prompt, size, model, n, file })
  const attempt = await attemptWithHeaderBudget({ url: spec.url, init: spec.init, signal, budgetMs, connectGraceMs: CONNECT_GRACE_MS })
  if (attempt.kind === 'timeout') {
    // 只在"发出去了但没回头"时探活：连接阶段超时已经说清是连不上，再探一次没有新信息。
    if (!attempt.error.message.includes('连接阶段')) {
      const note = await probeProviderAlive(endpoint, signal)
      if (note !== '') return { kind: 'timeout', error: new Error(`${attempt.error.message}${note}`) }
    }
    return attempt
  }
  if (attempt.kind !== 'response') return attempt
  let payload
  try {
    payload = await readJsonResponse(attempt.response, signal)
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) }
  }
  try {
    return { kind: 'images', images: await collectImages(payload, signal) }
  } catch (error) {
    if (error instanceof NoImageError) return { kind: 'failed', error }
    throw error
  }
}

/**
 * 跑一次"主模型 → 备用模型"的取图。
 *
 * 换备用的条件：网络失败、非 2xx（含回包不是 JSON）、超过 `budgetMs` 没拿到响应头、
 * 以及回包正常却解析不出任何可用图片（"这次没出图"）。
 * 取消（exec.signal 已中止）**不换**；备用没配或不可用时，把主模型的错误如实报出去，
 * 并把"备用为什么没上"一并说清楚。
 *
 * @returns {{ images, endpoint, warning? }}
 */
async function requestImagesWithFallback({ plan, label, kind, prompt, size, n, file, signal, budgetMs }) {
  /*
   * 主用可能在**构造期**就不可用（路由指向的服务商不在、缺地址、缺凭据）。
   * imageAttemptPlan 把这种失败收在 `primaryNote` 里并保留备用：备用可用就直接走备用，
   * 不能因为主用没构造出来就丢掉整次调用。
   */
  const primary = plan.primary
  let first
  let primaryLabel
  if (primary === undefined) {
    primaryLabel = '主用模型'
    first = { kind: 'failed', error: new Error(plan.primaryNote ?? '主用模型不可用') }
  } else {
    primaryLabel = `「${primary.model}」`
    first = await requestImagesOnce({ endpoint: primary, kind, prompt, size, model: primary.model, n, file, signal, budgetMs })
    if (first.kind === 'images') return { ...first, endpoint: primary }
    if (first.kind === 'cancelled') throw first.error
  }
  if (plan.fallback === undefined) {
    const note = plan.fallbackNote === undefined ? '' : `（备用模型不可用：${plan.fallbackNote}）`
    throw new Error(`${label}${primaryLabel === '主用模型' ? '' : primaryLabel}失败：${first.error.message}${note}`)
  }
  const fallback = plan.fallback
  const second = await requestImagesOnce({ endpoint: fallback, kind, prompt, size, model: fallback.model, n, file, signal, budgetMs })
  if (second.kind === 'images') {
    /*
     * 主用是构造期失败（路由失效/缺地址/缺凭据）时，文案里不能写"模型「undefined」失败"——
     * 那种半截话正是这次真机事故里最误导人的地方。直接用失败原因本身。
     */
    return {
      ...second,
      endpoint: fallback,
      warning: primary === undefined
        ? `${label}：${first.error.message}，已改用备用模型「${fallback.model}」。`
        : `${label}${primaryLabel}未能成功（${first.error.message}），已改用备用模型「${fallback.model}」。`,
    }
  }
  if (second.kind === 'cancelled') throw second.error
  throw new Error(`${label}${primaryLabel}失败：${first.error.message}；备用模型「${fallback.model}」也失败：${second.error.message}`)
}

/**
 * 生效服务商被**静默替换**时给用户的一句警告。
 *
 * 三级回退里第二级（`activeProviderId` 没命中 → 取列表第一项）是必要的容错：卡片被改名或
 * 删除后，硬报错会让用户连图都画不了。但它同时是**计费风险**——用户以为在用 A 家，实际
 * 请求打到了 B 家、用的是 B 家的密钥与额度，而这件事此前只写进启动自述（`level: first`），
 * 工具路径从不告诉用户。所以这里把它作为一条普通警告随结果一起返回：
 * 图照出，但用户知道"刚才那一次是谁出的"。
 *
 * 只在**用户明确选过、而那个选择失效了**时才提示（`requested` 非空且不命中）。
 * `requested` 为空是正常的"没选过"，那时用列表第一项是预期行为，不该打扰。
 */
function activeProviderSwapWarning(config) {
  if (providerLevelOf(config) !== 'first') return undefined
  const requested = typeof config?.activeProviderId === 'string' ? config.activeProviderId.trim() : ''
  if (requested === '') return undefined
  const actual = activeProviderOf(config)
  if (actual === undefined) return undefined
  return `原本选中的服务商「${requested}」已不在列表里（可能改过名字或已删除），这次改用列表第一个「${actual.label}」（${actual.baseUrl}）。请在「设置 → 生图桥」的「模型」区块重新选一次模型。`
}

/**
 * 按**本次重读到的**配置给出"整次调用"的中止信号。
 *
 * 为什么不能只靠工具注册期的 `timeoutMs`：那是**挂载时算出来的快照**，用户在设置页改
 * 「调用超时」之后它不会变，而 README 承诺这些字段"可以在线改写、无需重启"——两者矛盾，
 * 实际表现就是"改了没反应"。所以真正的约束放在这里：每次调用重读 `live.timeoutMs` 并起一个
 * 中止计时器，与 `exec.signal`（调用方取消）合并。注册期那个值仍然保留，当作一道宽上限
 * （框架层如果更早掐断，也是中止，行为一致）。
 *
 * 顺便把"为什么中止"记下来：`AbortSignal.timeout()` 触发的错误只有一句 `TimeoutError`，
 * 直接抛给用户等于没说清发生了什么。
 */
function callBudgetSignal(exec, timeoutMs) {
  const budget = Math.max(1000, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180000)
  const timer = AbortSignal.timeout(budget)
  const timeoutError = new Error(`整次调用超过 ${budget}ms 未完成（配置里的「调用超时」，可在设置页调大）`)
  const signal = exec?.signal === undefined || exec.signal === null
    ? timer
    : AbortSignal.any([exec.signal, timer])
  return { signal, timeoutError }
}

/**
 * 把"整次调用中止"翻译成人能读懂的错误。
 *
 * 两种情况必须分开：**调用方取消**（用户主动停，不是错误，原样抛出即可）与
 * **自己的预算到期**（要说清是超了多久、以及去哪儿调大）。
 */
function callFailureOf(error, exec, budget) {
  if (exec?.signal !== undefined && exec.signal !== null && exec.signal.aborted === true) return error
  if (budget.signal.aborted === true) return budget.timeoutError
  return error
}

/**
 * 落实一次生图结果：存附件、写工作区文件、组装工具值。
 *
 * `extraWarnings` 用来把"这次其实是备用模型出的图"之类的运行时事实带给模型和用户——
 * 结果里不写清楚，用户只会看到一张跟主模型无关的图。
 *
 * @returns 输出 Schema 声明的规范值。
 */
async function settleImages(args) {
  const { ctx, exec, config, prompt, size, model, images } = args
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('没有挂载附件服务，无法保存生成的图片')

  const values = []
  const savedPaths = []
  const warnings = [...(args.extraWarnings ?? [])]
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
 *
 * 响应既然已经拿到了，就顺手按 `models` 的口径（同一个 modelsFromResponse）把模型列表
 * 也解出来：设置页点一次「测试连接」就能同时得到可达性与下拉框数据，不用再打一遍同样的
 * 请求。取不到列表**不算失败**——可达性判定与以前一字不差，列表只是附带信息。
 */
async function probeConnection({ baseUrl, apiKey, keyRef }) {
  if (apiKey === '') {
    return { ok: false, message: `尚未保存 API Key。请在上方填入后点击「保存」，或设置环境变量 ${keyRef ?? API_KEY_REF}。`, models: [] }
  }
  const url = `${baseUrl.replace(/\/+$/u, '')}/models`
  try {
    const { response, text } = await fetchModelsPayload({
      baseUrl,
      apiKey,
      timeoutMessage: (target) => `连接 ${target} 超时（${MODELS_TIMEOUT_MS / 1000} 秒未响应）`,
    })
    if (response.ok) return { ok: true, message: `连接成功：GET ${url} → ${response.status}`, models: modelsOrEmpty(response, text) }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `密钥被拒绝（HTTP ${response.status}）：${truncate(text, 200)}`, models: [] }
    }
    if (response.status === 404) return { ok: true, message: `接口可达：GET ${url} → 404，该服务可能不提供模型列表，这不影响生图。`, models: [] }
    return { ok: false, message: `接口返回 HTTP ${response.status}：${truncate(text, 200)}`, models: [] }
  } catch (error) {
    return { ok: false, message: `无法连接 ${url}：${error instanceof Error ? error.message : String(error)}`, models: [] }
  }
}

/** 解析模型列表；解析不出来就当"这家服务不提供列表"，绝不因此改变可达性结论。 */
function modelsOrEmpty(response, text) {
  try {
    return modelsFromResponse(response, text)
  } catch {
    return []
  }
}

/**
 * 从错误回包里取服务商自述的信息。
 *
 * OpenAI 兼容服务一般给 `{ error: { message } }`，也有给扁平 `{ message }` 的。
 * 取不到就退回原文，至少让用户看到服务商实际回了什么。
 */
function providerErrorMessage(text) {
  try {
    const payload = JSON.parse(text)
    const message = payload?.error?.message ?? payload?.message ?? payload?.error
    return typeof message === 'string' ? truncate(message, 300) : truncate(text, 300)
  } catch {
    return truncate(text, 300)
  }
}

/**
 * 取一次 `GET {baseUrl}/models` 的原始响应：同一个地址、同一个 Bearer、同一个 15 秒超时。
 *
 * `test` 与 `models` 共用这一步取数，区别只在拿到响应之后怎么解释（可达性 vs 模型列表），
 * 所以超时文案由调用方给——两边要说的不是同一件事。
 */
async function fetchModelsPayload({ baseUrl, apiKey, timeoutMessage }) {
  const url = `${baseUrl.replace(/\/+$/u, '')}/models`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), MODELS_TIMEOUT_MS)
  try {
    let response
    try {
      response = await fetchOrExplain(url, { method: 'GET', headers: authHeaders(apiKey), signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) throw new Error(timeoutMessage(url))
      throw error
    }
    let text
    try {
      // 正文读取也受同一个超时控制：旧实现只给响应头限时，正文一旦不结束就挂死。
      text = await readCappedText(response, { signal: controller.signal, limitBytes: JSON_RESPONSE_MAX_BYTES })
    } catch (error) {
      if (controller.signal.aborted) throw new Error(timeoutMessage(url))
      throw new Error(`读取模型列表响应失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return { url, response, text }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `/models` 回包的解析口径：只接受 `data[].id`，丢掉空值。
 *
 * `test` 与 `models` 共用同一份实现，两个端点给出的模型列表不会出现差异。非 2xx、
 * 非 JSON、没有 data 数组都抛错——由调用方决定那是"失败"（models RPC）还是
 * "这家服务不提供列表"（test 的可达性另算）。
 */
function modelsFromResponse(response, text) {
  if (!response.ok) {
    const selfReported = providerErrorMessage(text)
    throw new Error(`接口返回 HTTP ${response.status} ${response.statusText}${selfReported === '' ? '' : `：${selfReported}`}`)
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`接口返回的不是 JSON：${truncate(text) || '(空响应)'}`)
  }
  const data = Array.isArray(payload?.data) ? payload.data : undefined
  if (data === undefined) throw new Error(`接口返回里没有 data 数组：${truncate(JSON.stringify(payload ?? null))}`)
  return data.map((item) => (typeof item?.id === 'string' ? item.id.trim() : '')).filter((id) => id !== '')
}

/**
 * 拉取某个服务商提供的模型列表。
 *
 * 只接受 `data[].id` 并丢掉空值；非 2xx 时把状态码与服务商自述的 message 一起报出来。
 * 15 秒超时：这个接口只服务于设置页的模型下拉框，绝不能因为某个服务商不响应而把设置页卡住。
 */
async function listModels({ baseUrl, apiKey, keyRef }) {
  const root = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/u, '') : ''
  const ref = keyRef ?? API_KEY_REF
  if (root === '') throw new Error('没有可用的接口地址：请先在「设置 → 生图桥」里填写服务商的 baseUrl。')
  if (apiKey === '') throw new Error(`尚未配置接口密钥：请在「设置 → 生图桥」里填入 API Key（凭据名 ${ref}），或设置环境变量 ${ref}。`)
  const { response, text } = await fetchModelsPayload({
    baseUrl: root,
    apiKey,
    timeoutMessage: (url) => `获取模型列表超时（${MODELS_TIMEOUT_MS / 1000} 秒）：${url}`,
  })
  try {
    return modelsFromResponse(response, text)
  } catch (error) {
    throw new Error(`获取模型列表失败：${error instanceof Error ? error.message : String(error)}`)
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
  let { config: resolved, source: configSource } = effectiveConfigOf(ctx, config)

  /*
   * 参与设置服务——这一步是 volatile 配置能生效的**前提**。
   *
   * dsh-settings 的语义是"volatile 字段改动不重新挂载插件"（applies: 'live'），
   * 而它只对**已注册**的行提供这套机制：官方 LLM 插件都是先
   *   ctx.inject(['settings'], (child) => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))
   * 之后 fiber 的 config 才会带上 volatile 值，并在变更时收到 loader/volatile-update。
   * 缺了这一步，行里的值既进不了挂载配置，也读不到——这正是保存后工具仍用默认地址的原因。
   */
  try {
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  } catch {
    /* 设置服务不可用时不阻断插件：读取逻辑本身还有 fiber 与挂载参数两级回退 */
  }
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
    configSource,
    // 三级回退实际落在哪一级、真正生效的是谁：这份自述是 Host 侧唯一的可视化入口。
    provider: activeProviderSummary(resolved),
    ...extra,
  })
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      const next = effectiveConfigOf(ctx, config)
      resolved = next.config
      configSource = next.source
      /*
       * 保存后顺带刷新自述：用户刚在设置页换了服务商，自述里的 provider 级别与
       * baseUrl/凭据名也得跟着变，否则排查时看到的是挂载那一刻的旧事实。
       */
      void finish({})
    })
  }

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
    /*
     * 注册到刚查到的那个服务对象上，而不是再读一次 `ctx.tools`：两者在真实 Cordis 里是
     * 同一个对象，但桩环境（或属性访问被守卫时）可能只有 `ctx.get('tools')` 可用——
     * 那样报出来的会是 `Cannot read properties of undefined (reading 'register')`，
     * 把"服务没挂载"这个真正的原因埋掉。
     */
    const tools = ctx.get('tools')
    if (tools === undefined) throw new Error('tools 服务未挂载，无法注册工具')
    tools.register(defineTool({
      name: 'image_generate',
      description: '用外部生图模型按提示词生成图片，并把结果保存为可查看的图片。当用户要求画图、生成插画/图标/海报，或需要任何图像产物时使用；本工具不依赖当前模型自身的绘图能力。',
      parameters: {
        prompt: { type: 'string', required: true, description: '图片内容的描述，越具体越好（主体、风格、构图、光线、文字等）。' },
        size: { type: 'string', description: `图片尺寸，例如 1024x1024、1024x1536、1536x1024。默认 ${resolved.size}。` },
        model: { type: 'string', description: '覆盖默认生图模型（用当前生效服务商的地址与密钥）；留空时按设置页里的模型路由选择，主用失败会自动改用备用。' },
      },
      output: OUTPUT,
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt === '') throw new Error('prompt 不能为空')
        /*
         * 配置每次调用都重读：providers / activeProviderId / modelRoutes 都是 volatile
         * 字段，挂载期的 config 里根本没有它们，值只存在于设置服务；保存后也必须立刻生效。
         */
        const live = effectiveConfigOf(ctx, config).config
        const requestedModel = typeof args.model === 'string' ? args.model.trim() : ''
        const plan = await imageAttemptPlan({ ctx, config: live, role: 'generate', requestedModel })
        const size = typeof args.size === 'string' && args.size.trim() !== '' ? args.size.trim() : live.size
        const budget = callBudgetSignal(exec, live.timeoutMs)
        let result
        try {
          result = await requestImagesWithFallback({
            plan,
            label: '生图模型',
            kind: 'generate',
            prompt,
            size,
            n: 1,
            signal: budget.signal,
            budgetMs: live.fallbackAfterMs,
          })
        } catch (error) {
          throw callFailureOf(error, exec, budget)
        }
        return await settleImages({
          ctx,
          exec,
          config: live,
          prompt,
          size,
          model: result.endpoint.model,
          images: result.images,
          extraWarnings: [result.warning, activeProviderSwapWarning(live)].filter((entry) => entry !== undefined),
        })
      },
    }))

    tools.register(defineTool({
      name: 'image_edit',
      description: '用外部生图模型按提示词修改一张已有图片（局部重绘、换风格、增删元素等）。图片来自会话工作区里的文件路径。',
      parameters: {
        prompt: { type: 'string', required: true, description: '要如何修改这张图，例如「把背景换成夜晚的街道」。' },
        image_path: { type: 'string', required: true, description: '待修改图片的路径，由文件系统后端解析。' },
        size: { type: 'string', description: `输出尺寸，默认沿用原图或配置里的 ${resolved.size}。` },
        model: { type: 'string', description: '覆盖默认改图模型（用当前生效服务商的地址与密钥）；留空时按设置页里的模型路由选择，主用失败会自动改用备用。' },
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
        // 与生图同理：服务商、模型与路由每次调用都重读（改图那一路用 routes.edit）。
        const live = effectiveConfigOf(ctx, config).config
        const requestedModel = typeof args.model === 'string' ? args.model.trim() : ''
        const plan = await imageAttemptPlan({ ctx, config: live, role: 'edit', requestedModel })
        const size = typeof args.size === 'string' && args.size.trim() !== '' ? args.size.trim() : live.size
        const name = imagePath.split(/[\\/]/u).pop() ?? 'source.png'
        const budget = callBudgetSignal(exec, live.timeoutMs)
        let result
        try {
          result = await requestImagesWithFallback({
            plan,
            label: '改图模型',
            kind: 'edit',
            prompt,
            size,
            file: { bytes, mediaType, name },
            signal: budget.signal,
            budgetMs: live.fallbackAfterMs,
          })
        } catch (error) {
          throw callFailureOf(error, exec, budget)
        }
        return await settleImages({
          ctx,
          exec,
          config: live,
          prompt,
          size,
          model: result.endpoint.model,
          images: result.images,
          extraWarnings: [result.warning, activeProviderSwapWarning(live)].filter((entry) => entry !== undefined),
        })
      },
    }))
    note('两个工具已注册')
  } catch (error) {
    note(`工具注册失败：${error instanceof Error ? error.message : String(error)}`)
    void finish({ error: error instanceof Error ? error.stack : String(error) })
    throw error
  }

  registerTestRoute(ctx, config)
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

/**
 * 设置页的环回通道：与 `/api` 走同一道来源与会话栅栏。
 *
 * 三个方法：`test` 探活、`log` 收客户端诊断、`models` 拉模型列表（供设置页的下拉框）。
 * `test` / `models` 的 payload 都是 `{ baseUrl, apiKey, keyRef }`；凭据只认 `apiKey` 与
 * `keyRef` 两者之一，都没有就直接返回失败——绝不借用别的服务商的密钥。
 */
function registerTestRoute(ctx, applyConfig) {
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
        /*
         * 端点 = 通道前缀 + 一个已知的方法名。显式列举，避免把任意子路径都当成合法端点。
         */
        const prefix = `${RPC_CHANNEL}/`
        const endpoint = pathname.startsWith(prefix) && RPC_ENDPOINTS.includes(pathname.slice(prefix.length))
          ? pathname.slice(prefix.length)
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
          /*
           * test / models 都要现场重读配置：用户可能刚在设置页改完服务商或密钥，
           * 挂载期算出来的 config 里没有 volatile 值。
           */
          const live = effectiveConfigOf(ctx, applyConfig).config
          const provider = activeProviderOf(live)
          /*
           * 凭据只从 payload 里取：`apiKey`，或 `payload.keyRef` 指向的凭据。
           * **绝不回退到"当前生效服务商"的密钥**——设置页新建一张卡片、只填了地址就点
           * 「测试连接 / 获取可用模型」时，那会把 A 服务商的密钥发到 B 的地址上去。
           * 这与两个工具里"密钥只在它自己的 ref 下解析"是同一条原则，不能只在一半生效。
           * 形状不合法的 keyRef 一律忽略（与客户端 safeKeyRef 的处理一致）。
           */
          const declaredRef = nonEmptyString(payload.keyRef)
          const keyRef = declaredRef !== '' && CREDENTIAL_REF_PATTERN.test(declaredRef) ? declaredRef : ''
          const apiKey = typeof payload.apiKey === 'string' && payload.apiKey !== ''
            ? payload.apiKey
            : keyRef === ''
              ? ''
              : await resolveApiKey(ctx, keyRef)
          if (apiKey === '') {
            // 没有任何可用的密钥就到此为止：不发请求，把"该做什么"说清楚。
            throw new Error(keyRef === ''
              ? '本次请求没有可用的 API Key：请先在这张卡片上填入密钥并保存，再点「测试连接」或「获取可用模型」。'
              : `凭据 ${keyRef} 里还没有保存密钥：请在「设置 → 生图桥」里为这家服务商填入 API Key 并保存后重试。`)
          }
          /*
           * 地址**同样不回退**。
           *
           * 回退密钥是"把 A 的密钥发到 B 的地址"，回退地址则是它的镜像版：新建卡片只填了
           * 密钥就点「测试连接」→ 拿 `url-A + key-B` 去发 `GET /models`，既把 B 的密钥
           * 交给了 A 的地址，又把 A 的响应当成了 B 的诊断。两个字段必须来自同一次填写。
           */
          const declaredBaseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : ''
          if (declaredBaseUrl === '') {
            throw new Error('本次请求没有可用的接口地址：请先在这张卡片上填写接口地址并保存，再点「测试连接」或「获取可用模型」。')
          }
          const urlRejection = baseUrlRejection(declaredBaseUrl)
          if (urlRejection !== undefined) {
            throw new Error(`接口地址不可用：${urlRejection}（${truncate(declaredBaseUrl)}）。请填写服务商的 https 公网地址。`)
          }
          const baseUrl = declaredBaseUrl
          if (endpoint === 'models') {
            response.end(envelopeOf2(message.rpcId, { ok: true, value: { models: await listModels({ baseUrl, apiKey, keyRef }) } }))
            return
          }
          response.end(envelopeOf2(message.rpcId, { ok: true, value: await probeConnection({ baseUrl, apiKey, keyRef }) }))
        } catch (error) {
          response.end(envelopeOf2(message.rpcId, {
            ok: false,
            error: {
              code: endpoint === 'log' ? 'log-failed' : endpoint === 'models' ? 'models-failed' : 'probe-failed',
              message: error instanceof Error ? error.message : String(error),
              details: {},
            },
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
