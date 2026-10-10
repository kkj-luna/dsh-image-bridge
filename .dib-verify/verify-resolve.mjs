/**
 * 依赖解析的健壮性验证。
 *
 * 同一个 index.js 在不同环境信息下分别加载一次，确认只要有一条路可用，
 * Config 就能投影出来；全不可用时插件仍应加载成功（只是没有配置表单），
 * 并写下可定位的自诊断。用查询串制造不同的模块 URL，避免 ESM 缓存把多次加载合并。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_DIR, resolveDshBin, resolveProfileDir } from './dsh-paths.mjs'

/*
 * 路径全部现场推导（DSH_BIN / DSH_PROFILE_DIR / DSH_HOME / 全局 npm 前缀），
 * 仓库里不写死开发机路径；推不出来就抛错并说明该设哪个环境变量。
 */
const ROOT = PLUGIN_DIR
const DSH_BIN = resolveDshBin()
const PROFILE = resolveProfileDir()
/** 用一个明显不存在的 CLI 入口，模拟"只靠 DSH_PROFILE_DIR"的场景。 */
const NOT_DSH = join(tmpdir(), 'not-dsh', 'not-dsh.js')

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) })
  console.log(`${condition ? 'ok   ' : 'FAIL '} ${name}${condition || detail === undefined ? '' : ` — ${detail}`}`)
}

async function loadWith(caseName, { profileDir, argv1 }) {
  if (profileDir === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = profileDir
  delete process.env.DSH_HOME
  const originalArgv = process.argv
  process.argv = ['node', argv1]
  try {
    return await import(`${pathToFileURL(`${ROOT}/index.js`).href}?case=${caseName}`)
  } finally {
    process.argv = originalArgv
  }
}

/* 场景一：只有 profile 环境变量可用（CLI 入口是临时脚本，找不到 dsh 安装树）。 */
const onlyProfile = await loadWith('profile', { profileDir: PROFILE, argv1: NOT_DSH })
check('仅凭 DSH_PROFILE_DIR 能拿到 Config', onlyProfile.Config !== undefined, 'Config 为 undefined')

/* 场景二：没有任何环境变量，只靠 CLI 入口定位 dsh 安装目录。 */
const onlyArgv = await loadWith('argv', { profileDir: undefined, argv1: DSH_BIN })
check('仅凭 CLI 入口位置能拿到 Config（不依赖环境变量）', onlyArgv.Config !== undefined, 'Config 为 undefined')

/* 场景三：两条路都断了——插件仍必须能加载，只是没有配置表单。 */
const neither = await loadWith('none', { profileDir: undefined, argv1: NOT_DSH })
check('解析全失败时模块仍可加载', typeof neither.apply === 'function' && typeof neither.name === 'string', '模块加载失败')
check('解析全失败时 Config 为 undefined（优雅降级）', neither.Config === undefined, 'Config 意外存在')

/* 降级时必须写下可定位的自诊断，而不是只留一条日志。 */
const diagHome = await mkdtemp(join(tmpdir(), 'dib-diag-'))
process.env.DSH_HOME = diagHome
const warnings = []
/** 只提供 tools：真实 Host 里它是硬依赖，其余服务故意缺失以走降级路径。 */
const stubTools = { register: () => () => {} }
const fakeCtx = {
  get: (name) => (name === 'tools' ? stubTools : undefined),
  tools: stubTools,
  inject: () => () => {},
  effect: (fn) => fn(),
  logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
}
neither.apply(fakeCtx, {})
await new Promise((done) => setTimeout(done, 500))
let diagnostic = null
try {
  diagnostic = JSON.parse(await readFile(join(diagHome, 'dsh-image-bridge-degraded.json'), 'utf8'))
} catch {
  diagnostic = null
}
check('降级时写出了自诊断文件', diagnostic !== null, '文件不存在')
check('自诊断记录了每条解析尝试', Array.isArray(diagnostic?.attempts) && diagnostic.attempts.length > 0, JSON.stringify(diagnostic?.attempts))
check('自诊断记录了环境事实', diagnostic?.environment !== undefined && Array.isArray(diagnostic.environment.argv), '')
check('降级时也写了日志', warnings.some((line) => line.includes('schemastery')), warnings.join(' | '))
await rm(diagHome, { recursive: true, force: true })

const failed = results.filter((entry) => !entry.ok)
console.log(`\nSUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`)
process.exitCode = failed.length === 0 ? 0 : 1
