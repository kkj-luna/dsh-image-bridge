# 生图桥 v4 独立验证报告（第二轮：改名安全性 + 下拉重构 + 空状态 + 导航认领）

- 任务：task-33。验证对象：`plugins/dsh-image-bridge-v4/`（`index.js` 1647 行、`client.js` 2860 行）
- 验证者：verifier（未参与本轮实现；本轮实现由 client-ui 自写自测，无第二人复核）
- **报告文件选择**：新建 `verify-report-2.md`，不改动 `verify-report.md`（那是 task-3 多提供商改造的历史记录，本轮改动与其结论无关；两份分开更好追溯）。本文件是本次唯一写入产物，未改任何实现文件与测试脚本。
- 方法：不采信实现者自述与自测数字；独立重跑 → 独立读代码 → **自建有状态渲染器**驱动真实组件（非复用其 harness）→ 再用运行中服务的真实产物（启动自述、客户端日志）交叉验证。
- 环境说明：工作区 `<workspace>` 是指向 `<repo>` 的目录联接，两者等价；我未改目录名、未动 profile、未执行 plugin_manager。

## 〇、结论总览

| 组 | 结果 | 数量 |
|---|---|---|
| 四个测试套件重跑 | 通过（failed=0） | 32+145+117+8 = **302** 断言 |
| verify-cross 跨进程 | 通过 | 1（真实 PNG 252622 字节） |
| 改名安全性 | 通过（6 项受保护身份 + 4 处新名一致），另见 F-2 | 静态 12 项 + live 3 项 |
| 下拉行为等价性 | 通过 | 18 项（含任务清单 9 项逐项） |
| 空状态 | 通过 | 7 项 |
| 导航认领 | 通过（真实显示未覆盖） | 7 项 |
| 副标题 / 页头 | 通过 | 3 项 |
| **合计独立断言** | **37 条（36 条首轮即绿 + 1 条改桩后复测绿）** | — |
| 发现（需实现者/有权限者决定） | F-1 诊断日志误导（低）、F-2 profile 旧包名残留（低-中）、F-3 仓库默认地址是本地 mock（低）、T-1 其自测的保真度观察（信息） | 4 |

## 一、全量重跑（我自己跑的，不是转述）

```
verify-manifest.mjs   SUMMARY total=32  passed=32  failed=0   [exit=0]
verify-client.mjs     SUMMARY total=145 passed=145 failed=0   [exit=0]
verify-host.mjs       SUMMARY total=117 passed=117 failed=0   [exit=0]
verify-resolve.mjs    SUMMARY total=8   passed=8   failed=0   [exit=0]
verify-cross.mjs      交叉验证通过：http://127.0.0.1:8799/v1 → 512x512 PNG（252622 字节），已落盘并回调文本信封  [exit=0]
```

与 lead 给的基线（32/145/117/8）逐项吻合。verify-cross 需要 mock 服务：我按任务说明 `node .dib-verify/mock-image-api.mjs 8799` 起在后台（先探测 `GET /v1/models → 200 {"data":[{"id":"mock-image"}]}`），跑完未留后台任务。

测试脚本指向的插件目录也可疑点已核实：`.dib-verify/dsh-paths.mjs:23-28` 的 `PLUGIN_DIR` 解析为 `<仓库>/plugins/dsh-image-bridge-v4`，即被测的就是我们要验的那个目录（不是旁边那几个历史副本）。

## 二、改名安全性（最高优先级）

### 2.1 六项"受保护身份"一个字都没动 —— 通过

| 身份 | 值 | 位置 |
|---|---|---|
| 设置命名空间（Host 半） | `image-bridge-v4` | `plugins/dsh-image-bridge-v4/index.js:230` |
| 设置命名空间（客户端半） | `image-bridge-v4` | `plugins/dsh-image-bridge-v4/client.js:159` |
| profile 补丁行 id | `image-bridge-v4` | `plugins/dsh-image-bridge-v4/cordis.patch.yml:6` |
| 插件目录名 | `plugins/dsh-image-bridge-v4` | 文件系统 + `verify-manifest.mjs:80` 断言 |
| 客户端日志文件名 | `dsh-image-bridge-client.log` | `index.js:1478` |
| 本地化命名空间 / RPC 通道 | `dsh-image-bridge` / `/dsh-image-bridge` | `client.js:157,165`、`index.js:166` |

这四项正是"用户已保存配置能否继续读到"的钥匙：设置行 id 未变 → 配置仍落在同一行；日志名未变 → 排障路径不变。

### 2.2 四处新包名完全一致，且都等于新包名 —— 通过

| 位置 | 值 |
|---|---|
| `package.json:2` | `@local/dsh-image-bridge` |
| `index.js:84` `export const name` | `@local/dsh-image-bridge` |
| `cordis.patch.yml:7` 补丁行 name | `@local/dsh-image-bridge` |
| `client.js:2` 浏览器模块 id | `@local/dsh-image-bridge` |

附带一致性：`index.js:1452` 启动自述里的 `plugin` 字段、`client.js:1039` 页头徽标 `PACKAGE_NAME`、`client.js:1040` `PACKAGE_VERSION='0.1.0'` 与 `package.json` 的 `version: "0.1.0"` 逐字一致（实测 `name/version` 输出同上）。`verify-manifest.mjs` 有"三处 name 一致"的断言，我另行核对了第四处（客户端模块 id），它是浏览器侧能否加载的关键，且不与前三处同源。

### 2.3 `git grep -n 'image-bridge-v4'` 逐条分类 —— 21 处全部是故意保留

```
命中文件计数：README.md(4)  verify-report.md(3)  dsh-paths.mjs(2)  plugins/.../README.md(2)
              verify-host.mjs(2)  verify-client.mjs(2)  verify-manifest.mjs(2)
              cordis.patch.yml(1)  index.js(1)  client.js(1)  .gitignore(1)   = 21
```

按性质分三类，**没有一处是包名**：

1. **受保护身份（必须保留，改了就会丢用户配置）**：`client.js:159`、`index.js:230`、`cordis.patch.yml:6` —— 见 2.1。
2. **目录名引用（改名故意不动目录）**：`.dib-verify/dsh-paths.mjs:9,27`、`verify-manifest.mjs:80`、`README.md`（仓库根 ×4）、`plugins/dsh-image-bridge-v4/README.md`（×2）、`.gitignore:12`。
3. **测试桩里的设置行 ns（必须与生产一致）**：`verify-client.mjs:804,2197`、`verify-host.mjs:591,592`。
4. **历史记录/说明**：`verify-report.md`（上一轮报告 ×3）、`verify-manifest.mjs:70`（描述本次改名的注释）。

反向核对：仓库内**已经没有旧包名** `@local/image-bridge-v4` 作为标识使用，唯一命中是 `verify-manifest.mjs:70` 注释里那句"改名（@local/image-bridge-v4 → @local/dsh-image-bridge）"。新包名 `@local/dsh-image-bridge` 只出现在该注释、`README.md`(×4)、`client.js:2,1039`、`cordis.patch.yml:7`、`index.js:84,1452`、`package.json:2`。

### 2.4 运行中服务的真实产物：改名后用户配置确实读得到 —— 通过（本轮最有价值的一条证据）

`~/.dsh/dsh-image-bridge-startup.json`（Host 每次激活覆写，落盘时间 `2026-10-10T13:55:06Z`）：

```json
{ "plugin": "@local/dsh-image-bridge",
  "steps": ["Config schema 就绪", "两个工具已注册", "测试通道已挂载"],
  "configSource": "settings:image-bridge-v4",
  "config": { "providers": [ { "id": "default", "label": "千问",
      "baseUrl": "https://<provider-endpoint>/v1",
      "keyRef": "DSH_IMAGE_BRIDGE_API_KEY", "models": [ …约 200 个… ],
      "imageModel": "gpt-image-1", "editModel": "" } ], "activeProviderId": "default",
    "modelRoutes": {…}, "fallbackAfterMs": 15000 },
  "provider": { "level": "active", "id": "default", "label": "千问", "keyRef": "DSH_IMAGE_BRIDGE_API_KEY" } }
```

能读出的硬结论（都不是我模拟的、是真实进程写的）：

1. Host 半以**新包名**加载成功（`plugin` 字段 + 三个 apply 步骤齐全 + 7 个服务都在位）；
2. `configSource: "settings:image-bridge-v4"` → 改名后**仍然从同一个设置行读到配置**，用户那条真实提供商（label「千问」、旧凭据名 `DSH_IMAGE_BRIDGE_API_KEY`、约 200 个模型）原样还在，凭据名没漂移、密钥不会失联；
3. 三级回退落在 `level: "active"`，`activeProviderId: "default"` 命中 → 与客户端纠偏规则一致（不是退回旧字段）。

`~/.dsh/dsh-image-bridge-client.log` 尾部（真实浏览器回报）：

```
13:56:53.794  info  远程命名空间解析  settings → ctx.get("remote.settings")
13:56:53.794  info  apply 期探测远程命名空间  {"settings":true,"credentials":true}
13:56:53.843  info  client apply 完成
```

→ 客户端半在真实浏览器里也加载完成了（`client apply 完成`，无 fatal）。这条同时说明：**`client.js:2` 的模块 id 与运行中的外壳没有对不上**——这是改名最容易静默失败的地方（对不上就是"设置页整块消失、控制台无错"），现在有实证。

> 注意上面这份 live 配置里 `label: "千问"` 而非 `"默认提供商"`：用户给那张卡填了名字，所以"裸 `default`"不会出现（细节见 §四 E5/E6 与 F-1）。

## 三、下拉重构的行为等价性（逐项）

实现位置：`client.js:2247-2405`（`Dropdown`），四个模型槽位在 `client.js:2445-2527`，尺寸下拉在 `client.js:2672-2694`。
我的证据来源：**自建的有状态渲染器**（持久 hook + 按依赖重跑 effect + 真实 ref 挂载 + 手动派发 DOM 事件），把真实 `client.js` 的注册组件渲染出来、按路径给每个组件实例独立状态槽，然后驱动交互。断言编号 Dxx。

| # | 任务清单项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 点击外部关闭 | 通过 | 代码 `client.js:2290-2303`（`mousedown` 监听 + `wrapper.contains(target)` 判定）；动态 **D9**：派发面板外 mousedown → 菜单数 1→0，且 document 监听被摘掉（`0`）；对照 **D8**：派发当前下拉自己的 wrapper（经祖先链取到真实 `wrapperRef.current`）→ 菜单仍为 1，不误关 |
| 2 | Esc 关闭 | 通过 | 代码 `client.js:2331-2335`；动态 **D10**：Esc 后菜单 0 |
| 3 | 上下键 + 回车选中 | 通过 | 代码 `client.js:2313-2347`（↑/↓/Home/End/Space/Enter/Tab）；动态 **D13**（↓ 移动并改变 `aria-activedescendant`）、**D14**（End 跳到最后一个可选项 `…-opt-5`）、**D15**（回车选中键盘当前项，触发器文案变成该项） |
| 4 | 焦点回到触发器 | 通过（**仅桩级**） | 代码 `client.js:2260-2268`（`close(true)` → `focusTrigger()`），Esc 与选中都走 `close(true)`；动态 **D10**：`focus()` 在触发器节点上被调用。**真实 `document.activeElement` 是否真的回到按钮、能否继续 Tab——未覆盖**（见 §六） |
| 5 | `aria-haspopup` / `aria-expanded` | 通过 | 代码 `client.js:2358-2360`；动态 **D2**（关闭时 `aria-expanded=false`）、**D5**（打开时 `true` + `aria-controls=<id>-menu` + `aria-activedescendant`） |
| 6 | `role=listbox` / `role=option` / `aria-selected` | 通过 | 代码 `client.js:2378`（菜单 `role=listbox`）、`2389-2402`（项 `role=option` + `aria-selected`）；动态 **D4**：`aria-selected=true` 恰好 1 项且是当前值 |
| 7 | 分组不可点 | 通过 | 代码 `client.js:2383-2386`（`role=presentation`、无 `onClick`、不参与键盘 `optionIndexes`）；动态 **D6**：唯一分组小标题无 `onClick`、无 `aria-selected` |
| 8 | 长列表最大高度 + 内部滚动 + 当前项滚入视野 | 通过（**滚动量未覆盖**） | 代码：`.dib-menu{max-height:280px;overflow-y:auto}`（`client.js:512`）、键盘移动时 `getElementById(...).scrollIntoView({block:'nearest'})`（`client.js:2306-2311`）；动态 **D13**：移动后确实按当前项 id 调用了 `scrollIntoView({block:'nearest'})`。**真实滚动位置/面板被视口裁剪的情况未覆盖**（见 §六） |
| 9 | （我补）每实例状态独立 | 通过 | 动态 **D3**：打开 generate.primary 后菜单恰好 1 个、其余三个 `aria-expanded=false`（这一条它的自测证明不了，见 T-1） |
| 10 | （我补）再次点触发器 / Tab 关闭 | 通过 | 动态 **D11**（`client.js:2366` 的 `isOpen ? close(false) : openWith(...)`）、**D12**（Tab 关闭，`client.js:2346`） |
| 11 | 未设置槽位不显示第一个模型 | 通过 | 动态 **D1**：`edit.primary` 未设置时触发器显示占位文案，而不是 `mock-image`/`flux-pro`；占位只在触发器上，菜单里没有"主模型/备用模型"这类可点条目（`client.js:2474-2479`） |
| 12 | 四个模型下拉 + 尺寸下拉都是自绘菜单 | 通过 | 动态：4 个 `dib-route-*` 触发器 + 1 个 `dib-size`，全部走同一 `Dropdown`；**D20** 尺寸下拉 = 8 个预设 + 自定义（值就是能发给服务商的尺寸串），**D21** 选"自定义…"后出现文本框并回显当前值 |
| 13 | 选中后按同一份状态落盘 | 通过 | 动态 **D18**（鼠标点选 `cogview-4` 后触发器同步）+ **D19**（点"保存"后 `settings.update` 的 patch 里 `modelRoutes.generate.primary = {providerId:'p1', model:'cogview-4'}`，**providerId 与 model 成对**，跨服务商不丢归属） |
| 14 | 分组标题可读性标记 | 通过 | 代码 `client.js:1016-1020`：`— 名称 —` 且 ASCII 整体大写，中文不受影响；动态实测渲染出 `— 厂商甲 —`（只动分组标题，模型名一字不改） |
| 15 | 手填通道：只展开被选中的槽位 | 通过 | 动态 **D16**（恰好 1 个手填框，且 id 属于被选中的槽位）、**D17**（没有重复的可见"手动输入…"标签，只留 `aria-label`） |

## 四、空状态（逐项）

| # | 要求 | 结论 | 证据 |
|---|---|---|---|
| E1/E2 | 没有模型时四个槽位**不展开手填文本框且禁用** | 通过 | 动态 E1：四个触发器全部 `disabled`；E2：手填框 0 个。代码侧对应 `client.js:2454`（`manual` 只由 `route.manual` 决定，去掉了旧代码里的 `|| !hasConnected`）、`2482`（`disabled: disabled || !hasConnected`） |
| E3/E7 | 共用提示**只出现一次** | 通过 | 动态 E3/E7：`dib-routes-shared` 节点数 = 1；引导文案"先添加并测试连接一个模型提供商"节点数 = 1（旧版是四个槽位各一份） |
| E4/E5 | 界面**不出现裸 `default`** | 通过 | 动态 E4（完全没有服务商时）/E5（只有旧单服务商配置时）：整页可见文本无 `\bdefault\b`；E6：共用提示显示「默认提供商」（`legacyProviderName`），而不是内部 id。代码 `client.js:2223-2227`：`label → legacy?「默认提供商」→ 空`，刻意不把 id 当名字 |
| E6 | 无服务商时说「尚未添加服务商」 | 通过 | 动态 E3：`activeName === ''` 分支渲染 `route.manualHint；route.noProvider` |
| — | 只有被明确选中的槽位才有文本框 | 通过 | 动态 D16：选「手动输入…」后全页只有 1 个手填框 |

补充（live 对照）：运行中的真实配置里那张卡 `id: "default"` 但 `label: "千问"`，所以 `activeName` 取的是「千问」——空状态的两条分支都在真实数据上成立。

## 五、导航图标认领（逐项）

| # | 要求 | 结论 | 证据 |
|---|---|---|---|
| G1 | 只认领文字等于本插件标签的那一行、不碰外壳结构 | 通过 | 代码 `client.js:1108-1115` + 纯函数 `isOwnNavRow`（`1157-1161`，标签为空时谁都不认领）；动态 G1：一排 `['通用','生图桥','模型']` 只有第二行被打上 `data-dib-nav-icon` |
| G2 | 图标与 tag 都属于同一个 effect | 通过 | 代码 `client.js:1093`（`ctx.effect(...)` 内创建 `<style>` 与观察者）；动态 G2：注入的样式表 `dataset.pluginCss === 'dsh-image-bridge/settings-nav-icon'` 确实挂在 head 上 |
| G3 | 语言切换后重新认领 | 通过 | 代码 `client.js:1132-1135`（`MutationObserver` → `schedule` → 重新 `sync()`）；动态 G3：把行换成 `['General','Image Bridge','Models']` 并切标签后，标记跟到英文行 |
| G4/G5 | 匹配不到时静默降级且**无残留** | 通过 | 代码 `client.js:1116-1123`（本轮新增：本轮没再找到的行要摘掉标记）；动态 G4：被替换掉的旧行标记被摘除；G5：选择器返回空后所有行标记清零，不抛错 |
| G6 | 恢复后能重新认领 | 通过 | 动态 G6：选择器恢复后再触发一次观察者回调，标记回到正确行 |
| G7 | 挂 `ctx.effect` 上、随 fiber 卸载 | 通过 | 代码 `client.js:1136-1143`（卸载：断开观察者、清标记、移除样式表）；动态 G7：执行 effect 清理后标记全清、样式表从 head 消失 |
| — | 真实浏览器里是否真的显示为我们的图标 | **未覆盖** | 我的 DOM 是自建桩，`mask-image` 的渲染结果、外壳导航行的真实结构与选择器 `[role="dialog"] nav button`（`client.js:1068`）是否仍成立，都只能由用户在真实界面确认（见 §六） |

## 六、副标题 / 页头（本轮第 ④ 组）

| 检查 | 结论 | 证据 |
|---|---|---|
| 副标题文案已改，中英齐备 | 通过 | `client.js:180` `'intro': '为你的 DeepSeek Harness 接上外部生图模型'`；`client.js:288` 英文对应句 |
| 页头形态：图标 + 标题 + 包名版本徽标 | 通过 | `client.js:2618-2622`（`dib-page-title-row` / `dib-page-glyph` / `dib-page-title` 取 `nav` / `code` 徽标显示 `${PACKAGE_NAME}  v${PACKAGE_VERSION}`） |
| 图标与随包 `icon.svg` 同源、不硬编码颜色 | 通过 | `GLYPH_SHAPES`（`client.js:1048-1055`）与 `icon.svg` 的 rect/circle/path 几何数据逐条一致（`rect x=3 y=4 w=18 h=16 rx=3`、`circle cx=8.2 cy=8.8 r=1.5`、桥面/拱/两个桥墩路径完全相同），两处都只用 `currentColor` |

## 七、未覆盖范围（明确列出，不含糊）

1. **没有真实 React + 真实 DOM 渲染。** 我的驱动是自建迷你渲染器（元素树 + 持久 hook + 依赖感知 effect），它证明了**逻辑接线**（谁在什么时候被调用、状态怎么变、写盘什么值），但证明不了像素与浏览器行为。以下必须由用户在真实界面确认：
   - **真实焦点回流**：`document.activeElement` 是否真的落回触发器按钮、之后 Tab 是否往预期方向走；
   - **真实滚动**：`scrollIntoView` 之后菜单的实际滚动位置、菜单是否被视口下沿裁剪（`max-height:280px` 只是 CSS 声明）；
   - **悬停高亮与面板观感**：`:hover`/`is-active` 背景、勾号位置、面板圆角阴影、长列表滚动手感；
   - **真实鼠标事件顺序**：我只调了 `onClick`；真实点击是 `mousedown`(先) → `click`，因此"点另一个触发器时旧菜单先被 mousedown 关掉"这条路径没被我的桩走到（代码上由 §三-1 的同一个监听覆盖，逻辑等价）。
   - **导航图标是否真的显示**：`mask-image` + `background-color: currentColor` 的渲染、外壳导航行结构、以及我们的标记是否会被外壳的样式覆盖——**需要用户看一眼确认**，我不声称已验证。
2. 屏幕阅读器实际朗读顺序、`aria-activedescendant` 与真实焦点管理组合后的行为未验证。
3. 设置页与工具卡片之外的页面（工具结果卡片 `ImageResultRow`、图片加载 `loadImage`）本轮未回归（属 task-3 覆盖范围）。
4. 真实生图服务商未调用；端到端只打到本地 mock（8799）。

## 八、发现（只报告，未修改任何文件）

### F-1（低，诊断误导）"设置行快照"这条日志永远打印 `total:0`

- 现象：真实客户端日志里 `13:56:53.916 info 设置行快照 {"total":0,"namespaces":[],"mine":[]}`，而同一时刻 Host 的启动自述写着 `configSource: "settings:image-bridge-v4"`（配置**在读得到**）。
- 根因：`client.js:2803-2805` 的诊断块自己做了朴素解包——`payload = ('value' in result) ? result.value : result`，随后 `Array.isArray(payload) ? payload : []`。真实信封是 `{ ok:true, value:{ writable, namespaces:[…] } }`，于是 `payload` 是对象、不是数组 → 列表恒为空。真正的载入路径用的是 `namespacesOf()`（`client.js:888` / 调用点 `1750`），它认得这个信封，所以**功能没问题，只有这条日志在说谎**。
- 影响：排障时会被误导成"客户端看不到自己那一行"，进而怀疑改名把配置弄丢了——恰好是本次最敏感的问题。
- 最小复现：看 `~/.dsh/dsh-image-bridge-client.log` 最后一行 `设置行快照 … total:0`，与 `~/.dsh/dsh-image-bridge-startup.json` 的 `configSource` 对照即可。
- 建议：该块改用同文件的 `namespacesOf(result)`；或直接删掉这条临时诊断。

### F-2（低-中，profile 侧改名只改了一半）运行中的 profile 仍钉着旧包名

- 现象：`<user-dir>\<user>\.dsh\profiles\web\cordis.patch.yml` 里承载用户配置的那一行仍是旧名：

  ```yaml
  - id: image-bridge-v4
    name: "@local/image-bridge-v4"          # ← 旧包名
    config: { baseUrl: "https://<provider-endpoint>/v1", model: gpt-image-1, size: 1024x1024 }
  ```
  同时 profile 的 `package.json` 同时依赖新旧两个名字（都 `link:` 到同一个插件目录），`node_modules/@local/` 下旧名 junction 也还在；`dsh.profile.bundles` 里列的是新名。
- 当前影响：**看起来不影响**——live 启动自述里 `plugin` 是新名、工具注册成功、配置读得到，说明实际生效的是新名（bundle 自带的补丁覆盖了 profile 的这一行，或旧名 junction 解析到同一目录后被容忍）。
- 风险：这是全仓库唯一一处"改名只改了一半"的地方，且正好压在用户配置那一行上。一旦 profile 重新 `pnpm install`（一个包目录的 `package.json` name 与依赖键不再匹配）、或有人清理旧 junction、或 bundle 补丁不再覆盖它，这一行就可能解析失败 → 插件不加载/客户端半不加载。
- 建议（需有权限者操作，**我没有动 profile**）：把该行 `name` 更新为 `@local/dsh-image-bridge`，并清理 profile 里指向同一目录的旧名依赖；顺手核对两处 `config`（profile 行里是千问地址，插件自带补丁里是 `http://127.0.0.1:8799/v1`，见 F-3）哪个是想要的默认值。

### F-3（低，仓库默认值指向本地 mock）插件自带的补丁配置把默认地址写成了本机 mock

- 现象：`plugins/dsh-image-bridge-v4/cordis.patch.yml:9-11` 的 `config.baseUrl = 'http://127.0.0.1:8799/v1'`、`model: 'gpt-image-1'`；live 启动自述里 `config.baseUrl` 正是这个地址（因为 provider 模式生效，实际请求用的是服务商的千问地址，所以没出错）。
- 影响：这是开发期验证用的默认值。新装用户/服务商列表为空时会默认打到本机 8799（不存在则报连接错），而 README 与设置页都引导用户填自己的地址；排查时也容易把 `config.baseUrl` 误读成"当前真的在用这个地址"。
- 建议：补丁里的 `config` 段改回官方默认（`https://api.openai.com/v1`）或整个删掉。

### T-1（信息，仅关于其自测的保真度，不是产品缺陷）

`.dib-verify/verify-client.mjs:719-721` 用 `组件名#props.key ?? path` 定位会话内的状态槽，而 `client.js:2471` 与 `2673` 给五个自绘下拉的 `key` 都是 `'select'` → **在同一会话里五个下拉共享同一份 hook 状态**。因此它的下拉断言无法证明"每个下拉状态独立"（在真实 React 里按键只在兄弟间比较，产品侧没有问题）。我用按路径定位状态槽的独立渲染器验证了 D3（打开一个只有它展开、其余三个 `aria-expanded=false`），结论仍是产品正确；这条只说明它的证据强度比看起来弱一点。

## 九、最可能出问题的地方（按风险排序）

1. **profile 里那一行旧包名（F-2）**——全仓库唯一"改名只改了一半"的位置，压在用户配置行上；今天因为旧名 junction 还在而侥幸能跑，`pnpm install` 或清理后就可能炸。这是本轮唯一我认为需要人工收口的接缝。
2. **无浏览器验证的三处观感/行为**：导航图标是否真的显示成我们的图形、真实焦点回流、真实滚动与面板裁剪。尤其"导航认领"是**靠改别人 DOM 实现的权宜之计**（代码注释自己也这么说），真实外壳结构一变就会静默降级成齿轮——功能不坏，但用户会看不到图标。
3. **空状态的判定口径**：`hasConnected`（`client.js:2209-2210`）要求"服务商至少取过一次模型列表"。用户如果已经配好服务商但没点过「获取可用模型」，四个槽位仍是禁用下拉 + "先添加并测试连接一个模型提供商"。逻辑自洽、也确实引导了下一步，但值得产品确认这是不是想要的空状态。
4. **诊断日志的准确性（F-1）**：功能无碍，但它是本次改名排查中最可能误导人的一行。
