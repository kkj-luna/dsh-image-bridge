/**
 * 升级保配置实验台（只读）。
 *
 * 目的：把「插件升级/改名/重装之后，用户在设置页存下的服务商配置会不会丢」这件事，
 * 从"读代码推断"变成**用 Harness 自己的 patch 合成算法跑出来的结果**。
 *
 * 用的是 dsh 安装目录里 `@deepseek-ai/dsh-app-boot` 导出的 `composeEntries` —— 也就是
 * profile 启动与热重载时真正用的那一个（`dsh-app-boot/lib/index.js:989`）。这里不重写算法。
 *
 * 参与合成的三层，全部按真实形状构造：
 *   1. 插件自带的 `cordis.patch.yml`（bundle 层，负责 `insert` 出那一行）
 *   2. profile 的 `cordis.patch.yml`（用户层，设置页写入的 override）
 *   3. 多包同名时的重复 insert（用于还原"改名只改一半"的碰撞局面）
 *
 * 三个关键实现事实（决定了断言为什么这么写）：
 *   - 设置页写用户行时**一定带 `name`**：`dsh-config-editor/lib/index.js:105-110` 用
 *     `{ id, name: entry.options.name, config }` 建行。
 *   - 合成时 `name` 不匹配就**整条 patch 跳过**（只留一条告警）：
 *     `dsh-app-boot/lib/index.js:100-103`。
 *   - 用户行的 `config` 是**整体**作为 override 的：`applyEntryPatches` 逐键覆盖
 *     （`dsh-app-boot/lib/index.js:104-107`），所以用户没写过的键不会从 bundle 默认值合并过来。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDshBin } from './dsh-paths.mjs'

/** 一个最小但形状完整的用户配置（覆盖设置页会写出的每一类字段）。 */
export const SAMPLE_PROVIDERS = [
  {
    id: 'default',
    label: '千问',
    baseUrl: 'https://<provider-endpoint>/v1',
    keyRef: 'DSH_IMAGE_BRIDGE_API_KEY',
    models: ['qwen-image-3.0', 'qwen-image-2.1-pro'],
    imageModel: 'qwen-image-3.0',
    editModel: '',
  },
]

/** 角色名以插件 Config 为准：generate / edit（`index.js:141-142`），不是 image。 */
export const SAMPLE_ROUTES = {
  generate: { primary: { providerId: 'default', model: 'qwen-image-3.0' }, fallback: { providerId: '', model: '' } },
  edit: { primary: { providerId: 'default', model: 'qwen-image-3.0' }, fallback: { providerId: '', model: '' } },
}

/** 设置页写入的用户配置（providers + 路由 + 连接超时）。 */
export function sampleConfig(overrides = {}) {
  return {
    providers: structuredClone(SAMPLE_PROVIDERS),
    activeProviderId: 'default',
    modelRoutes: structuredClone(SAMPLE_ROUTES),
    connectTimeoutSeconds: 15,
    ...overrides,
  }
}

/**
 * 用户层的行，形状与 `dsh-config-editor` 写出来的一致。
 *
 * `name` 的三种取值各有含义，所以**不能用默认参数表达"省略"**——JS 里
 * `f({ name: undefined })` 会触发默认值，那是踩过一次的坑：
 *   - 不传 / 传 `undefined` → 默认写当前包名（设置页写出的正常形状）
 *   - 传 `null`             → 显式不带 name 限定（早期手写/旧写入器的形状）
 *   - 传具体字符串          → 用那个包名限定（用来构造"改名只改一半"）
 */
export function userRow({ id = 'image-bridge-v4', name, config, disabled } = {}) {
  const row = { id }
  if (name !== null) row.name = name ?? 'kkj520-dsh-image-bridge'
  if (disabled !== undefined) row.disabled = disabled
  if (config !== undefined) row.config = config
  return row
}

/**
 * 插件 bundle 层：它的 `cordis.patch.yml` 只 `insert` 一行。
 * `config` 省略即"补丁里不写 config、默认值交给 schema"（当前仓库的实际写法）。
 */
export function bundleLayer({ id = 'image-bridge-v4', name = 'kkj520-dsh-image-bridge', config } = {}) {
  return [{ insert: [{ id, name, ...(config === undefined ? {} : { config }) }] }]
}

let composeEntriesPromise

/** 惰性加载真实的 `composeEntries`（从 dsh 安装目录，路径全部现场推导）。 */
export async function loadComposeEntries() {
  composeEntriesPromise ??= (async () => {
    const bin = resolveDshBin()
    const root = join(bin, '..', '..')
    const entry = join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
    if (!existsSync(entry)) {
      throw new Error(`找不到 @deepseek-ai/dsh-app-boot（试过 ${entry}）。请设置 DSH_BIN 指向 dsh 的 lib/bin.js。`)
    }
    const mod = await import(pathToFileURL(entry).href)
    if (typeof mod.composeEntries !== 'function') {
      throw new Error('dsh-app-boot 没有导出 composeEntries，验收无法在真实合成算法上运行')
    }
    return mod.composeEntries
  })()
  return composeEntriesPromise
}

/**
 * 按「profile 启动时的层序」合成一次：各 bundle 层 → 用户层 → 附加层。
 * 返回合成后的行、该 id 命中的行、以及合成告警（`name mismatch` / `entry not found` 都在这里）。
 */
export async function composeProfile({ bundles = [], user = [], extra = [], targetId = 'image-bridge-v4' } = {}) {
  const composeEntries = await loadComposeEntries()
  const warnings = []
  const rows = composeEntries([...bundles, ...user, ...extra], (message) => warnings.push(message))
  const matches = rows.filter((row) => row.id === targetId)
  return {
    rows,
    matches,
    /** 运行时实际生效的是最后一条（`applyEntryPatches` 逐条覆盖后 entryMap 以后者为准）。 */
    effective: matches.at(-1),
    warnings,
    skipped: warnings.filter((warning) => warning.includes('name mismatch')),
  }
}

/**
 * 三级回退与插件一致（`index.js` 的 `activeProviderOf`）：
 * `activeProviderId` 命中 → `providers[0]` → 旧字段。
 */
export function effectiveConfigOf(row) {
  const config = row?.config ?? {}
  const providers = Array.isArray(config.providers) ? config.providers : []
  const requested = typeof config.activeProviderId === 'string' ? config.activeProviderId : ''
  const hit = providers.find((provider) => provider?.id === requested)
  const provider = hit ?? providers[0]
  if (provider !== undefined) {
    return {
      level: hit !== undefined ? 'active' : 'first',
      id: provider.id,
      baseUrl: provider.baseUrl,
      keyRef: provider.keyRef,
      imageModel: provider.imageModel === '' || provider.imageModel === undefined ? config.model : provider.imageModel,
      editModel: provider.editModel === '' || provider.editModel === undefined ? (provider.imageModel ?? config.model) : provider.editModel,
      modelRoutes: config.modelRoutes,
      connectTimeoutSeconds: config.connectTimeoutSeconds,
    }
  }
  return {
    level: 'legacy',
    id: '',
    baseUrl: config.baseUrl,
    keyRef: 'DSH_IMAGE_BRIDGE_API_KEY',
    imageModel: config.model,
    editModel: config.editModel ?? config.model,
    modelRoutes: config.modelRoutes,
    connectTimeoutSeconds: config.connectTimeoutSeconds,
  }
}

/** 一个极简断言收集器：`check('...', cond, detail)` + 末尾 `summary()`。 */
export function createChecks() {
  const results = []
  return {
    results,
    check(name, condition, detail) {
      const ok = Boolean(condition)
      results.push({ name, ok })
      console.log(`${ok ? 'ok   ' : 'FAIL '} ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
      return ok
    },
    summary() {
      const failed = results.filter((entry) => !entry.ok)
      console.log(`\nSUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
      process.exitCode = failed.length === 0 ? 0 : 1
      return failed.length
    },
  }
}
