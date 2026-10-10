import { readFileSync, writeFileSync } from 'node:fs'
const path = '<workspace>/plugins/dsh-image-bridge-v4/index.js'
let text = readFileSync(path, 'utf8')
const hits = [...text.matchAll(/function effectiveConfigOf\(/g)].map((m) => m.index)
console.log('找到 effectiveConfigOf 声明数:', hits.length)
if (hits.length > 1) {
  const at = hits[hits.length - 1]
  const start = text.lastIndexOf('/**', at)
  const end = text.indexOf('\n}\n', at) + 3
  text = text.slice(0, start) + text.slice(end)
  writeFileSync(path, text)
  console.log('已删除最后一份（旧实现）')
}
const after = [...readFileSync(path, 'utf8').matchAll(/function effectiveConfigOf\(/g)].length
console.log('剩余声明数:', after)
