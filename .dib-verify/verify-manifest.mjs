/**
 * 清单与跨文件一致性验证。
 *
 * 把三处「只能靠读源码确认」的要求固化成断言：
 *  1. client-modules 发现客户端产物所需的清单条件（platform/exports/文件存在）；
 *  2. 图标与显示元数据的解析条件（icon 相对路径、≤256 KiB、locale/en.json 的 meta）；
 *  3. 跨文件一致性 —— 补丁行 id 必须等于设置页写入的命名空间，Host 注册的工具名
 *     必须等于客户端注册的卡片键。这类不一致不会报错，只会静默失效。
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_DIR, resolveDshBin } from './dsh-paths.mjs'

const ROOT = PLUGIN_DIR
/*
 * 必须在**第一次 import index.js 之前**把 CLI 入口指向 dsh 本体：插件用 `loadOptional` 在
 * **模块作用域**解析 `@deepseek-ai/dsh-tools`，解析不到就**不注册任何工具**（宁可少给，也不给
 * 一个参数 schema 静默失效的工具）。所以这条赋值放在最前面，晚一行都太晚——那会让下面
 * "真的 apply 一遍并捕获注册"的断言全部落空（踩过）。verify-host / verify-cross 同样处理。
 */
process.argv[1] = resolveDshBin()
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
/*
 * **真的把 Host 半载进来执行**，而不是 grep 源码。
 *
 * 这正是"看起来在验、其实没人验"的解药：`OUTPUT` 被导出就是为了这个（见 index.js 里那段
 * 注释）；断言直接调 `OUTPUT.render(...)`，块的内容与顺序都是真跑出来的。
 */
const { OUTPUT } = await import(pathToFileURL(join(ROOT, 'index.js')).href)

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
 * SVG 必须是**良构 XML**：注释里不许出现连续两个连字符，也不许以连字符结尾。
 *
 * 为什么值得单独一条：浏览器对 SVG 很宽容，所以本机、插件列表里都能正常显示——**只有**严格
 * 解析器（librsvg、GitHub 的 sanitizer）会拒绝，表现为「README 里内嵌这个 SVG 变成破图」这种
 * 远端现象。这条坑真实发生过一次：注释里写了两个 CSS 变量名，仓库 README 的 logo 就一直是破图，
 * 而本机怎么看都正常。纯文本规则，不依赖任何图像库。
 */
{
  const svgText = iconStat === undefined ? '' : await readFile(join(ROOT, manifest.icon ?? 'icon.svg'), 'utf8').catch(() => '')
  const comments = [...svgText.matchAll(/<!--([\s\S]*?)-->/gu)].map((match) => match[1])
  const offenders = comments.filter((body) => body.includes('--') || body.endsWith('-'))
  check(
    'icon.svg 是良构 XML：注释里没有连续连字符（严格解析器会因此拒绝整个文件）',
    svgText !== '' && comments.length > 0 && offenders.length === 0,
    offenders.length === 0
      ? `注释 ${comments.length} 块，全部合规`
      : `有 ${offenders.length} 块注释违规，例如：${(offenders[0].split('\n').find((line) => line.includes('--')) ?? '').trim().slice(0, 80)}`,
  )
  check(
    'icon.svg 有根元素与 viewBox（可缩放、且能被当作图标渲染）',
    /<svg[\s>]/u.test(svgText) && /viewBox="[^"]+"/u.test(svgText),
    svgText.slice(0, 80),
  )
}

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

/*
 * 版本号的**单一事实来源**是 package.json；CHANGELOG 的首条必须是它。
 * 升版本时少改一处不会有任何报错，只会让人对着两份不同的版本号猜哪个是真的。
 */
const changelog = await readFile(join(ROOT, '..', '..', 'CHANGELOG.md'), 'utf8').catch(() => '')
const changelogTop = /^##\s+v?([0-9]+\.[0-9]+\.[0-9]+)/mu.exec(changelog)?.[1] ?? ''
check(
  'CHANGELOG 首条版本 = package.json 的 version',
  changelogTop !== '' && changelogTop === manifest.version,
  `changelog=${changelogTop || '(没读到)'} package.json=${manifest.version}`,
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

/* ---------------------------------------------- 工具结果的 content 结构（真执行 render） */

/*
 * 为什么这行字必须写在 `content` 里（写给以后来问"为什么不放界面"的人）：
 *   对话稳定后平台手上只剩 `content`（= `OUTPUT.render` 的返回值）与 `meta`（只有本插件注册的
 *   keyed toolview 会读）。而 keyed toolview 稳定后被包进一个高度为 0 的滚动容器、屏幕上看不见；
 *   稳定可见的是**平台按 content 渲染的原生卡片**（用户看到的图片与文件行就是它）。
 *   证据：`dsh-tools/lib/types/index.js` 的 `createSuccessResult()`（`content =
 *   snapshotProjection(name, 'render', rendered)`）、`dsh-tool-fs/lib/index.js` 的
 *   "The canonical value never crosses the wire — only the model-facing render text and this
 *   JSON `meta`"、客户端派发点 `dsh-client-ui-tool` 的 `renderCall`/`renderSlot("tool.call.toolview")`。
 *
 * 代价：这是**模型可见**输出，模型会多读到一行。所以文案刻意语言中立（`model: <名字>`），
 * 值必须是 `value.model`（真正产出这张图的模型），绝不能用 `args.model`（用户请求的模型）。
 */
const renderValue = {
  model: 'gpt-image-2.5',
  prompt: '一只猫',
  images: [{ attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 10, width: 1, height: 1, name: 'a.png' }],
  savedPaths: ['E:\\w\\generated-images\\a.png'],
  imageCapable: true,
}
const renderBlocks = OUTPUT.render({ prompt: '一只猫', model: 'requested-model-ignored' }, renderValue)
const modelBlocks = renderBlocks.filter((block) => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('model: '))
check(
  '① render 末尾追加 `model: <真实值>`，且取 value.model 而不是 args.model',
  modelBlocks.length === 1
    && modelBlocks[0].text === 'model: gpt-image-2.5'
    && !renderBlocks.some((block) => typeof block.text === 'string' && block.text.includes('requested-model-ignored')),
  JSON.stringify(renderBlocks.map((block) => (block.type === 'text' ? block.text.slice(0, 40) : block.type))).slice(0, 200),
)
check(
  '② 该文本块在**所有** image 块之后（原生卡片按序渲染 → 落在图片下方）',
  renderBlocks[renderBlocks.length - 1] === modelBlocks[0]
    && renderBlocks.filter((block) => block.type === 'image').length === 1
    && renderBlocks.findIndex((block) => block === modelBlocks[0]) > renderBlocks.findIndex((block) => block.type === 'image'),
  renderBlocks.map((block) => block.type).join(','),
)
check(
  '③ value.model 为空 / 非字符串 / 只有空白时**一个块都不追加**（不会出现空的 `model: `）',
  ['', '   ', undefined, null, 42].every((model) => {
    const blocks = OUTPUT.render({}, { ...renderValue, model })
    return blocks.length === 2 && blocks.every((block) => block.type !== 'text' || !block.text.startsWith('model: '))
  }),
  JSON.stringify(['', '   ', undefined, null, 42].map((model) => OUTPUT.render({}, { ...renderValue, model }).length)),
)

/* ---------------------------------------------- 面向模型的说明（system prompt 段落） */

/*
 * 用户最终选的方案是"由模型在对话里说明这张图是谁生成的"。机制有两半，缺一不可：
 *   ① Host 在结果 content 末尾带一行 `model: <实际使用的模型名>`（上面①②③已钉住）；
 *   ② **有一段面向模型的说明告诉模型去做这件事**——没被告知的模型不会主动转述。
 *
 * ② 的承载通道按 `agent-experience` 的判断选了 **system prompt 段落**（`systemPrompt.section`），
 * 而不是把工具 description 写长：description 回答"这个工具做什么"，而"每次用完都要转述"是
 * 跨调用的会话级要求；同一件事只说一次，两个工具的 schema 因此每轮少 102 字符。
 *
 * 下面**真的调用 apply**（导出 `apply` / `MODEL_ATTRIBUTION_NOTE` 就是为了这个），用最小 ctx
 * 捕获 `systemPrompt.section(...)` 与 `tools.register(...)`：捕获到什么就断言什么，不 grep 源码。
 * 注意两点必要性（踩过）：① 必须像 verify-host/verify-cross 那样把 `process.argv[1]` 指向
 * dsh 本体，否则 `defineTool` 解析不到、工具与说明段都不会注册；② 把 `DSH_HOME` 指到临时目录，
 * 免得 apply 往真实 home 写启动自述。
 */
const { apply, MODEL_ATTRIBUTION_NOTE } = await import(pathToFileURL(join(ROOT, 'index.js')).href)
const previousDshHome = process.env.DSH_HOME
const sectionDshHome = await mkdtemp(join(tmpdir(), 'dib-manifest-'))
process.env.DSH_HOME = sectionDshHome
const capturedSections = []
const capturedTools = []
let applyFailure = null
try {
  const captureCtx = {
    get(key) {
      if (key === 'systemPrompt') {
        return { section(section) { capturedSections.push(section); return () => {} } }
      }
      if (key === 'tools') {
        return { register(definition) { capturedTools.push(definition); return () => {} } }
      }
      return undefined
    },
    inject: () => () => {},
    effect: (fn) => {
      try {
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      } catch {
        return () => {}
      }
    },
    on: () => () => {},
    emit: () => {},
  }
  await apply(captureCtx, { baseUrl: 'http://127.0.0.1:9/v1', model: 'manifest-probe', size: '512x512' })
} catch (error) {
  applyFailure = error
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(sectionDshHome, { recursive: true, force: true }).catch(() => {})
}

const attributionSection = capturedSections.find((section) => section.name === 'dsh-image-bridge/model-attribution')
check(
  '① 说明文案含三层要求：结果里有 `model:` 行 + **每次**都要在回复里说明所用模型 + 备用接管时说明',
  MODEL_ATTRIBUTION_NOTE.includes('model: <实际使用的模型名>')
    && MODEL_ATTRIBUTION_NOTE.includes('每次')
    && MODEL_ATTRIBUTION_NOTE.includes('请在回复里说明')
    && MODEL_ATTRIBUTION_NOTE.includes('备用'),
  MODEL_ATTRIBUTION_NOTE,
)
check(
  '② apply 时真的注册了这段 system prompt 段落（名字/顺序/关闭插值/文案逐字一致）',
  applyFailure === null
    && attributionSection !== undefined
    && attributionSection.order === 3050
    && attributionSection.interpolate === false
    && attributionSection.text === MODEL_ATTRIBUTION_NOTE,
  `apply=${applyFailure === null ? 'ok' : String(applyFailure?.message)} sections=[${capturedSections.map((s) => s.name).join(',')}]`,
)
check(
  '③ 两个工具都注册了，且**编译后**的参数契约未变（名字 + 参数字段名集合）',
  capturedTools.map((tool) => tool.name).sort().join(',') === 'image_edit,image_generate'
    && Object.keys(capturedTools.find((tool) => tool.name === 'image_generate')?.parameters?.properties ?? {}).join(',') === 'prompt,size,model'
    && Object.keys(capturedTools.find((tool) => tool.name === 'image_edit')?.parameters?.properties ?? {}).join(',') === 'prompt,image_path,size,model',
  JSON.stringify(capturedTools.map((tool) => `${tool.name}:${Object.keys(tool.parameters?.properties ?? {}).join('|')}`)),
)
check(
  '④ 同一事实只说一次：说明文案**没有**被塞进两个工具的 description',
  capturedTools.length === 2
    && capturedTools.every((tool) => typeof tool.description === 'string' && !tool.description.includes('model: <实际使用的模型名>')),
  JSON.stringify(capturedTools.map((tool) => tool.description?.slice(0, 30))),
)

/* ---------------------------------------------- 跨文件一致性 */

/*
 * 连接超时**以秒声明**：Host 常量与 schema 默认值都必须是 15。
 *
 * 为什么钉数值："15 秒连不上就换备用"是产品决策（用户按秒填，代码内部自动换算毫秒），
 * 改它就得过来一起改并说明理由。
 *
 * 为什么还要钉"旧字段真的没了"：`fallbackAfterMs`（按响应时间换备用那套）已按用户要求整体
 * 删除，改成"只看连接"。它若残留（schema 里还有定义、代码里还有人读），界面上就会出现一个
 * 填了没用的旋钮——这正是这次重构要消灭的东西。
 */
const defaultConnectSeconds = Number(/const DEFAULT_CONNECT_TIMEOUT_S = (\d+)/u.exec(host)?.[1] ?? Number.NaN)
const schemaConnectSeconds = Number(/connectTimeoutSeconds: z[\s\S]{0,160}?\.default\((\d+)\)/u.exec(host)?.[1] ?? Number.NaN)
check(
  '连接超时以秒声明：Host 常量与 schema 默认值都是 15，且 fallbackAfterMs 已彻底移除',
  defaultConnectSeconds === 15
    && schemaConnectSeconds === defaultConnectSeconds
    && !/fallbackAfterMs/u.test(host)
    && !/DEFAULT_FALLBACK_AFTER_MS/u.test(host),
  JSON.stringify({ constant: defaultConnectSeconds, schema: schemaConnectSeconds }),
)

/*
 * 三处默认值必须一致：client.js 的 `DEFAULT_CONNECT_TIMEOUT_S`、Host 的常量、Host schema 的 default。
 *
 * 为什么需要：设置页留空时客户端会**把默认值显式写进用户配置**（而不是不写这个字段），两半一旦
 * 不同，"留空 = 用 Host 默认值"就不再成立——用户会拿到一个与 schema 文档不同的连接超时。
 * 15000 → 90000 那次改动就是这样：Host 先改、客户端的期望值还写死旧值，套件报红的是断言过时。
 */
const clientConnectSeconds = Number(/const DEFAULT_CONNECT_TIMEOUT_S = (\d+)/u.exec(client)?.[1] ?? Number.NaN)
check(
  '连接超时默认值三处一致（client.js / Host 常量 / Host schema），且是约定的 15 秒',
  clientConnectSeconds === defaultConnectSeconds
    && defaultConnectSeconds === schemaConnectSeconds
    && clientConnectSeconds === 15,
  JSON.stringify({ client: clientConnectSeconds, host: defaultConnectSeconds, schema: schemaConnectSeconds }),
)

/*
 * 备用模型的连接上限固定 30 秒，而且**不能**出现在 schema 里——它是定好的，不是设置项。
 * 判据写成 `xxx: z.` 而不是裸名字：调用点上有 `fallbackConnectMs:`，那是参数不是配置字段。
 */
const fallbackConnectSeconds = Number(/const FALLBACK_CONNECT_TIMEOUT_S = (\d+)/u.exec(host)?.[1] ?? Number.NaN)
check(
  '备用模型的连接上限固定 30 秒，且不是设置项（schema 里没有这个字段）',
  fallbackConnectSeconds === 30 && !/fallbackConnect\w*: z\./u.test(host),
  `FALLBACK_CONNECT_TIMEOUT_S=${Number.isNaN(fallbackConnectSeconds) ? '(未找到)' : fallbackConnectSeconds}`,
)

/*
 * 秒→毫秒的换算**只准发生一次**（`msFromSeconds`），两个工具都必须把用户填的秒交给它。
 *
 * 这条是补历史坑：早先常量与函数默认参数各写一份字面量，改一处另一处照旧；现在唯一的
 * 毫秒换算点就是 msFromSeconds，别处再写一个 `* 1000` 会在这里报红。
 */
const multiplyBy1000 = (host.match(/\* 1000/gu) ?? []).length
check(
  '秒→毫秒只在 msFromSeconds 里换算一次，两个工具都把用户填的秒交给它',
  /function msFromSeconds\(/u.test(host)
    && multiplyBy1000 === 1
    && /primaryConnectMs: msFromSeconds\(live\.connectTimeoutSeconds\)/u.test(host)
    && (host.match(/fallbackConnectMs: msFromSeconds\(FALLBACK_CONNECT_TIMEOUT_S/gu) ?? []).length === 2,
  `乘 1000 次数=${multiplyBy1000}`,
)

/*
 * 「模型连接失败」是用户能看到的失败口径：两家都连不上时必须**以它开头**，后面还要给出
 * 可操作的下一步（去哪儿检查、点哪个按钮）。文案散成"某某失败"就等于把原因留给用户猜。
 */
check(
  '两家都连不上时的错误以「模型连接失败」开头，并指向设置页的「测试连接」',
  /模型连接失败：\$\{primaryReason\}/u.test(host) && /测试连接/u.test(host),
  '未找到 modelConnectFailureNote 的固定前缀',
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
