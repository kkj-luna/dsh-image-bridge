import { readFileSync, writeFileSync } from 'node:fs'
const path = '<workspace>/plugins/dsh-image-bridge-v4/index.js'
let text = readFileSync(path, 'utf8')
if (text.includes('settings.configure')) { console.log('已打过补丁'); process.exit(0) }
const anchor = `export function apply(ctx, config) {
  const { config: resolved, source: configSource } = effectiveConfigOf(ctx, config)`
if (!text.includes(anchor)) { console.log('!! 未找到锚点'); process.exit(1) }
const block = `${anchor}

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
  } catch (error) {
    note(\`设置服务注册失败：\${String(error?.message ?? error)}\`)
  }
  ctx.on('loader/volatile-update', () => {
    const next = effectiveConfigOf(ctx, config)
    resolved = next.config
    configSource = next.source
  })`
text = text.replace(anchor, block)
text = text.replace('  const { config: resolved, source: configSource } = effectiveConfigOf(ctx, config)', '  let { config: resolved, source: configSource } = effectiveConfigOf(ctx, config)')
writeFileSync(path, text)
console.log('已插入 settings.configure 与 volatile-update 监听')
