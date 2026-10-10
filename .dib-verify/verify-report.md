# 生图桥 v4 独立验证报告（task-3）

- 验证对象：`plugins/dsh-image-bridge-v4/`（Host 半 `index.js` 1298 行、客户端半 `client.js` 1635 行）
- 验证者：verifier（未参与 index.js / client.js 的编写，两端由 host-core / client-ui 并行改造，之前无任何单人整体审阅）
- 验证手法：**只读代码行为**（不采信注释结论），另加两类独立手段：
  1. 从两个源文件**原文提取**接缝函数（大括号配平切片，非重写），在同一个进程里做差分比对；
  2. 起真实 HTTP 服务承载 Host 的 RPC 路由，用**客户端自己的解析函数**（`callHost` / `modelsOfResult` / `testOutcomeOf` 原文提取）读真实响应，再打真实独立进程的模拟生图接口。
- 未改动任何实现文件与测试脚本；本文件是唯一写入产物。

## 一、四个测试套件重跑（全部 failed=0）

命令：`node .dib-verify/verify-<name>.mjs`（工作目录 `<workspace>`）

| 套件 | 断言总数 | 通过 | 失败 | 任务要求下限 | 结论 |
|---|---|---|---|---|---|
| verify-manifest.mjs | 30 | 30 | 0 | 27 | 通过（高于下限） |
| verify-client.mjs | 51 | 51 | 0 | 23 | 通过（高于下限） |
| verify-host.mjs | 75 | 75 | 0 | 36 | 通过（高于下限） |
| verify-resolve.mjs | 8 | 8 | 0 | 8 | 通过（持平） |

证据（四个套件各自的末行）：

```
SUMMARY total=30 passed=30 failed=0        [exit=0]
SUMMARY total=51 passed=51 failed=0        [exit=0]
SUMMARY total=75 passed=75 failed=0        [exit=0]
SUMMARY total=8  passed=8  failed=0        [exit=0]
```

合计 164 条断言，0 失败。较基线 27/23/36/8（94 条）净增 70 条，符合"新增断言应使其增加"。

## 二、逐条契约核查（读源码行为，不读注释）

### 2.1 Config：providers / activeProviderId 都是 volatile，旧字段仍在 —— 通过

| 检查 | 结论 | 证据 |
|---|---|---|
| 9 个字段齐全 | 通过 | 运行时 `Object.keys(mod.Config.dict)`：`baseUrl,model,editModel,size,saveToWorkspace,outputDir,timeoutMs,providers,activeProviderId`（`index.js:101-127`） |
| `providers`、`activeProviderId` 标了 volatile | 通过 | `dict.providers.meta.volatile === true`、`dict.activeProviderId.meta.volatile === true`；源码 `index.js:113-126` |
| volatile 字段共 9 个（settings 只允许在线改写 volatile） | 通过 | 实测 `volatile=9`，即全部字段；`index.js:102-126` 每字段 `.volatile()` |
| 旧 `baseUrl/model/editModel` 仍在且带默认值（向后兼容） | 通过 | 默认值实测 `baseUrl=https://api.openai.com/v1`、`model=gpt-image-1`、`editModel=''`；`index.js:102-108` |
| `providers` 的元素 schema 恰为契约七字段 | 通过 | `Config.dict.providers.inner.dict` 键 = `["baseUrl","editModel","id","imageModel","keyRef","label","models"]`（`index.js:114-122`） |

补充事实：元素内部字段的 `volatile` 均为 `false`，只有数组字段本身是 volatile。这与任务给出的契约一致（只要求 providers/activeProviderId 标 volatile）；但它是否满足 dsh-settings 写入时的实际校验，见"未覆盖范围"第 3 条。

### 2.2 凭据 ref 形状与派生规则 —— 通过（含一个边界分歧，见 F-2）

| 检查 | 结论 | 证据 |
|---|---|---|
| Host 有 ref 形状校验 `/^[A-Za-z_][A-Za-z0-9_]*$/` | 通过 | `index.js:136` `const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/` |
| Host 由 `provider.id` 派生：大写 + 非字母数字→下划线 | 通过 | `index.js:333-336` `providerKeyRef()`；`index.js:344-347` `providerCredentialRef()`：显式 keyRef 合法则用，否则按 id 推导 |
| 客户端同规则 | 通过 | `client.js:684-686` `keyRefOf()`：`id.toUpperCase().replace(/[^A-Z0-9]/gu,'_')`（与前缀拼接后与 Host 等价） |
| 任意 id 推导结果都合法 | 通过 | 16 个极端 id（`''`、`-`、`💡`、`  spaced  `、60 个 a、`vendor/v1`…）两侧结果 100% 匹配 `^[A-Za-z_][A-Za-z0-9_]*$`（前缀保证首字符合法） |
| 客户端存盘 → Host 读回零漂移 | 通过 | 3 组记录往返：`host.providerCredentialRef(host.normalizeProvider(client.plainProvider(client.normalizeProvider(raw))))` 与客户端 `keyRef` 完全一致 |

### 2.3 RPC `models` —— 通过

| 检查 | 结论 | 证据 |
|---|---|---|
| 方法表含 `test/log/models` | 通过 | `index.js:145` `RPC_ENDPOINTS = ['test','log','models']` |
| 走 `GET {baseUrl}/models` + `Authorization: Bearer <key>` | 通过 | 实测回声服务收到 `{"method":"GET","url":"/v1/models","auth":"Bearer PAYLOAD-KEY"}`；源码 `index.js:866,873` |
| 解析 `body.data[].id` 并丢空值 | 通过 | 喂入 `data:[{id:'m-a'},{id:'m-b'},{id:'  '},{nope:1},'x',null]`，客户端真实 `modelsOfResult` 得到 `m-a,m-b`；源码 `index.js:895-897` |
| 成功信封 `{ok:true,value:{models}}` | 通过 | 实测 `{"ok":true,"value":{"models":["m-a","m-b"]}}`；`index.js:1241` |
| 失败信封 `{ok:false,error:{message}}` | 通过 | 实测 401 场景 `{"ok":false,"error":{"code":"models-failed","message":"获取模型列表失败：接口返回 HTTP 401 Unauthorized：bad key",...}}`；`index.js:1246-1253` |
| 客户端能把失败信封变成可读异常 | 通过 | 客户端真实 `callHost` 抛出 `获取模型列表失败：接口返回 HTTP 401 Unauthorized：bad key`；`client.js:641-657` |
| 信封字段/回显 | 通过 | `{"type":"server-response","rpcId":"image-bridge-1",...}`，rpcId 原样回显；`index.js:1270-1272`、`client.js:649` |
| 未知方法 404 | 通过 | 实测 `nope` → HTTP 404（`index.js:1186-1193`） |

### 2.4 工具取 provider 的逻辑（三级回退 / editModel 回退 / 调用参数优先） —— 通过

| 检查 | 结论 | 证据 |
|---|---|---|
| 三级回退：activeProviderId 命中 → providers[0] → 旧字段 | 通过 | `index.js:398-407` `activeProviderOf()`；`index.js:410-415` `providerLevelOf()` 报 `active/first/legacy`；实测 5 种输入下 `level ∈ {active,first,legacy}` 与取值自洽 |
| 客户端纠偏规则与 Host 完全一致 | 通过 | 用 `client.js:1092-1095` 原文构造规则，与 Host `activeProviderOf` 逐例比对 5 组（命中第二项 / 指向不存在项 / 空串 / 空列表 / 单项）**全部一致**，空列表两侧都落到"旧字段" |
| `editModel` 为空 → 沿用 `imageModel` | 通过 | `index.js:472` `editModel: provider.editModel === '' ? imageModel : provider.editModel`；实测 p1(editModel 空) → `{model:'img1',editModel:'img1',keyRef:'..._P1'}` |
| 服务商 `imageModel` 为空 → 回退旧 `model` | 通过 | `index.js:467`；实测 p2 → `{model:'legacy-image',editModel:'edit2'}` |
| providers 为空 → 旧字段 + 旧凭据名 | 通过 | 实测 `{baseUrl:'https://legacy/v1',model:'legacy-image',editModel:'legacy-image',keyRef:'DSH_IMAGE_BRIDGE_API_KEY'}` |
| 选中的服务商缺 baseUrl → 明确报错，不打到旧地址 | 通过 | `index.js:464-466` 抛"还没有填写接口地址"；实测抛错 |
| 调用参数 `model` 优先于配置 | 通过 | `index.js:1031`（生图走 `endpoint.model`）、`index.js:1078`（改图走 `endpoint.editModel`），两处都是 `args.model` 非空则覆盖 |
| 每次调用重读 volatile 配置 | 通过 | `index.js:1028`、`index.js:1075` 均调 `effectiveConfigOf(ctx, config)` 取 `live` |

### 2.5 client.js 结构约束 —— 通过

| 检查 | 结论 | 证据 |
|---|---|---|
| 不 import 任何 Harness 客户端包 | 通过 | 全文唯一 require 调用是 `require('react')`（`client.js:64`）；`@deepseek-ai/*` 只出现在 `package.json` 的 `dsh.client.inject` 声明里，不是 import |
| `tool.call.toolview` 注册未声明 children | 通过 | 注册字面量只有 `name/key/locale`（`client.js:1596-1606`）；全文 `children` 仅出现在 `client.js:137`（错误边界的 `this.props.children`），`tool.call.images` 仅出现在注释（`client.js:463,1601`），从未声明 |
| `settings.section` 带 `priority: -1` | 通过 | `client.js:1623`，同处 `order: 120`、`id: 'dsh-image-bridge-config'` |
| 两个插槽条目组件都包在 SectionBoundary 里 | 通过 | `client.js:1626`（settings）、`client.js:1515`（toolview 经 `ImageToolview`），错误边界定义 `client.js:115-139` |
| 设置命名空间 = profile 行 id | 通过 | Host `SETTINGS_NS='image-bridge-v4'`（`index.js:206`）、客户端 `SETTINGS_NS='image-bridge-v4'`（`client.js:159`）、`cordis.patch.yml` 行 `id: image-bridge-v4` 三者一致 |
| RPC 通道前缀一致 | 通过 | `index.js:142` 与 `client.js:165` 都是 `/dsh-image-bridge` |
| 旧凭据名一致 | 通过 | `index.js:130` 与 `client.js:161` 都是 `DSH_IMAGE_BRIDGE_API_KEY`；派生前缀 `index.js:133` / `client.js:163` 相同 |

### 2.6 样式只用主题令牌 —— 通过

| 检查 | 结论 | 证据 |
|---|---|---|
| 无硬编码颜色 | 通过 | CSS 块内 `#hex` / `rgb(` / `rgba(` / `hsl(` 匹配数 **0**（`client.js:330-405`） |
| 颜色属性都走 `var(--dsw-*)` | 通过 | `color:` 后非 `var(--dsw-` 的匹配数 0；全文 `--dsw-` 出现 76 处 |

### 2.7 客户端设置页落盘行为（含"删除不清理密钥"） —— 通过

| 检查 | 结论 | 证据 |
|---|---|---|
| 保存写 `providers` + `activeProviderId` | 通过 | `client.js:1279` `settings.update(SETTINGS_NS, { providers: next, activeProviderId })` |
| API Key 只走 `credentials.set(keyRef, …)`，不进 settings | 通过 | `client.js:1287`；settings patch 里没有密钥字段 |
| 第一个提供商自动成为当前 | 通过 | `client.js:1277` `activeProviderId = state.activeProviderId === '' ? id : state.activeProviderId` |
| 删除**不**清理凭据（被认可的设计） | 通过 | `client.js:1220-1241`：只 `settings.update` 写 providers/activeProviderId，日志显式记 `keyKept: true`，全程无 `credentials.delete`（全文无 `credentials.delete`/`.remove(` 调用） |
| 删除当前项时 activeProviderId 收敛 | 通过 | `client.js:1225` 删除后取 `next[0].id`（空列表则 `''`），与 Host 二级回退语义一致 |
| 旧配置合成一张卡片且沿用旧凭据名（配置不丢） | 通过 | `client.js:720-726` `legacyProviderOf()` → `keyRef: API_KEY_REF`；实测该卡片存盘后 Host 仍解析出 `DSH_IMAGE_BRIDGE_API_KEY` |

## 三、差分接缝测试（本报告的主要独立手段）

方法：用大括号配平从**源文件原文**切出 `providerKeyRef / providerCredentialRef / normalizeProvider / normalizedConfig / activeProviderOf / providerLevelOf / activeProviderSummary / endpointFor`（Host）与 `slugify / hostSlugOf / keyRefOf / uniqueId / normalizeProvider / legacyProviderOf / plainProvider`（客户端），拼进 `new Function` 直接运行两侧**真实代码**做比对（提取长度已核对：`providerKeyRef` = `index.js:333-336`，`keyRefOf` = `client.js:684-686`）。

| 编号 | 断言 | 结论 |
|---|---|---|
| C1a | 客户端可产出的 id 形状上，两侧凭据名推导完全一致 | 通过 |
| C1b | 全部 16 个极端 id 推导结果都匹配凭据服务语法 | 通过 |
| C2a | Host `normalizeProvider` 与客户端 `plainProvider` 字段名集合完全相同（7 个） | 通过 |
| C2b | 七个字段逐一取值一致 | 通过 |
| C3 | 客户端写盘 → Host 读回：keyRef 与生效凭据名零漂移（3 组） | 通过 |
| C5 | 三级回退/纠偏规则两侧逐例一致（5 组） | 通过 |
| C5b | Host 启动自述 `level` 与取值自洽（active/first/legacy） | 通过 |
| C6a | 服务商 editModel 空 → 改图沿用 imageModel 且密钥同源 | 通过 |
| C6b | 服务商 imageModel 空 → 生图回退旧 model | 通过 |
| C6c | providers 为空 → 旧字段 + `DSH_IMAGE_BRIDGE_API_KEY` | 通过 |
| C6d | 选中服务商缺 baseUrl → 明确报错 | 通过 |
| C7 / C7b | 旧配置卡片与 Host 三级回退的凭据名同源；存盘后仍同源 | 通过 |
| C8a | 两个工具都实现"args.model 非空则覆盖配置" | 通过 |

C4 是量化探测（非断言），结论见 F-2。

## 四、跨进程端到端

环境事实：8799 端口上**已有一个遗留的 mock 生图服务在跑**（PID 22824，非本次启动）。我两次尝试后台起 `mock-image-api.mjs 8799` 都得到 `EADDRINUSE`，但该端口的服务行为与脚本一致（`GET /v1/models → 200 {"object":"list","data":[{"id":"mock-image","object":"model"}]}`），故直接复用。**我未终止该进程**（不在我的授权/写入范围内），请知悉 8799 被长期占用这件事本身。

用真实 `node:http` 服务器承载 Host 注册的 prefix 路由（`/dsh-image-bridge`），客户端按 `client.js:641-657` 的形状发请求，响应交给客户端**原文提取**的解析函数：

| 编号 | 断言 | 结论 |
|---|---|---|
| H0 | 真实 `@deepseek-ai/dsh-tools` 解析成功（Config 已导出，非恒等兜底） | 通过 |
| H1 | 两个工具注册成功 | 通过 |
| H2 | RPC 路由挂到 webServer（prefix `/dsh-image-bridge`） | 通过 |
| A1a | 200 + `server-response` 信封 + rpcId 回显 | 通过 |
| A1b | Host 走 `GET {baseUrl}/models` 且带 `Bearer <payload.apiKey>` | 通过 |
| A1c | 客户端真实 `modelsOfResult` 解析出 `data[].id` 并过滤非法项 | 通过 |
| A1d | 成功信封形状 | 通过 |
| A2 | `test` 打到**独立进程**模拟服务（8799）并成功，客户端读作 ok | 通过 |
| A3a | 失败信封 `{ok:false,error:{message}}` | 通过 |
| A3b | 客户端 `callHost` 把 `error.message` 抛成异常 | 通过 |
| A4 | 未知方法 → 404 | 通过 |
| B1a | 多服务商配置下跨进程生图成功，落盘真实 PNG（魔数 `89504e470d0a1a0a`、字节数与附件记录一致） | 通过 |
| B1b | 用的是当前服务商凭据 `DSH_IMAGE_BRIDGE_KEY_MOCK_VENDOR`，不是旧 `DSH_IMAGE_BRIDGE_API_KEY` | 通过 |
| B1c | 服务商 `editModel` 留空 → 生效模型为 `imageModel`（`mock-image`） | 通过 |
| B2 | `payload.keyRef` 优先于当前生效服务商 | 通过 |
| B3 | `keyRef` 为空时跨服务商密钥外发（见 F-3） | **行为确认，记为发现** |

### 4.1 任务第 3 项不通过：`verify-cross.mjs` 跑不起来（见 F-1）

`node .dib-verify/verify-cross.mjs` 现状：

```
Error: tools 服务未挂载，无法注册工具
    at Module.apply (file:///<workspace>/plugins/dsh-image-bridge-v4/index.js?cross=1:1009:47)
    at file:///<workspace>/.dib-verify/verify-cross.mjs:45:5
[exit=1]
```

结论：**跨进程路径本身可用**（上表 A/B 组是我用独立 harness 打通的），失败根因在 `verify-cross.mjs` 的假 ctx，不在插件。

## 五、不通过项与发现

### F-1（中）`verify-cross.mjs` 的假 ctx 缺 `tools` 的两条暴露路径 —— 脚本不通过，插件无缺陷

- **现象**：按任务要求的顺序执行 `mock-image-api.mjs 8799` + `verify-cross.mjs`，第一条断言都到不了，直接在 `apply` 抛错退出（exit 1）。
- **根因**：`index.js:1009` 用 `ctx.get('tools')` 判断、`index.js:1010` 用 `ctx.tools.register` 注册（这是有意的设计，注释与代码一致：工具不放进 inject 回调）。而 `verify-cross.mjs:19-35` 里 `services` 没有 `tools` 键（只有 `scope.tools`），且 `ctx` 上也没有 `tools` 属性：
  - `ctx.get('tools')` → `services['tools']` → `undefined` → 抛 `tools 服务未挂载`（已实测）；
  - 即使补上 `get`，`ctx.tools` 仍是 `undefined` → 抛 `Cannot read properties of undefined (reading 'register')`（我在自己的第一版 harness 上实测到了这条，见"探针误报复核"第 2 条）。
- **最小复现**：`node .dib-verify/mock-image-api.mjs 8799`（后台）→ `node .dib-verify/verify-cross.mjs`（工作目录 `<workspace>`）。
- **影响**：task-3 第 3 项的交付脚本现状不可用，任何人照做都会得到失败结论；容易误判为插件坏了。
- **修复方向（由实现者决定，我未改）**：`verify-cross.mjs` 的假 ctx 需要同时提供 `ctx.get('tools')` 与 `ctx.tools`（`{ register }`），与 `verify-host.mjs` 的 ctx 构造对齐。
- **证据**：见 §4.1 报错栈 + 我打通的 A/B 组结果。

### F-2（低-中）非 slug 的 `provider.id`：两侧派生出的凭据名不同（保存一次即自愈）

- **现象**：Host 用**存盘原样的 id** 推导（`index.js:333-336`），客户端先 `slugify` 再推导（`client.js:698-706` + `684-686`）。当 id 含非 ASCII、或长度 > 40 时两者不同：
  - `'zh-智谱'` → Host `DSH_IMAGE_BRIDGE_KEY_ZH___`，客户端 `DSH_IMAGE_BRIDGE_KEY_ZH`
  - `'智谱'` → Host `DSH_IMAGE_BRIDGE_KEY___`，客户端 `DSH_IMAGE_BRIDGE_KEY_`
  - 60 个 `a` → Host 60 个 `A`，客户端（slugify 截断 40）40 个 `A`
  - 反例（两侧一致，故最常见的 ASCII 写法无害）：`'My.Vendor'`、`'my provider'`、`'open.bigmodel.cn'`、`'x@y:8799'` 全部相同。
- **可达条件**：记录里 `keyRef` 为空且 id 未被客户端写过（手改 `cordis.patch.yml` / 其它工具写入）。**设置页自己写出的记录 id 一定是 slug**，此时 C1a 证明两侧完全一致。
- **影响**：上述场景下卡片显示"密钥未配置"（客户端按自己的名字 `describe`），而 Host 其实会去另一个名字取密钥 → 用户按界面提示存了 A 名字的密钥，工具仍报缺密钥。**不会串别的服务商的密钥**（差异只源于同一条记录）。用户在设置页保存任意一次后自愈：客户端会把 id 与 keyRef 一起改写为 slug 版本，Host 读回同名。
- **最小复现**：把手改配置设为 `providers:[{ id:'zh-智谱', baseUrl:'https://x/v1', imageModel:'m', label:'智谱' }]`（无 keyRef）；Host 侧请求会解析 `DSH_IMAGE_BRIDGE_KEY_ZH___`，客户端卡片按 `DSH_IMAGE_BRIDGE_KEY_ZH` 报"密钥未配置"。
- **建议**：两侧统一"派生基准"——或 Host 也对 id 做同一 slug 归一，或客户端把归一后的 id 回写并提示（当前是静默显示）。

### F-3（中）新建卡片（keyRef 为空、未填密钥）会把"当前生效服务商"的密钥发往另一个 baseUrl

- **现象**：Host 的 keyRef 解析是三档：`payload.apiKey` → `payload.keyRef` 对应凭据 → **当前生效服务商的凭据**（`index.js:1235-1239`）。客户端给"新建卡片"传的正是 `keyRef: ''`（`client.js:857` + `client.js:863/889` 的 `apiKey: state.keyDraft` 为空串），它的注释写的是"新建卡片还没有引用名，传空串，Host 会忽略"（`client.js:855`）——空 keyRef 确实被忽略，但随后**落到第三档**，于是用 A 的密钥去探 B 的地址。
- **实测证据**（我的 harness，当前生效服务商 = `mock-vendor`）：
  - 请求体：`{baseUrl:'http://127.0.0.1:8898/other-vendor/v1', apiKey:'', keyRef:''}`
  - Host 实发：`{"method":"GET","url":"/other-vendor/v1/models","auth":"Bearer secret:DSH_IMAGE_BRIDGE_KEY_MOCK_VENDOR"}`
  - Host 解析的凭据名：`["DSH_IMAGE_BRIDGE_KEY_MOCK_VENDOR"]`
- **用户可达路径**：设置 → 生图桥 → 点"添加模型提供商" → 只填接口地址（比如另一个厂商）→ 直接点"测试连接"或"获取可用模型"。
- **影响**：真实密钥被发送到第三方地址（凭据外泄面）；同时诊断信息会误导（B 的连接状态实际由 A 的密钥决定）。不是改名/放宽契约，而是两端对"空 keyRef"的语义理解不一致：Host 当"未指定，走默认"，客户端当"本次不带密钥"。
- **建议（择一，由实现者决定）**：(a) 新建卡片未填密钥时，客户端不发起 test/models；(b) Host 对"payload 既无 apiKey 也无合法 keyRef"直接回 `{ok:false,error:{message:'请先填写密钥'}}`，不做第三档回退；(c) 至少修正 `client.js:855` 的注释与真实行为一致。

### F-4（低）客户端原样保留未校验的 `keyRef`，Host 会忽略形状非法的 keyRef

- **现象**：客户端 `client.js:706` 只判空串就采用 `value.keyRef`，不做 `CREDENTIAL_REF_PATTERN` 校验；Host `index.js:346` 对非法 keyRef 一律忽略并改按 id 推导。
- **可达条件**：手改 profile 写入 `keyRef: 'not a ref!'`。此时客户端会拿这个非法名去 `credentials.describe`（`client.js:1106`）或 `credentials.set`（`client.js:1287`），Host 则按 id 推导 → 两侧不同源，且卡片上的密钥状态可能报错。
- **影响**：仅手改配置可达；保存一次即自愈（`client.js:1263` 会保留非空 keyRef……注意：**编辑该卡片保存后仍原样保留非法 keyRef**，所以这条不会像 F-2 那样自愈，直到用户删掉重建该卡片）。
- **建议**：客户端在 `normalizeProvider` / `submitProvider` 里加与 Host 相同的形状校验，非法则按 id 派生（与 Host 一致）。

### F-5（信息）环境：8799 端口被遗留进程长期占用

- 现象：PID 22824 自 18:08:58 起监听 `127.0.0.1:8799`，导致按任务步骤启动 mock 服务必然 `EADDRINUSE`（进程命令行因权限无法读取，`tasklist`/`Get-CimInstance` 均返回拒绝访问）。
- 影响：不是代码缺陷，但会让人误以为"mock 启动失败"；且这个 mock 的行为（返回 `mock-image` + 512×512 PNG）与本仓库脚本一致，所以不影响验证结论。
- 建议：收尾时由有权限的一方清理该进程。

## 六、未覆盖范围（明确没有验证的东西）

1. **没有任何真实 React + DOM 渲染**。我没有浏览器控制，也无法在真实 Harness 页面里挂载插件。全部组件层结论（含 `verify-client.mjs` 的 51 条）都是"假的 React/渲染器 + 元素树"级别：观感、布局、滚动、焦点、层级、点击穿透、真实 `loadImage` 出的 `<img>`、`tool.call.toolview` 传进来的真实 props 形状，**都未验证**。报告中 mark 为"注册未声明 children / 包在 SectionBoundary 里"等，指的是**源码字面量**，不是运行期观察。
2. **真实插槽运行时未跑**：`settings.section`、`tool.call.toolview` 只做了源码级核查；`priority: -1` 的热重载遮蔽行为、与内置 `read_image` 卡片在 `tool.call.images` 上的声明冲突，都只是"读代码推断"，没有在真实 Cordis 插槽里观测。
3. **真实 `settings` / `credentials` / `remote` 服务未接**。我的 settings 桩按代码接受的形状给值（`{writable,namespaces:[{ns,value}]}` 与行数组两种都试过）。因此"dsh-settings 是否真的接受对 volatile 数组字段 `providers` 的嵌套写入"**未证实**——特别是 `providers` 元素内部字段（id/label/keyRef/…）都没标 volatile，若实现要求写入 patch 的每个字段都是 volatile，保存会被拒（这条属于残留风险，我没有环境去证伪）。
4. **`credentials.describe` 的真实返回形状**未证实（客户端假设 `{ok:true,value:{ref:{configured:true}}}`，`client.js:1106-1119`）。
5. **HMR / 热重载 / `loader/volatile-update` 的真实触发**未验证（`index.js:983-994`）。
6. **多标签页/并发写入、`revision` 冲突**未验证。
7. 真实生图服务商（OpenAI 兼容端点）未打过，只打本地模拟服务；`url` 形态的返回（下载图片分支 `index.js:539-543`）在本轮端到端里走的是 `b64_json` 分支，`url` 分支由既有套件覆盖。
8. 浏览器端的 `credentials`/`settings` 命名空间解析（`remoteNamespace` 三条路径）只在元素树假 ctx 下测过，真实网关行为未验证。

## 七、探针误报复核（诚实记录，避免把工具错误当成代码缺陷）

我自己的独立 harness 出现过 5 次首次误报，均已定位为**探针本身的问题**并复核通过，不计入不通过项：

1. C1a 对 `id='   '`（纯空白）报不一致 → 该输入两侧都无法从存盘数据产生（Host 会 trim，客户端会先 slugify），超出可达域；已改为"客户端可产出的 id 形状"比较 + 分歧面量化（F-2）。
2. 客户端 `callHost` 用相对 URL `/dsh-image-bridge/models`，Node 的 fetch 无 origin 直接 `Failed to parse URL` → 补上浏览器 origin 语义（`new URL(u, 'http://127.0.0.1:8899')`）后通过 A3b。
3. D4 取 `Config.dict.providers.dict` 为空 → 元素 schema 的真实位置是 `Config.dict.providers.inner.dict`，改路径后通过。
4. E6 "require 只有一次" 误报两次 → 正则命中了报错文案字符串 `require("react") 失败`；按赋值形态匹配后确认只有 `client.js:64`。
5. F3 "locale 文件键与组件词典不一致" → `locale/*.json` 只承载 `meta`（插件列表标题/描述），与组件内 MESSAGES 分工不同，属预期而非缺陷。
6. 我的第一版 ctx 桩缺 `ctx.tools`，在 `index.js:1010` 抛 `Cannot read properties of undefined (reading 'register')` → 桩补齐后通过；这条正好成为 F-1 根因的第二半证据。

## 八、总结：通过项 / 不通过项 / 最脆弱的接缝

- **通过**：四个套件 164 断言 0 失败（30/51/75/8，均达标）；契约 7 个方面共 33 条逐项核查通过；差分接缝断言 13 条通过；跨进程端到端 15 条通过（另有 1 条 B3 是"行为确认"并升级为发现 F-3）；结构/样式/文案类断言 16 条通过。
- **不通过**：1 项——`verify-cross.mjs` 现状不可运行（F-1，根因在测试脚本的假 ctx，插件无缺陷）。另计 3 条发现：F-2（非 slug id 的凭据名分歧，低-中）、F-3（新建卡片的密钥跨服务商外发，中）、F-4（客户端不校验 keyRef 形状，低）。F-5 为环境备注。
- **最可能出问题的接缝**（按风险排序）：
  1. **keyRef 的"第三档回退" × 客户端新建卡片传空 keyRef**（F-3）——两端各自自测都绿，接缝处的语义差异只有把两边放在一起看才暴露，且后果是密钥外发到别的地址。
  2. **`provider.id` 的归一责任**（F-2/F-4）——Host 不归一、客户端归一，派生基准不同；设置页写出的数据永远一致（所以各自测试全绿），只有非设置页来源的数据才分歧。
  3. **真实 `settings`/`credentials` 服务的接受度**——客户端写的是 `providers` 数组 + 元素内非 volatile 字段，Host 读的是 volatile 冻结引用，中间这层我没法在无浏览器、无真实 Harness 的条件下证伪，建议在真实 Web 会话里手点一次"保存 → 测试连接 → 模型调用"作为最后一关。
