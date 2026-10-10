import { readFileSync } from 'node:fs'
const raw = readFileSync('C:/Users/<user>/.dsh/.credentials.yaml', 'utf8')
const m = /DSH_IMAGE_BRIDGE_API_KEY:\s*(.+)/.exec(raw)
let key = m === null ? 'probe' : m[1].trim()
if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1)

const base = 'https://<provider-endpoint>/v1'
const auth = { authorization: `Bearer ${key}` }
const describe = (error) => {
  const parts = []
  let c = error
  while (c) { parts.push(`${c.name}: ${c.message}${c.code ? ` [${c.code}]` : ''}`); c = c.cause }
  return parts.join('  <-  ')
}

// ① 先做一次和「测试连接」一样的 GET（共用同一个连接池）
try {
  const g = await fetch(`${base}/models`, { method: 'GET', headers: auth })
  console.log('GET  /models →', g.status, '(连接已进入连接池)')
  await g.text()
} catch (error) { console.log('GET 失败:', describe(error)) }

// ② 紧接着做生图 POST —— 与插件里完全相同的顺序
try {
  const r = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'gpt-image-1', prompt: '一只戴宇航头盔的柴犬', size: '1024x1024' }),
  })
  console.log('POST 第一次 →', r.status, (await r.text()).slice(0, 120).replace(/\s+/g, ' '))
} catch (error) { console.log('POST 第一次 失败:', describe(error)) }

// ③ 立刻重试一次
try {
  const r2 = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'gpt-image-1', prompt: '一只戴宇航头盔的柴犬', size: '1024x1024' }),
  })
  console.log('POST 重试 →', r2.status, (await r2.text()).slice(0, 120).replace(/\s+/g, ' '))
} catch (error) { console.log('POST 重试 失败:', describe(error)) }
