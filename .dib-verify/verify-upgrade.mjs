/**
 * 升级保配置验收。
 *
 * 要回答的是产品问题，不是代码问题：
 *   「插件更新/改名/重装之后，用户在设置页存下的 API 服务商配置还在不在？」
 *
 * 为什么值得单独一套断言：这件事**在各自的测试里永远是绿的**——
 * Host 读配置读得到、客户端写配置写得对，但用户配置并不存在插件里，而是存在 profile
 * 那一行上；能不能读回来取决于三个"身份"（行 id、补丁行 name、包名）与合成规则，
 * 而这三样任何一处改动都不会让插件自身的测试失败，只会让用户悄悄丢配置。
 *
 * 全部结论来自对真实合成算法的实测，不采信注释与自述。见 `upgrade-harness.mjs`。
 */
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { PLUGIN_DIR } from './dsh-paths.mjs'
import { bundleLayer, composeProfile, createChecks, effectiveConfigOf, sampleConfig, userRow } from './upgrade-harness.mjs'

const NS = 'image-bridge-v4'
const checks = createChecks()
const { check } = checks

const manifest = JSON.parse(await readFile(join(PLUGIN_DIR, 'package.json'), 'utf8'))
const patch = await readFile(join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8')
const host = await readFile(join(PLUGIN_DIR, 'index.js'), 'utf8')

const patchBody = patch.split(/\r?\n/u).filter((line) => !/^\s*#/u.test(line)).join('\n')
const patchRowId = /^\s*-\s*id:\s*'?([^'\s]+)'?/mu.exec(patchBody)?.[1] ?? ''
const patchRowName = /^\s*name:\s*'?([^'\s]+)'?/mu.exec(patchBody)?.[1] ?? ''
const hostExportName = /export const name = '([^']+)'/u.exec(host)?.[1] ?? ''
const clientEntry = await readFile(join(PLUGIN_DIR, 'client.js'), 'utf8')
const clientModuleId = /^\s*id:\s*'([^']+)'/mu.exec(clientEntry)?.[1] ?? ''

/** 合成一次"最平常的一次升级"：包名与行 id 都不动，只有插件代码变了。 */
async function plainUpgrade(userLayer = userRow({ config: sampleConfig() }), bundleConfig) {
  return composeProfile({
    bundles: [bundleLayer({ id: NS, name: manifest.name, ...(bundleConfig === undefined ? {} : { config: bundleConfig }) })],
    user: [userLayer],
    targetId: NS,
  })
}

/* ─────────────────────────────────────────── ① 保配置的三个身份 */

check('补丁行 id 等于设置命名空间', patchRowId === NS, `patch=${patchRowId}`)
check(
  '补丁行 name 与包名逐字一致（name 不匹配会让用户整行 patch 被跳过）',
  patchRowName === manifest.name,
  `patch=${patchRowName} package.json=${manifest.name}`,
)
check('Host 导出的 name 与包名逐字一致', hostExportName === manifest.name, `index.js=${hostExportName}`)
check('浏览器模块 id 与包名逐字一致（不一致 = 设置页整块消失且无报错）', clientModuleId === manifest.name, `client.js=${clientModuleId}`)

/* ─────────────────────────────────────────── ② 普通升级：代码变了，配置不能变 */

const baseline = await plainUpgrade()
check('普通升级：用户配置行仍然命中（没有被 name 跳过）', baseline.skipped.length === 0, baseline.warnings.join(' | '))
check(
  '普通升级：providers 零漂移',
  isDeepStrictEqual(baseline.effective?.config?.providers, sampleConfig().providers),
  JSON.stringify(baseline.effective?.config?.providers),
)
check(
  '普通升级：modelRoutes 零漂移',
  isDeepStrictEqual(baseline.effective?.config?.modelRoutes, sampleConfig().modelRoutes),
  JSON.stringify(baseline.effective?.config?.modelRoutes),
)
check('普通升级：fallbackAfterMs 保留', baseline.effective?.config?.fallbackAfterMs === 15000, String(baseline.effective?.config?.fallbackAfterMs))

/* ─────────────────────────────────────────── ③ 版本号与默认值的变化不应该影响用户配置 */

const bumped = await plainUpgrade(userRow({ config: sampleConfig() }), { size: '512x512', model: 'brand-new-default' })
check(
  '插件改默认值（含新增字段）：用户 config 逐键覆盖，默认值不会混进来',
  isDeepStrictEqual(bumped.effective?.config?.providers, sampleConfig().providers)
    && bumped.effective?.config?.size === undefined
    && bumped.effective?.config?.model === undefined,
  JSON.stringify({ size: bumped.effective?.config?.size, model: bumped.effective?.config?.model }),
)
check(
  '结论：用户没写过的字段既不会丢、也不会从新默认值继承（新增字段必须靠代码内兜底）',
  isDeepStrictEqual(Object.keys(bumped.effective?.config ?? {}).sort(), ['activeProviderId', 'fallbackAfterMs', 'modelRoutes', 'providers']),
  Object.keys(bumped.effective?.config ?? {}).join(','),
)

/* ─────────────────────────────────────────── ④ 改名：只有"两边同时改"才安全 */

const renamedBothSides = await composeProfile({
  bundles: [bundleLayer({ id: NS, name: '@local/image-bridge-v5' })],
  user: [userRow({ name: '@local/image-bridge-v5', config: sampleConfig() })],
  targetId: NS,
})
check(
  '改名且 profile 行与新包名同步：配置完整保留',
  renamedBothSides.skipped.length === 0 && isDeepStrictEqual(renamedBothSides.effective?.config?.providers, sampleConfig().providers),
)
const staleName = await composeProfile({
  bundles: [bundleLayer({ id: NS, name: '@local/image-bridge-v5' })],
  user: [userRow({ name: '@local/image-bridge-v4', config: sampleConfig() })],
  targetId: NS,
})
check(
  '改名但 profile 行还是旧包名：整行被跳过 —— 这就是会丢配置的真实原因',
  staleName.skipped.length === 1,
  staleName.warnings.join(' | '),
)
check('旧包名的用户行：providers 确实读不到了（不是静默通过）', staleName.effective?.config?.providers === undefined)
check('旧包名的用户行：产生可诊断的告警，而不是无声失败', staleName.warnings.length > 0, staleName.warnings.join(' | '))
const noNameRow = await composeProfile({
  bundles: [bundleLayer({ id: NS, name: '@local/image-bridge-v5' })],
  user: [userRow({ name: null, config: sampleConfig() })],
  targetId: NS,
})
check(
  '用户行没有 name 限定时按 id 命中：改名对它无害',
  noNameRow.skipped.length === 0 && isDeepStrictEqual(noNameRow.effective?.config?.providers, sampleConfig().providers),
)

/* ─────────────────────────────────────────── ⑤ 改行 id：配置会变孤儿 */

const idChanged = await composeProfile({
  bundles: [bundleLayer({ id: 'image-bridge-v5', name: manifest.name })],
  user: [userRow({ id: NS, config: sampleConfig() })],
  targetId: NS,
})
check('行 id 一改，旧配置行就是孤儿（新行只有默认值）', idChanged.effective === undefined)
check('行 id 一改：告警明确说 entry not found', idChanged.warnings.some((warning) => warning.includes('not found')), idChanged.warnings.join(' | '))

/* ─────────────────────────────────────────── ⑥ 禁用→重装→重新启用 */

const disabledThenEnabled = await composeProfile({
  bundles: [bundleLayer({ id: NS, name: manifest.name })],
  user: [userRow({ disabled: false, config: sampleConfig() })],
  targetId: NS,
})
check(
  '禁用后又重新启用：凭据配置跟着回来（用户行的 config 始终在 profile 文件里）',
  isDeepStrictEqual(disabledThenEnabled.effective?.config?.providers, sampleConfig().providers),
)

/* ─────────────────────────────────────────── ⑦ 从旧字段升级到多服务商 */

const legacyRow = await composeProfile({
  bundles: [bundleLayer({ id: NS, name: manifest.name })],
  user: [userRow({ config: { baseUrl: 'https://legacy.example/v1', model: 'legacy-image' } })],
  targetId: NS,
})
const legacyEffective = effectiveConfigOf(legacyRow.effective)
check('只有旧 baseUrl/model 时三级回退落在 legacy', legacyEffective.level === 'legacy', legacyEffective.level)
check(
  '旧配置升级后旧字段仍然生效（不会"看起来丢了"）',
  legacyEffective.baseUrl === 'https://legacy.example/v1' && legacyEffective.imageModel === 'legacy-image',
  JSON.stringify({ baseUrl: legacyEffective.baseUrl, imageModel: legacyEffective.imageModel }),
)
const multiProviderEffective = effectiveConfigOf(baseline.effective)
check('配了服务商时三级回退落在 active（不会被旧字段抢走）', multiProviderEffective.level === 'active', multiProviderEffective.level)
check(
  '生效的服务商带着自己的地址与凭据名（凭据不跨服务商回退）',
  multiProviderEffective.baseUrl === sampleConfig().providers[0].baseUrl
    && multiProviderEffective.keyRef === sampleConfig().providers[0].keyRef,
  JSON.stringify({ baseUrl: multiProviderEffective.baseUrl, keyRef: multiProviderEffective.keyRef }),
)

/* ─────────────────────────────────────────── ⑧ 密钥本身与插件升级解耦 */

const keyRefs = [...host.matchAll(/const API_KEY_REF = '([^']+)'|const PROVIDER_KEY_PREFIX = '([^']+)'/gu)]
  .map((match) => match[1] ?? match[2])
  .filter((value) => value !== undefined)
check(
  '密钥引用名只由常量 + provider.id 派生，不写进配置行',
  keyRefs.length >= 2 && !patchBody.includes(keyRefs[0]),
  JSON.stringify(keyRefs),
)
check(
  '凭据名符合凭据服务语法（升级不会让名字变非法）',
  keyRefs.every((value) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)),
  JSON.stringify(keyRefs),
)

checks.summary()
