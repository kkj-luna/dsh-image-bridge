import { readFileSync } from 'node:fs'
const raw = readFileSync('C:/Users/<user>/.dsh/.credentials.yaml', 'utf8')
const m = /DSH_IMAGE_BRIDGE_API_KEY:\s*(.+)/.exec(raw)
if (m === null) { console.log('未找到'); process.exit(0) }
let v = m[1].trim()
if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
console.log('长度:', v.length)
console.log('含空白:', /\s/.test(v))
console.log('含非ASCII:', /[^\x20-\x7e]/.test(v))
console.log('首字符是字母数字:', /^[A-Za-z0-9]/.test(v))
