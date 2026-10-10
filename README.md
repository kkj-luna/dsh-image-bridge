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
- 设置页左侧导航的图标由 Harness 外壳按 section id 硬编码选择，第三方 section 一律显示通用齿轮；`icon.svg` 只作用于插件市场/插件清单等读取清单图标的位置。想让导航里也显示专属字形，只能改外壳（见下一节）。

## 本机外壳补丁：导航里给「生图桥」专属字形

**为什么必须改外壳**：设置页左侧导航的字形不是来自插件清单，而是外壳里一张按 section id 硬编码的查表——`navIcon(id)` 只认 `account` / `models` / `agent-presets` / `plugins` / `archived-sessions`，其它 id 一律回退到通用齿轮。插件的 `package.json` `icon` 管不到导航栏，所以我们这个 section id（`dsh-image-bridge-config`）只加一条映射即可拿到与「插件市场」相同的字形。

- **目标文件**（本机 DSH 安装目录，**不在本仓库里**，也不要提交进来）：
  `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-settings-general\lib\client.js`
- **改动位置**：`navIcon(id)`（约 243-269 行）里、`plugins` 分支（约 257-260 行）之后，新增一条分支。字形组件用**与 `plugins` 分支完全相同的那一个**：`_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutlineMedium`（大小 `size: 16`、类名 `SettingsRoot_module_css_default.navIcon` 也照抄）。
- **当前状态**：**尚未应用**——本仓库的自动化会话只有工作区写权限，对安装目录的写操作被沙箱拒绝（`Access to the path '…client.js.dib-backup' is denied`）。下面给出可照抄的改法与回滚方式，由具备写权限的一方执行。

补丁内容（在 `plugins` 分支之后插入，缩进是 Tab，与文件里其它分支一致）：

```diff
 			if (id === "plugins") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutlineMedium, {
 				className: SettingsRoot_module_css_default.navIcon,
 				size: 16
 			});
+			// 本机补丁（生图桥插件作者添加）：给 dsh-image-bridge-config 用与「插件市场」相同的字形。DSH 升级会覆盖本文件，需重新打。
+			if (id === "dsh-image-bridge-config") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutlineMedium, {
+				className: SettingsRoot_module_css_default.navIcon,
+				size: 16
+			});
 			if (id === "archived-sessions") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutlineMedium, {
```

改法（三步，先备份再改，最后语法自检；PowerShell）：

```powershell
$f = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-ui-settings-general\lib\client.js"
Copy-Item $f "$f.dib-backup" -Force            # 1) 先备份（回滚就靠它）
# 2) 用编辑器在 plugins 分支后插入上面 diff 里的三行（含注释共 4 行），其余一律不动
node --check $f                                # 3) 语法自检
```

- **升级会被覆盖**：`npm i -g @deepseek-ai/dsh` 会重写该文件，补丁丢失，需要按上面的 diff 重新打一次（建议升级后先检查 `navIcon` 里是否还有 `dsh-image-bridge-config` 这一条）。
- **回滚**：`Copy-Item "$f.dib-backup" $f -Force`（`$f` 同上）；回滚后刷新页面即可。
- **生效方式**：该文件是按文件从磁盘加载的客户端模块，改完**刷新页面**即可，不需要重启 Harness。
- **验证边界**：自动化会话**无法在浏览器里确认**导航是否真的换了字形——刷新后的视觉效果必须由用户确认。

