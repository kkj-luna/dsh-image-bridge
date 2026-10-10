/**
 * 可移植的路径推导。
 *
 * 仓库里**不写死任何开发机路径**：插件目录由本文件的位置推出来，dsh 的安装位置与
 * profile 目录从环境变量 / 常见安装前缀里找。找不到时抛出带操作指引的错误——宁可
 * 明确失败，也不要静默跳过验收，更不要回退到别人的路径。
 *
 * 可用环境变量：
 *   DIB_PLUGIN_DIR   覆盖被测插件目录（默认：<仓库>/plugins/dsh-image-bridge-v4）
 *   DSH_BIN          dsh CLI 入口，指向 <前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js
 *   DSH_PROFILE_DIR  要用的 profile 目录
 *   DSH_HOME         dsh 家目录（默认 ~/.dsh），用于在 <DSH_HOME>/profiles 下找 profile
 */
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 被测插件目录（仓库内的默认位置，可用 DIB_PLUGIN_DIR 覆盖到别处的副本）。 */
export const PLUGIN_DIR = (() => {
  const override = process.env.DIB_PLUGIN_DIR
  return override !== undefined && override !== ''
    ? resolve(override)
    : resolve(HERE, '..', 'plugins', 'dsh-image-bridge-v4')
})()

/** dsh 家目录：DSH_HOME 优先，否则 ~/.dsh。 */
export function dshHome() {
  const home = process.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}

/** npm 全局前缀的候选（不调 npm：执行策略/权限都可能挡掉它）。 */
function globalPrefixes() {
  const prefixes = []
  if (process.env.npm_config_prefix) prefixes.push(process.env.npm_config_prefix)
  if (process.env.APPDATA) prefixes.push(join(process.env.APPDATA, 'npm')) // Windows 默认
  if (process.env.USERPROFILE) prefixes.push(join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm'))
  prefixes.push(join(homedir(), '.npm-global'), '/usr/local', '/usr')
  return prefixes
}

const HOW_TO_SET_DSH_BIN = [
  '找不到 dsh（@deepseek-ai/dsh）的安装位置，无法运行这项验收。',
  '请设置环境变量 DSH_BIN 指向 dsh 的 CLI 入口，例如：',
  '  Windows:  set DSH_BIN=%APPDATA%\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  '  POSIX:    export DSH_BIN="$(npm root -g)/@deepseek-ai/dsh/lib/bin.js"',
  '（前提是这台机器已经 `npm i -g @deepseek-ai/dsh`。）',
].join('\n')

/**
 * dsh CLI 入口的绝对路径。
 *
 * 顺序：`DSH_BIN` → 各全局前缀下的 node_modules → 从本文件做一次 require.resolve。
 * 全都找不到就抛错（附上面那段操作指引），绝不静默跳过。
 */
export function resolveDshBin() {
  const candidates = []
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN)
  for (const prefix of globalPrefixes()) {
    candidates.push(join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  try {
    candidates.push(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js'))
  } catch {
    // 仓库自身没装 dsh 依赖时解析不到，走上面的全局前缀候选。
  }
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    throw new Error(`${HOW_TO_SET_DSH_BIN}\n试过这些位置：\n  ${candidates.join('\n  ')}`)
  }
  return found
}

const HOW_TO_SET_PROFILE = [
  '找不到 dsh 的 profile 目录。',
  '请设置环境变量 DSH_PROFILE_DIR 指向要用的 profile，例如：',
  '  Windows:  set DSH_PROFILE_DIR=%USERPROFILE%\\.dsh\\profiles\\web',
  '  POSIX:    export DSH_PROFILE_DIR="$HOME/.dsh/profiles/web"',
  '（也可以只设 DSH_HOME 指向 dsh 家目录，脚本会在 <DSH_HOME>/profiles 下挑一个。）',
].join('\n')

/**
 * profile 目录。
 *
 * 顺序：`DSH_PROFILE_DIR` → `<DSH_HOME 或 ~/.dsh>/profiles/` 下第一个像 profile 的目录
 * （优先 `web`）。都没有就抛错并说明该设哪个变量。
 */
export function resolveProfileDir() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) {
      throw new Error(`${HOW_TO_SET_PROFILE}\nDSH_PROFILE_DIR 当前指向的目录不存在：${explicit}`)
    }
    return explicit
  }
  const base = join(dshHome(), 'profiles')
  const names = existsSync(base)
    ? readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : []
  const ordered = [...names.filter((name) => name === 'web'), ...names.filter((name) => name !== 'web')]
  const looksLikeProfile = (dir) => existsSync(join(dir, 'cordis.yml')) || existsSync(join(dir, 'package.json'))
  const found = ordered.map((name) => join(base, name)).find(looksLikeProfile)
  if (found === undefined) {
    throw new Error(`${HOW_TO_SET_PROFILE}\n试过：${base}（${names.length === 0 ? '目录不存在或为空' : names.join(', ')}）`)
  }
  return found
}
