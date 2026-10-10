const base = 'https://<provider-endpoint>/v1'
function chain(error) {
  const out = []
  let c = error
  while (c) { out.push(`${c.name ?? "?"}: ${c.message ?? c}${c.code ? ` (${c.code})` : ""}`); c = c.cause }
  return out.join("  <-  ")
}
for (const [label, url, init] of [
  ['GET  /models', `${base}/models`, { method: 'GET' }],
  ['POST /images/generations', `${base}/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-1', prompt: 'probe' }) }],
]) {
  try {
    const r = await fetch(url, init)
    const text = await r.text()
    console.log(`${label} → HTTP ${r.status}  ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
  } catch (error) {
    console.log(`${label} → 失败: ${chain(error)}`)
  }
}
