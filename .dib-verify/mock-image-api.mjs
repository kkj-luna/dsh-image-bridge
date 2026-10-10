/**
 * 本地模拟生图接口 —— 零成本验证用。
 *
 * 提供一个 OpenAI 兼容的图片接口，返回真实可解码的 PNG（不是占位文本），
 * 这样「设置页保存 → 测试连接 → 模型调用 image_generate → 图片在对话里显示」
 * 这条完整链路可以不用真实密钥、不产生任何费用地跑通。
 *
 * 用法：node .dib-verify/mock-image-api.mjs [port]
 * 然后在「设置 → 生图桥」里填：
 *   接口地址：http://127.0.0.1:8799/v1
 *   生图模型：mock-image
 *   API Key ：任意非空字符串
 */
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'

const PORT = Number(process.argv[2] ?? 8799)
const HOST = '127.0.0.1'

/* ------------------------------------------------------------- PNG 合成 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 画一张带渐变与网格的真实 PNG，便于肉眼确认它确实来自外部接口。 */
function makePng(width, height, seed) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const wave = Math.sin((x / width) * Math.PI * 2 + seed) * 0.5 + 0.5
      const grid = (x % 64 < 2 || y % 64 < 2) ? 40 : 0
      raw[offset] = Math.min(255, Math.round(wave * 200) + grid)
      raw[offset + 1] = Math.min(255, Math.round((y / height) * 220) + grid)
      raw[offset + 2] = Math.min(255, Math.round((1 - wave) * 180) + grid)
      offset += 3
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------- 服务 */

let counter = 0

function readBody(request) {
  return new Promise((done) => {
    const chunks = []
    request.on('data', (c) => chunks.push(c))
    request.on('end', () => done(Buffer.concat(chunks)))
  })
}

const server = createServer(async (request, response) => {
  const url = String(request.url ?? '')
  const json = (status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  }

  if (request.method === 'GET' && url.startsWith('/v1/models')) {
    console.log(`[mock] GET ${url} → 200`)
    return json(200, { object: 'list', data: [{ id: 'mock-image', object: 'model' }] })
  }

  if (request.method === 'POST' && (url.startsWith('/v1/images/generations') || url.startsWith('/v1/images/edits'))) {
    const body = await readBody(request)
    const isEdit = url.startsWith('/v1/images/edits')
    const auth = String(request.headers.authorization ?? '')
    counter += 1
    const png = makePng(512, 512, counter)
    console.log(`[mock] POST ${url} auth=${auth === '' ? '(none)' : 'present'} bytes=${body.length} → 200 (${png.length}B png #${counter})`)
    return json(200, {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: png.toString('base64'), revised_prompt: `mock ${isEdit ? 'edit' : 'generation'} #${counter}` }],
    })
  }

  console.log(`[mock] ${request.method} ${url} → 404`)
  return json(404, { error: { message: `no route for ${request.method} ${url}` } })
})

server.listen(PORT, HOST, () => {
  console.log(`模拟生图接口已启动：http://${HOST}:${PORT}/v1`)
  console.log('  设置 → 生图桥：')
  console.log(`    接口地址：http://${HOST}:${PORT}/v1`)
  console.log('    生图模型：mock-image')
  console.log('    API Key ：任意非空字符串')
  console.log('停用请按 Ctrl+C。')
})
