# 生图桥（dsh-image-bridge）

给 DeepSeek Harness 用的插件：让没有生图能力的大模型通过外部生图模型完成**绘图**与**改图**，并在 Web 界面里通过点击配置接口地址与 API Key。

- 生图 `image_generate` → `{baseUrl}/images/generations`
- 改图 `image_edit` → `{baseUrl}/images/edits`（multipart 上传参考图）
- 图片会成为对话里的持久附件，同时另存到会话工作区的 `generated-images/`
- 支持多个服务商：每个服务商各自的接口地址、密钥与所选模型，界面上可测试连接、拉取可用模型并从中选择

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `plugins/dsh-image-bridge-v4/` | **当前生效的插件**（Host 半 `index.js`、客户端半 `client.js`、语言包、图标、README） |
| `.dib-verify/` | 测试与验收套件：`verify-*.mjs`、`dsh-paths.mjs`（路径推导）、`mock-image-api.mjs`（本地模拟生图接口） |
| `generated-images/` | 生图插件的落盘输出（已在 `.gitignore` 中忽略） |
| `dsh-image-bridge/`、`image-bridge/`、`plugins/dsh-image-bridge{,-live,-v3}/` | **历史副本**：已被 `plugins/dsh-image-bridge-v4/` 取代，**仅本地保留、不纳入版本控制**（在 `.gitignore` 里）。别在这里改代码 |

插件的详细文档见 [plugins/dsh-image-bridge-v4/README.md](plugins/dsh-image-bridge-v4/README.md)。

## 跑测试

在仓库根目录直接跑（Windows / macOS / Linux 都一样）：

```bash
node .dib-verify/verify-manifest.mjs   # 清单与跨文件一致性
node .dib-verify/verify-client.mjs     # 客户端注册形状 + 组件渲染
node .dib-verify/verify-host.mjs       # Host 端到端
node .dib-verify/verify-resolve.mjs    # 依赖解析健壮性

# 跨进程端到端（先起本地模拟接口）
node .dib-verify/mock-image-api.mjs 8799   # 另开一个终端
node .dib-verify/verify-cross.mjs
```

脚本里的路径**全部现场推导**，仓库里没有写死任何机器路径：被测插件目录相对脚本自身定位（可用 `DIB_PLUGIN_DIR` 指到别处的副本）；dsh 的安装位置按 `DSH_BIN` → 全局 npm 前缀 → `require.resolve` 依次找；profile 目录按 `DSH_PROFILE_DIR` → `$DSH_HOME/profiles`（默认 `~/.dsh/profiles`，优先 `web`）依次找。找不到时脚本会直接报错并告诉你要设哪个环境变量，不会静默跳过。前提是这台机器装了 dsh（`npm i -g @deepseek-ai/dsh`）。

## 安装

用 Harness 的插件管理器安装该目录（`plugin_manager` 的 `install_bundle`，target 传绝对路径 `plugins/dsh-image-bridge-v4`）。插件行 id 为 `image-bridge-v4`，同时就是它的设置命名空间。

## 已知待办

- 历史副本（`dsh-image-bridge/`、`image-bridge/`、`plugins/dsh-image-bridge{,-live,-v3}/`）已停止跟踪并写进 `.gitignore`，但**仍留在本机磁盘上**：本机 Harness profile 里可能还有指向它们的 link 依赖，删除磁盘文件会弄坏正在跑的插件。确认不再需要后可以自行删。
- profile 里可能仍留有早期改名产生的惰性依赖记录，功能无影响。
- 设置页左侧导航的图标由 Harness 外壳按 section id 硬编码选择（`navIcon(id)` 只认 `account` / `models` / `agent-presets` / `plugins` / `archived-sessions`，其余一律齿轮兜底），插件侧的 `icon` 管不到导航栏。本插件采用**社区通行的"认领自己那一行"方案**（插件市场、`dsh-better-sidebar`、`dsh-skill-mcp-panel` 同法）：挂载后只给"标签等于本插件本地化名称"的那一行打标记并注入遮罩样式，把齿轮换成自己的单色标记，**随插件分发、所有用户可见**；对话框没开、选择器匹配不到等情况下静默降级回齿轮，卸载时标记与样式一并移除。这是**权宜之计**：等 `settings.section` 支持 `icon` 字段后，应改回官方能力（详见插件 README 的「三、配置」）。

