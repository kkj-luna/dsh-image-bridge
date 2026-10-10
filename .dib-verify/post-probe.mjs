const url = 'https://<provider-endpoint>/v1/images/generations'
try {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer probe-key-not-real' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt: 'probe' }),
  })
  console.log('HTTP', r.status, (await r.text()).slice(0, 200).replace(/\s+/g, ' '))
} catch (error) {
  const parts = []
  let c = error
  while (c) { parts.push(`${c.name}: ${c.message}${c.code ? ` [${c.code}]` : ''}`); c = c.cause }
  console.log('失败:', parts.join('  <-  '))
}
