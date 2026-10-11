// 重写 CHANGELOG：v0.2.1 收录 tag 之后的全部变更，v0.2.0 只保留它发布时的原文。
//
// 为什么用脚本：v0.2.0 的正文以 git 里 `b64ac83:CHANGELOG.md` 为**权威**（不要手抄，
// 手抄就会出现"文档与历史不一致"这种最难查的问题）。脚本只做搬运与拼接。
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './dsh-paths.mjs'

/** 取 b64ac83 那一版 CHANGELOG（v0.2.0 发布时的真实内容）。 */
const historical = execFileSync('git', ['show', 'b64ac83:CHANGELOG.md'], { cwd: ROOT, encoding: 'utf8' })
const current = require('node:fs').readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')

// 从历史原文里切出 v0.2.0 与 v0.1.0 两段
const startV020 = historical.indexOf('## v0.2.0')
const startV010 = historical.indexOf('## v0.1.0')
const header = historical.slice(0, startV020)
const bodyV020 = historical.slice(startV020, startV010).trimEnd()
const bodyV010 = historical.slice(startV010).trimEnd()

/*
 * 从当前文件里切出 v0.2.1 的正文（即 `## v0.2.1` 到 `## v0.2.0` 之间），
 * 它已经写好了，直接复用，不做二次编辑。
 */
const curV021 = current.indexOf('## v0.2.1')
const curV020 = current.indexOf('## v0.2.0')
const v021Body = current.slice(curV021, curV020).trimEnd()

const next = `${header}${v021Body}\n\n${bodyV020}\n\n${bodyV010}\n`
writeFileSync(join(ROOT, 'CHANGELOG.md'), next, 'utf8')

// 自检：两份版本号必须都还在，且 v0.2.1 在最前
const order = ['## v0.2.1', '## v0.2.0', '## v0.1.0'].map((marker) => next.indexOf(marker))
console.log(`写入完成：${next.split('\n').length} 行`)
console.log(`版本顺序正确: ${order[0] > 0 && order[0] < order[1] && order[1] < order[2]}`)
console.log(`v0.2.0 段行数: ${bodyV020.split('\n').length}（应与 b64ac83 原文一致）`)
console.log(`v0.2.1 段行数: ${v021Body.split('\n').length}`)
