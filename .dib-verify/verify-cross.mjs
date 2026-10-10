/**
 * 交叉验证：插件对着「独立进程」的模拟生图接口跑一遍完整管线。
 *
 * verify-host.mjs 用的是同进程内的模拟服务；这里换成 mock-image-api.mjs 这个真实监听
 * 端口的服务，确认用户照着说明填上地址后确实能跑通。
 * 用法：先 `node .dib-verify/mock-image-api.mjs 8799`，再运行本脚本。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_DIR } from './dsh-paths.mjs'

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
