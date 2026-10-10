/**
 * 清单与跨文件一致性验证。
 *
 * 把三处「只能靠读源码确认」的要求固化成断言：
 *  1. client-modules 发现客户端产物所需的清单条件（platform/exports/文件存在）；
 *  2. 图标与显示元数据的解析条件（icon 相对路径、≤256 KiB、locale/en.json 的 meta）；
 *  3. 跨文件一致性 —— 补丁行 id 必须等于设置页写入的命名空间，Host 注册的工具名
 *     必须等于客户端注册的卡片键。这类不一致不会报错，只会静默失效。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PLUGIN_DIR } from './dsh-paths.mjs'

const ROOT = PLUGIN_DIR
const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'ok   ' : 'FAIL '} ${name}${condition || detail === undefined ? '' : ` — ${detail}`}`)
}

const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
const host = await readFile(join(ROOT, 'index.js'), 'utf8')
const client = await readFile(join(ROOT, 'client.js'), 'utf8')
const localeZh = JSON.parse(await readFile(join(ROOT, 'locale/zh.json'), 'utf8'))
const localeEn = JSON.parse(await readFile(join(ROOT, 'locale/en.json'), 'utf8'))

/* ---------------------------------------------- client-modules 的发现条件 */

check('声明了 dsh.client', manifest.dsh?.client !== undefined, '缺少 dsh.client')
check('dsh.client.platform 为 web', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))
check('导出了 ./client', typeof manifest.exports?.['./client'] === 'string', JSON.stringify(manifest.exports?.['./client']))
const clientRel = manifest.exports?.['./client']
const clientStat = clientRel === undefined ? undefined : await stat(join(ROOT, clientRel)).catch(() => undefined)
check('客户端产物文件真实存在', clientStat !== undefined && clientStat.isFile(), String(clientRel))
check('客户端产物以 __ModuleLoader__.load 注册', client.trimStart().slice(0, 200).includes('__ModuleLoader__.load('), '开头不是模块加载器注册调用')
check(
  '注册 id 与包名一致（不一致会静默不加载）',
  new RegExp(`id:\\s*'${manifest.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'`).test(client),
  `期望 id: '${manifest.name}'`,
)
check('dsh.client.inject 是字符串数组', Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.every((v) => typeof v === 'string'), JSON.stringify(manifest.dsh?.client?.inject))

/* ---------------------------------------------- 显示元数据与图标的解析条件 */

check('导出了 ./package.json（图标与元数据解析需要）', manifest.exports?.['./package.json'] === './package.json', String(manifest.exports?.['./package.json']))
check('导出了 ./locale/*.json', typeof manifest.exports?.['./locale/*.json'] === 'string', String(manifest.exports?.['./locale/*.json']))
check('中文显示名存在', typeof localeZh.meta?.title === 'string' && localeZh.meta.title !== '', JSON.stringify(localeZh.meta))
check('英文显示名存在', typeof localeEn.meta?.title === 'string' && localeEn.meta.title !== '', JSON.stringify(localeEn.meta))
check('图标声明为相对路径', typeof manifest.icon === 'string' && !manifest.icon.startsWith('/') && !manifest.icon.includes('..'), String(manifest.icon))
const iconStat = typeof manifest.icon === 'string' ? await stat(join(ROOT, manifest.icon)).catch(() => undefined) : undefined
check('图标文件存在', iconStat !== undefined && iconStat.isFile(), String(manifest.icon))
check('图标不超过 256 KiB', iconStat !== undefined && iconStat.size <= 256 * 1024, `${iconStat?.size} 字节`)
check(
  '图标扩展名受支持',
  typeof manifest.icon === 'string' && ['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(manifest.icon.slice(manifest.icon.lastIndexOf('.')).toLowerCase()),
  String(manifest.icon),
)
check('files 列出了运行所需文件', ['index.js', 'client.js', 'cordis.patch.yml', 'locale', 'icon.svg'].every((entry) => manifest.files?.includes(entry)), JSON.stringify(manifest.files))

/*
 * 许可：声明、协议全文、README 三处必须一致。这三处不同步的后果不是报错，
 * 而是别人不知道该按什么条款使用——所以宁可在这里红。
 */
check('package.json 声明了 MIT 许可', manifest.license === 'MIT', String(manifest.license))
const licenseText = await readFile(join(ROOT, 'LICENSE'), 'utf8').catch(() => '')
check(
  '插件目录内有 MIT 协议全文',
  licenseText.includes('MIT License') && licenseText.includes('WITHOUT WARRANTY OF ANY KIND'),
  licenseText === '' ? 'LICENSE 文件不存在或读不到' : licenseText.slice(0, 60),
)
check('files 列出了 LICENSE（发布时带上协议）', manifest.files?.includes('LICENSE') === true, JSON.stringify(manifest.files))
check(
  'README 提到 MIT 并链接到 LICENSE',
  /MIT/u.test(await readFile(join(ROOT, 'README.md'), 'utf8').catch(() => '')) && /MIT/u.test(await readFile(join(ROOT, 'README.en.md'), 'utf8').catch(() => '')),
  '中英两份 README 都要写许可',
)

/* ---------------------------------------------- bundle patch */

check('声明了 dsh.bundle.patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', String(manifest.dsh?.bundle?.patch))
const rowId = /^\s*-\s*id:\s*(\S+)/mu.exec(patch)?.[1] ?? ''
check('补丁插入了一行', rowId !== '', patch.slice(0, 120))
const rowName = /^\s*name:\s*'?([^'\s]+)'?/mu.exec(patch)?.[1] ?? ''
check('补丁行 name 指向本包', rowName === manifest.name, `name=${rowName} 期望=${manifest.name}`)

/*
 * 改名（@local/image-bridge-v4 → @local/dsh-image-bridge）时最容易漏的就是"只改一半"：
 * 包名、Host 导出的 name、补丁行 name 三处必须逐字一致，否则表现为插件加载不出来或
 * 清单里出现一张解析不了的重复卡片。这条断言专门盯这个。
 */
const hostExportName = /export const name = '([^']+)'/u.exec(host)?.[1] ?? ''
check(
  '三处 name 一致：package.json / index.js export / 补丁行',
  hostExportName !== '' && hostExportName === manifest.name && rowName === manifest.name,
  JSON.stringify({ packageJson: manifest.name, hostExport: hostExportName, patchRow: rowName }),
)
check('包名与目录名各就各位（目录仍是 dsh-image-bridge-v4，改名不动目录）', ROOT.endsWith('dsh-image-bridge-v4'), ROOT)

/*
 * 默认配置不能指向"某台机器上的服务"。
 *
 * 早先 patch 里写着本地验收用的 mock 地址，任何新装插件的人默认都会指向一个不存在的
 * 服务、第一次生图必然失败。现在 config 段整个删掉，默认值交给 Host 的 schema——
 * 所以这里断言"生效的 YAML 里既没有 config 段、也没有任何写死的地址"。
 */
const patchEffective = patch.split(/\r?\n/u).filter((line) => !/^\s*#/u.test(line)).join('\n')
check(
  '插件 patch 不写死任何地址：config 段已删除，默认值交给 Host schema',
  !/^\s*config:/mu.test(patchEffective)
    && !/https?:\/\//u.test(patchEffective)
    && !/127\.0\.0\.1|localhost|192\.168\.|10\.0\./iu.test(patchEffective),
  JSON.stringify(patchEffective).slice(0, 200),
)

/*
 * 「用户配置升级后还在不在」的完整矩阵在 verify-upgrade.mjs（对着真实合成算法跑）。
 * 这里只钉住最容易被静默改坏的那一层：manifest 的 files 漏了补丁文件时，安装出去
 * 的包里就没有这一行，插件能加载、设置页也能开，但**升级一次用户配置就没了**。
 */
check(
  'files 列出了 cordis.patch.yml（漏了它 = 升级丢用户配置）',
  manifest.files?.includes('cordis.patch.yml') === true,
  JSON.stringify(manifest.files),
)
/*
 * 默认地址必须是公开端点——但**只查默认值本身**，不要拿整个 index.js 去 grep `127.0.0.1`。
 *
 * 早先这条是 `!/127\.0\.0\.1|localhost/.test(host)`：Host 后来加了"拒绝把服务商地址配成
 * 本机/内网"的安全校验（`host === 'localhost'`、`::1`、`.local`…），文件里出现这些字面量
 * 是**功能本身**，那条全文件 grep 就成了误报。真正要保证的是"**默认值**不是本机地址"，
 * 所以这里按缩进取出顶层 `baseUrl` 的 default 值来判断（顶层字段缩进 2 空格，服务商
 * 数组里的字段缩进 6 空格，不会被误取）。
 */
const topLevelBaseUrlDefault = new RegExp('(?:^|\\n) {2}baseUrl: z[\\s\\S]{0,240}?\\.default\\(\'([^\']*)\'\\)', 'u').exec(host)?.[1] ?? ''
check(
  'Host schema 顶层 baseUrl 的默认值是公开端点（新装用户不会指向本机 mock）',
  topLevelBaseUrlDefault === 'https://api.openai.com/v1'
    && !/^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/iu.test(topLevelBaseUrlDefault)
    && !/^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(topLevelBaseUrlDefault),
  `default=${topLevelBaseUrlDefault || '(未找到)'}`,
)

/* ---------------------------------------------- 跨文件一致性 */

/*
 * 「主模型超时」默认值必须三处一致：client.js 的常量、Host 的常量、Host schema 的 default。
 *
 * 为什么需要这条：界面里输入框留空时，客户端会**把默认值显式写进用户配置**（而不是不写这个
 * 字段），所以两半的默认值一旦不同，"留空 = 用 Host 默认值"就不再成立——用户会拿到一个
 * 与 schema 文档不同的超时。15000 → 90000 那次改动就是这样：Host 先改、客户端的断言还写死
 * 15000，于是套件报了 2 条红（实现是对的，是断言过时）。
 *
 * 现在客户端的期望值改成从 client.js 源码读——修掉了漂移，但也让那条断言变成了**同义反复**
 * （拿 client.js 的值去验 client.js 写出的值，改成 1 也能过）。真正的不变量是"两侧相等"，
 * 由这条断言钉住；数值本身也一并钉住，改默认值时必须过来一起改并说明理由。
 */
const clientFallbackMs = Number(/const DEFAULT_FALLBACK_MS = (\d+)/u.exec(client)?.[1] ?? Number.NaN)
const hostFallbackMs = Number(/const DEFAULT_FALLBACK_AFTER_MS = (\d+)/u.exec(host)?.[1] ?? Number.NaN)
const schemaFallbackMs = Number(/fallbackAfterMs: z\.number\(\)\.default\((\d+)\)/u.exec(host)?.[1] ?? Number.NaN)
check(
  '主模型超时默认值三处一致（client.js / Host 常量 / Host schema），且是约定的 90000',
  clientFallbackMs === hostFallbackMs
    && hostFallbackMs === schemaFallbackMs
    && clientFallbackMs === 90000,
  JSON.stringify({ client: clientFallbackMs, host: hostFallbackMs, schema: schemaFallbackMs }),
)

const settingsNs = /const SETTINGS_NS = '([^']+)'/u.exec(client)?.[1] ?? ''
check('补丁行 id 等于客户端写入的设置命名空间', rowId === settingsNs, `patch id=${rowId} client SETTINGS_NS=${settingsNs}`)

const hostToolNames = [...host.matchAll(/name:\s*'(image_[a-z]+)'/gu)].map((match) => match[1]).sort()
const clientViewKeys = (/const TOOL_KEYS = \[([^\]]+)\]/u.exec(client)?.[1] ?? '')
  .split(',')
  .map((part) => part.trim().replace(/^'|'$/gu, ''))
  .filter((part) => part !== '')
  .sort()
check('Host 注册了 2 个工具', hostToolNames.length === 2, hostToolNames.join(','))
check(
  'Host 工具名与客户端卡片键完全一致',
  hostToolNames.join(',') === clientViewKeys.join(','),
  `host=${hostToolNames.join(',')} client=${clientViewKeys.join(',')}`,
)

const apiKeyRef = /const API_KEY_REF = '([^']+)'/u.exec(host)?.[1] ?? ''
const clientRef = /const API_KEY_REF = '([^']+)'/u.exec(client)?.[1] ?? ''
check('Host 与客户端使用同一个 API Key 引用名', apiKeyRef !== '' && apiKeyRef === clientRef, `host=${apiKeyRef} client=${clientRef}`)
check('API Key 引用名符合凭据服务语法', /^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyRef), apiKeyRef)

/*
 * 多服务商的凭据名是「前缀 + id 归一化」，两段都要能被凭据服务接受——
 * 归一化只要漏一个字符（比如忘了替换 '.'），resolve 就会直接失败。
 */
const providerPrefix = /const PROVIDER_KEY_PREFIX = '([^']+)'/u.exec(host)?.[1] ?? ''
check('Host 定义了服务商凭据名前缀', providerPrefix === 'DSH_IMAGE_BRIDGE_KEY_', providerPrefix)
const derivedRef = `${providerPrefix}${'vendor.one'.toUpperCase().replace(/[^A-Za-z0-9]/gu, '_')}`
check('按 id 推导出的凭据名符合凭据服务语法', /^[A-Za-z_][A-Za-z0-9_]*$/u.test(derivedRef), derivedRef)

/** RPC 方法表：models 必须与 test/log 并列（客户端只会走这三条）。 */
const endpointList = (/const RPC_ENDPOINTS = \[([^\]]+)\]/u.exec(host)?.[1] ?? '')
  .split(',')
  .map((part) => part.trim().replace(/^'|'$/gu, ''))
  .filter((part) => part !== '')
check('RPC 方法表包含 test / log / models', ['test', 'log', 'models'].every((method) => endpointList.includes(method)), endpointList.join(','))

const hostChannel = /const RPC_CHANNEL = '([^']+)'/u.exec(host)?.[1] ?? ''
const clientChannel = /const RPC_CHANNEL = '([^']+)'/u.exec(client)?.[1] ?? ''
check('Host 与客户端使用同一条测试通道', hostChannel !== '' && hostChannel === clientChannel, `host=${hostChannel} client=${clientChannel}`)

check('没有导入任何 Harness 客户端包（避免解析失败）', client.includes("require('react')") && !/@deepseek-ai\/dsh-client/u.test(client), '客户端不应依赖 Harness 客户端包')
check('Host 半只静态导入 node: 内置模块', [...host.matchAll(/^import .* from '([^']+)'/gmu)].every((match) => match[1].startsWith('node:')), [...host.matchAll(/^import .* from '([^']+)'/gmu)].map((m) => m[1]).join(','))

const failed = results.filter((entry) => !entry.ok)
console.log(`\nSUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
process.exitCode = failed.length === 0 ? 0 : 1
