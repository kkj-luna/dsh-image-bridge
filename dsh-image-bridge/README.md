# 生图桥（@local/dsh-image-bridge）

给 **DeepSeek Harness 里没有生图/修图能力的模型**接上外部生图模型。装好并在 Web 界面里填一次接口地址与 API Key，模型就获得了 `image_generate`（生图）与 `image_edit`（改图）两个工具。

- **面向用户**：在「设置 → 生图桥」里点击配置，填地址、模型、API Key，点「保存」。
- **面向模型**：两个工具直接调用你配置的接口，生成的图片以图片卡片显示在对话里。

---

## 一、它解决什么问题

DSH 里的模型能不能作图，取决于模型本身有没有这个能力。本插件把「作图」这件事外包给一个你指定的外部生图模型：

```
用户：帮我画一只戴宇航头盔的柴犬
  └─ 模型调用 image_generate(prompt)
       └─ 插件 → POST {接口地址}/images/generations
            └─ 外部生图模型返回图片
                 ├─ 提交为持久图片附件 → 在对话里显示
                 └─ 另存到工作区 generated-images/ → 你随时能打开
```

当前模型不需要有任何视觉能力——**它就是看不见图片，也照样能替你画出来**。

---

## 二、安装

包名用 `@local/` 前缀：这是 DSH 对**本地自作插件**的惯例（表示不发布到 npm），与本机其它本地插件一致。

已经装到 `web` profile 的话可以跳过。重新安装：

在 DSH 会话里让 Agent 执行，或直接用插件管理器把本目录作为本地包安装：

```
plugin_manager  action: install_bundle
                target: <本目录的绝对路径>
```

安装会把这个目录作为 `link:` 依赖写进 profile，并把插件行插入 profile 的配置层。

---

## 三、配置

打开 **设置 → 生图桥**，四行：

| 字段 | 说明 | 例子 |
| --- | --- | --- |
| 接口地址 | OpenAI 兼容的基础地址 | `https://api.openai.com/v1` |
| 生图模型 | 请求里带的模型名 | `gpt-image-1`、`cogview-4`、`Kwai-Kolors/Kolors` |
| 默认尺寸 | 默认输出尺寸 | `1024x1024` |
| API Key | 密钥，输入框留空表示不修改 | `sk-...` |

下面两个按钮：

- **保存** —— 把前三个字段写进本插件行的配置，把 API Key 写进凭据服务。
- **测试连接** —— 用当前填写的地址与密钥请求一次 `GET {接口地址}/models`，报告可达性与密钥是否被拒。它不产生生图费用。

**存到哪里**

- API Key → DSH 凭据服务，落在 `$DSH_HOME/.credentials.yaml`（权限 `0600`）。**不回传浏览器、不写进 profile 的 YAML。**
- 接口地址 / 模型 / 尺寸 → 本插件行在 profile 配置层里的字段。这些字段都声明为 `volatile`，所以可以在线改写、无需重启。

**支持的接口形态**

任何 OpenAI 兼容的图片接口：

- 生图：`POST {接口地址}/images/generations`，请求体 `{model, prompt, size?}`
- 改图：`POST {接口地址}/images/edits`，`multipart/form-data`，含 `image`、`prompt`、`model`
- 返回：`{"data":[{"b64_json": "..."} ]}` 或 `{"data":[{"url": "..."}]}` 都支持；同时兼容 `revised_prompt`。

---

## 四、行为细节

**图片去哪了**

1. 提交为**持久图片附件** —— 对话里以图片卡片呈现，模型（若支持视觉）也能直接看到。
2. 另存为**会话工作区文件** `generated-images/image-<时间戳>-<提示词片段>.png`。目录可以用配置里的 `outputDir` 改，但解析结果必须落在会话工作区内，否则拒绝写入。

**模型看不见图片时会怎样**

工具结果的渲染按**当前调用路由是否声明图片输入能力**分叉：

- 路由声明了 `image` 输入 → 图片作为 image 内容块随工具结果下发，模型直接看到。
- 没有声明（例如纯文本模型）→ 只下发文本信封与文件路径。这是必要的：DSH 的 LLM 适配器会对不支持图片输入的路由抛 `UNSUPPORTED_CONTENT`，硬塞图片会让整个请求失败。

无论哪种情况，**界面上的图片卡片都会显示**——它读的是工具结果里持久化的图片引用，与模型视觉能力无关。

**为什么要有自定义工具卡片**

DSH 内置的富图片卡片在 `dsh-client-ui-tool` 里按工具名硬编码，只认 `read_image`；通用卡片又会把 image 内容块丢掉（`flattenContent` 只取 text）。所以第三方生图结果必须由插件自己注册 `tool.call.toolview` 来渲染。

---

## 五、排查

**设置里没有「生图桥」这一页**

1. 插件是否启用：插件管理器里看 `dsh-image-bridge` 这一行。
2. 改动过插件代码？**Node 会缓存已加载的模块，而 DSH 的热重载默认忽略 `node_modules`**，所以运行中的进程仍在用旧代码。重启一次 DSH 服务即可。
3. 看有没有 `$DSH_HOME/dsh-image-bridge-degraded.json`。正常情况下它不存在；一旦出现，说明插件没能解析到 `@deepseek-ai/schemastery`，因此没有导出配置 Schema，配置页不会生成。文件里记录了环境事实与每一条解析尝试的失败原因，可直接定位。

**「测试连接」报密钥被拒绝（401/403）**

密钥不对，或该服务不接受 `Authorization: Bearer` 形式。注意：如果启动 DSH 的 shell 里已经定义了同名环境变量 `DSH_IMAGE_BRIDGE_API_KEY`，凭据服务会拒绝写入（环境变量优先），此时改用环境变量配置。

**报 404**

该服务可能不提供 `/models`，这不影响生图——「测试连接」对 404 会给出软提示。真正生图时若 404，说明接口路径不是 OpenAI 兼容形态。

**生图失败但没有配置页**

插件在完全没有配置页的情况下仍然可用：工具照常注册。此时可用 profile 的 `cordis.patch.yml` 提供 `baseUrl`/`model`，用环境变量 `DSH_IMAGE_BRIDGE_API_KEY` 提供密钥。

---

## 六、实现要点（给维护者）

| 关注点 | 做法与原因 |
| --- | --- |
| 依赖解析 | profile 里的插件目录通常是指向工作区的**链接**，Node 按真实路径解析裸模块名，所以从插件目录出发找不到 profile 或 dsh 安装目录的 `node_modules`。Host 半跨包只依赖 `@deepseek-ai/schemastery`（`Config` 需要它），并按「普通解析 → CLI 入口位置 → `DSH_PROFILE_DIR` → `DSH_HOME` → cwd」逐个基准尝试；全失败则优雅降级并写出自诊断。 |
| 工具定义 | 优先用 `@deepseek-ai/dsh-tools` 的 `defineTool`（带参数校验），解析不到时退化为恒等函数——`ctx.tools.register` 自身仍会校验 `output{schema, render}`。 |
| 图片值结构 | 与内置 `read_image` 完全一致，界面与附件展示插件按同一套字段消费。 |
| 界面与模型分叉 | `output.render` 决定模型看到什么（按视觉能力分叉），`output.presentationMeta` 决定界面看到什么（图片引用恒久化在 `tool/result` 的 meta 上）。 |
| 文件写入边界 | 用 `node:fs` 写工作区文件（`ctx.fs` 没有二进制写入），但写入前强制校验目标目录在会话工作区内。 |
| 设置页读写 | `remote.settings.update('<行 id>', patch, revision)` 要求该行的 Config 字段标记 `volatile()`；`remote.credentials.set(ref, value)` 的 ref 必须是 `^[A-Za-z_][A-Za-z0-9_]*$`。 |
| 客户端零依赖 | 客户端产物不导入任何 Harness 客户端包，React 由浏览器模块表提供；颜色只用 `--dsw-alias-*` 主题令牌。 |
| 渲染必须全域可执行 | 宿主对渲染期抛错的插槽条目会**永久弃用**，所以配置页与卡片组件对任何字段缺失都退化成一行文本。 |

---

## 七、目录

```
dsh-image-bridge/
├── package.json        清单：bundle patch、dsh.client、图标、显示元数据
├── cordis.patch.yml    挂载声明（行 id = 设置页写入的命名空间）
├── index.js            Host 半：两个工具、附件与落盘、测试通道、降级自诊断
├── client.js           客户端半：自定义工具卡片 + 设置页
├── locale/{zh,en}.json 插件卡片上的显示名与简介
└── icon.svg            插件图标
```

回归测试在仓库的 `.dib-verify/`：Host 端到端（假 ctx + 真 HTTP + 真 PNG 字节比对）、客户端注册与组件、清单与跨文件一致性、依赖解析健壮性，以及一个可选的本地模拟生图接口。
