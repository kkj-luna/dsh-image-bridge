import { readFileSync } from 'node:fs'
const raw = readFileSync('C:/Users/<user>/.dsh/.credentials.yaml', 'utf8')
const m = /DSH_IMAGE_BRIDGE_API_KEY:\s*(.+)/.exec(raw)
if (m === null) { console.log('凭据里没有该 Key'); process.exit(0) }
let key = m[1].trim()
if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1)
console.log('key 长度:', key.length, '| 前缀:', key.slice(0, 3) + '...', '| 含非 ASCII:', /[^\x20-\x7e]/.test(key))

const url = 'https://<provider-endpoint>/v1/images/generations'
const body = JSON.stringify({ model: 'gpt-image-1', prompt: '一只戴宇航头盔的柴犬，扁平插画风格', size: '1024x1024' })
try {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body })
  const text = await r.text()
  console.log('HTTP', r.status)
  console.log(text.slice(0, 300).replace(/\s+/g, ' '))
} catch (error) {
  const parts = []
  let c = error
  while (c) { parts.push(`${c.name}: ${c.message}${c.code ? ` [${c.code}]` : ''}`); c = c.cause }
  console.log('抛错:', parts.join('  <-  '))
}
