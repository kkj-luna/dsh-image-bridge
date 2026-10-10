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

/* ---------------------------------------------- bundle patch */

check('声明了 dsh.bundle.patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', String(manifest.dsh?.bundle?.patch))
const rowId = /^\s*-\s*id:\s*(\S+)/mu.exec(patch)?.[1] ?? ''
check('补丁插入了一行', rowId !== '', patch.slice(0, 120))
const rowName = /^\s*name:\s*'?([^'\s]+)'?/mu.exec(patch)?.[1] ?? ''
check('补丁行 name 指向本包', rowName === manifest.name, `name=${rowName} 期望=${manifest.name}`)

/* ---------------------------------------------- 跨文件一致性 */

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
