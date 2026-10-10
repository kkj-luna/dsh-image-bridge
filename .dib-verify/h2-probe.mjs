import http2 from 'node:http2'
const origin = 'https://<provider-host>'
const path = '/compatible-mode/v1/images/generations'
const client = http2.connect(origin)
client.on('connect', (session, socket) => {
  console.log('ALPN 协商结果:', socket.alpnProtocol ?? '(none)')
})
client.on('error', (e) => console.log('session error:', e.message, e.code ?? ''))
await new Promise((resolve) => {
  const timer = setTimeout(() => { console.log('h2 请求超时'); resolve() }, 15000)
  let settled = false
  const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } }
  const req = client.request({
    ':method': 'POST',
    ':path': path,
    'content-type': 'application/json',
    authorization: 'Bearer probe-key-not-real',
  })
  let status = null
  req.on('response', (headers) => { status = headers[':status']; console.log('h2 响应状态:', status) })
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => { console.log('h2 响应体:', body.slice(0, 200).replace(/\s+/g, ' ')); done() })
  req.on('error', (e) => { console.log('h2 请求错误:', e.message, e.code ?? ''); done() })
  req.write(JSON.stringify({ model: 'gpt-image-1', prompt: 'probe' }))
  req.end()
})
client.close()
