/**
 * 交叉验证：插件对着「独立进程」的模拟生图接口跑一遍完整管线。
 *
 * verify-host.mjs 用的是同进程内的模拟服务；这里换成 mock-image-api.mjs 这个真实监听
 * 端口的服务，确认用户照着说明填上地址后确实能跑通。
 * 用法：先 `node .dib-verify/mock-image-api.mjs 8799`，再运行本脚本。
 *
 * ⚠️ 那个 mock **要用受管的后台任务起**（`run_in_background`），不要用一次性的
 * `Start-Process`：后者会随父 shell 一起消失，脚本随后失败在"连不上 8799"，看起来像
 * 插件/接口的问题，其实是夹具自己没在跑（踩过一次）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_DIR, resolveDshBin } from './dsh-paths.mjs'

/*
 * 把 CLI 入口指向 dsh 本体，让插件的 `loadOptional` 能解析到真实的 `@deepseek-ai/dsh-tools`。
 *
 * 为什么非做不可：插件现在有一道硬门槛——解析不到 dsh-tools（参数编译不成 JSON Schema）就
 * **不注册任何工具**（宁可不给，也不给一个没有参数说明、不校验参数的残缺工具）。所以本脚本
 * 若不做这一步，`registered` 会是空的，报错是 `Cannot read properties of undefined (reading
 * 'execute')`——看起来像插件坏了，其实只是这个脚本没告诉插件去哪儿找 dsh。
 * verify-host.mjs 早就这么做了，2026-10-11 补上这里（`connectTimeoutSeconds` 那次改动
 * 之后暴露出来的）。
 */
process.argv[1] = resolveDshBin()

const ROOT = PLUGIN_DIR
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8799/v1'
const workRoot = await mkdtemp(join(tmpdir(), 'dib-cross-'))

const registered = []
/** 工具注册表：插件用 `ctx.get('tools')` 判空、再用查到的服务注册，两处都要有。 */
const toolRegistry = { register(definition) { registered.push(definition); return () => {} } }
const services = {
  tools: toolRegistry,
  credentials: { async resolve() { return { value: 'any-non-empty-key', source: 'mock' } } },
  llm: { async resolveModelInfo() { return { inputModalities: ['text'] } } },
  attachments: {
    async saveImage({ data, mediaType, name }) {
      return { attachmentId: 'sha256:cross', mediaType, bytes: data.byteLength, width: 512, height: 512, name }
    },
  },
  connection: { requestRejection: () => undefined },
  webServer: { register: () => () => {} },
}
const scope = {
  get: (name) => services[name],
  tools: toolRegistry,
  effect: (fn) => fn(),
}
const ctx = { get: scope.get, tools: toolRegistry, inject: (_d, cb) => { cb(scope); return () => {} }, effect: (fn) => fn(), logger: { warn: console.warn } }
const exec = {
  signal: undefined,
  agent: {
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    session: { header: { cwd: workRoot }, requestHeader: () => undefined },
  },
}

const mod = await import(`${pathToFileURL(`${ROOT}/index.js`).href}?cross=1`)
mod.apply(ctx, { baseUrl, model: 'mock-image', size: '512x512', saveToWorkspace: true, outputDir: 'generated-images', timeoutMs: 30000 })

/*
 * 先把"工具到底注册上没有"断言清楚，再去用它。
 *
 * 没有这条时，注册失败的表现是下一行的 `Cannot read properties of undefined (reading 'execute')`
 * ——看起来像插件崩了，其实只是没注册。工具为空只有两种可能，两种都能从断言消息一眼找到线索：
 *   ① `@deepseek-ai/dsh-tools` 解析不到 → 插件**故意不注册**（见本文件顶部的接线说明）；
 *   ② 注册分支被跳过（`tools` 服务没挂载 / apply 提前返回）。
 */
assert.deepEqual(
  registered.map((tool) => tool.name).sort(),
  ['image_edit', 'image_generate'],
  `两个工具都应注册，实际 registered=[${registered.map((tool) => tool.name).join(',')}]`
    + '（空 = dsh-tools 解析不到或注册分支被跳过，见本文件顶部接线说明）',
)

const generate = registered.find((tool) => tool.name === 'image_generate')
const value = await generate.execute({ prompt: '交叉验证：一只猫' }, exec)

assert.equal(value.images.length, 1, '应返回 1 张图片')
assert.equal(value.images[0].mediaType, 'image/png', '应为 PNG')
assert.equal(value.images[0].width, 512)
assert.equal(value.images[0].height, 512)
assert.equal(value.imageCapable, false, '纯文本路由应为 false')
assert.equal(value.revisedPrompts[0].startsWith('mock generation'), true, `revised_prompt 应来自模拟服务，实际 ${value.revisedPrompts[0]}`)

const saved = value.savedPaths[0]
const info = await stat(saved)
const bytes = await readFile(saved)
assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '落盘文件应是真实 PNG')
assert.equal(info.size, value.images[0].bytes, '落盘字节数应与附件记录一致')

const text = generate.output.render({}, value).map((block) => block.text ?? '').join('')
assert.equal(text.includes('不支持图片输入'), true, '纯文本路由的文本信封应说明改用文件路径')
assert.equal(text.includes(saved), true, '文本信封应包含落盘路径')

await rm(workRoot, { recursive: true, force: true })
console.log(`交叉验证通过：${baseUrl} → 512x512 PNG（${bytes.length} 字节），已落盘并回调文本信封`)
