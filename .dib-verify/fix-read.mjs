import { readFileSync, writeFileSync } from 'node:fs'
const path = '<workspace>/plugins/dsh-image-bridge-v4/index.js'
let text = readFileSync(path, 'utf8')
const from = `      const rows = service.describe()
      if (Array.isArray(rows)) {
        const usable = rows.filter((item) => item !== null && typeof item === 'object'
          && item.value !== null && typeof item.value === 'object'
          && typeof item.value.baseUrl === 'string' && item.value.baseUrl.trim() !== '')
        for (const ns of candidates) {
          const row = usable.find((item) => item.ns === ns)
          if (row !== undefined) return { config: normalizedConfig(row.value), source: \`settings:\${row.ns}\` }
        }
        if (usable.length > 0) return { config: normalizedConfig(usable[0].value), source: \`settings(扫描):\${usable[0].ns}\` }
      }`
if (!text.includes(from)) { console.log('!! 未找到待替换块'); process.exit(1) }
const to = `      const described = service.describe()
      /*
       * 两种形状都要认：
       *   · 设置服务直接把行数组交出来（SettingsForms.describe 的原样返回）；
       *   · 远程命名空间信封 { writable, namespaces: [{ ns, value }] }——客户端读到的就是这个，
       *     一开始只认数组，于是明明数据在、工具却读不到，回退成了 Schema 默认值。
       */
      const rows = Array.isArray(described)
        ? described
        : (described !== null && typeof described === 'object' && Array.isArray(described.namespaces) ? described.namespaces : [])
      const valueOf = (row) => (row.value ?? row.values ?? row.config ?? null)
      const usable = rows.filter((item) => {
        const value = item !== null && typeof item === 'object' ? valueOf(item) : null
        return value !== null && typeof value === 'object' && typeof value.baseUrl === 'string' && value.baseUrl.trim() !== ''
      })
      for (const ns of candidates) {
        const row = usable.find((item) => item.ns === ns)
        if (row !== undefined) return { config: normalizedConfig(valueOf(row)), source: \`settings:\${row.ns}\` }
      }
      if (usable.length > 0) return { config: normalizedConfig(valueOf(usable[0])), source: \`settings(扫描):\${usable[0].ns}\` }`
text = text.replace(from, to)
writeFileSync(path, text)
console.log('已修正设置读取（兼容两种形状）')
