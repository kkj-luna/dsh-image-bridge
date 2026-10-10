const url = 'https://<provider-endpoint>/v1/images/generations'
const prompt = '一只戴宇航头盔的柴犬，扁平插画风格，干净的浅色背景'
const body = JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024' })
console.log('body bytes:', Buffer.byteLength(body))
try {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer probe-key-not-real' },
    body,
  })
  console.log('HTTP', r.status, (await r.text()).slice(0, 160).replace(/\s+/g, ' '))
} catch (error) {
  const parts = []
  let c = error
  while (c) { parts.push(`${c.name}: ${c.message}${c.code ? ` [${c.code}]` : ''}`); c = c.cause }
  console.log('失败:', parts.join('  <-  '))
}
