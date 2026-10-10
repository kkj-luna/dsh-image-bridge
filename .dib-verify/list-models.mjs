import { readFileSync } from 'node:fs'
const raw = readFileSync('C:/Users/<user>/.dsh/.credentials.yaml', 'utf8')
const m = /DSH_IMAGE_BRIDGE_API_KEY:\s*(.+)/.exec(raw)
if (m === null) { console.log('凭据里没有 Key'); process.exit(0) }
let key = m[1].trim()
if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1)
const base = 'https://<provider-endpoint>/v1'
const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } })
console.log('HTTP', r.status)
const body = await r.json().catch(() => null)
const ids = body && Array.isArray(body.data) ? body.data.map((x) => x && x.id).filter(Boolean) : []
console.log('模型总数:', ids.length)
const imageish = ids.filter((id) => /wanx|image|flux|kolors|t2i|stable|dall|seedream|hunyuan/i.test(id))
console.log('可能可生图的模型:')
for (const id of imageish) console.log('  -', id)
console.log('（前 25 个模型，供参考）')
for (const id of ids.slice(0, 25)) console.log('  *', id)
