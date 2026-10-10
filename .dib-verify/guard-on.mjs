import { readFileSync, writeFileSync } from 'node:fs'
const path = '<workspace>/plugins/dsh-image-bridge-v4/index.js'
let text = readFileSync(path, 'utf8')
const from = `  ctx.on('loader/volatile-update', () => {
    const next = effectiveConfigOf(ctx, config)
    resolved = next.config
    configSource = next.source
  })`
if (!text.includes(from)) { console.log('!! 未找到'); process.exit(1) }
text = text.replace(from, `  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      const next = effectiveConfigOf(ctx, config)
      resolved = next.config
      configSource = next.source
    })
  }`)
writeFileSync(path, text)
console.log('已为 ctx.on 加守卫')
