import { readFileSync, writeFileSync } from 'node:fs'
const path = '<workspace>/plugins/dsh-image-bridge-v4/index.js'
let text = readFileSync(path, 'utf8')
const from = `  } catch (error) {
    note(\`设置服务注册失败：\${String(error?.message ?? error)}\`)
  }
  ctx.on('loader/volatile-update', () => {`
if (!text.includes(from)) { console.log('!! 未找到'); process.exit(1) }
// note 定义在后面，这里不能引用它（TDZ）——保持静默，失败也不影响工具可用性。
text = text.replace(from, `  } catch {
    /* 设置服务不可用时不阻断插件：读取逻辑本身还有 fiber 与挂载参数两级回退 */
  }
  ctx.on('loader/volatile-update', () => {`)
writeFileSync(path, text)
console.log('已移除 note 的提前引用')
