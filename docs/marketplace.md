# 上架插件市场

插件市场不直接收录——它的列表来自精选清单 **[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**。
投稿方式：往那个仓库提一个 PR，**只加一个 YAML 文件**。合并后市场与目录站会自动收录（通常一天内）。

## 1. 条目文件

把这个文件原样复制成 `data/plugins/kkj-luna__dsh-image-bridge.yml`（**文件名必须与仓库名对应**）：

```yaml
url: https://github.com/kkj-luna/dsh-image-bridge
name: kkj-luna/dsh-image-bridge
category: model
description:
  en: Generation and editing for a model that cannot draw, through any OpenAI-compatible image API, with multiple providers and an automatic fallback model.
  zh: 让没有生图/修图能力的模型接入任意 OpenAI 兼容生图接口，支持多个服务商与备用模型自动接管。
```

**两个容易踩的格式坑**（来自[贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/CONTRIBUTING.md)）：

- 描述里出现 **`: `（冒号加空格）必须加引号**，否则 YAML 会把它当嵌套键。上面的英文描述里没有冒号，所以不必加引号；改文案时注意。
- `url` **必须与仓库地址完全一致**，不要写 `#readme` 之类的锚点。

## 2. 对照收录要求

| 要求 | 本插件的情况 |
| --- | --- |
| `package.json` 声明 `dsh.bundle` | ✅ `"bundle": { "patch": "./cordis.patch.yml" }`（这是最常见的被拒原因，只声明 `dsh.client` 不算） |
| 仓库创建满 1 天 | ✅ 已过 |
| 有真实可用代码，不是空壳 | ✅ 两个工具 + 444 条离线断言 |
| 在活跃维护 | ✅ |
| **仓库带 `dsh-plugin` topic** | 见第 3 节——**这是硬性要求，且当前没加** |
| 描述属实、不夸大 | ⚠️ 见第 3 节：GitHub 仓库描述里有一处失实，必须先改 |
| 与现有插件功能重复 | ⚠️ 目录里已有 `dsh-image-create`、`dsh-ark9canvas` 等同类，见下 |

## 3. 仓库元信息（改完再提 PR）

指南把 `dsh-plugin` topic 列为**硬性要求**（"Add the `dsh-plugin` topic to your repo."），市场靠它检索。
另外指南第 81 行那句话要当回事：

> **描述必须属实。** 它会被当作对你插件的声明，并与代码核对……**夸大是让一个本来不错的插件被打回的主要原因。**

### Description

原来的仓库描述里写着"主/备用模型**超时自动切换**"——**这句是错的**。v0.2.1 已经把"等响应超预算就换人"整套删除了
（`index.js` 的注释里明确记着这件事）。真正会换备用的只有三种情况：**连不上**（连接超时 / 网络层失败）、
**非 2xx**（含回包不是 JSON）、**回包无图**；而"已出图但下载失败"**故意不换**，因为换备用会重复计费。

建议改成（96 字符，与原描述等长，但每句都能在代码里对上）：

```text
DeepSeek Harness 的生图桥插件：让没有生图/修图能力的模型接上外部生图模型。可添加多个服务商，为生图与修图各选主用与备用模型，备用接入时自动接管，全部在 Web 界面点击配置。
```

### Website

```text
https://www.npmjs.com/package/kkj-luna-dsh-image-bridge
```

装插件走的就是 npm，用户看完仓库第一个问题就是"怎么装"；npm 页也顺带显示 README 与版本号。
README 里已经有 GitHub 链接，所以这里放 npm 不冗余。

### Topics

`ai` 太泛（GitHub 上几十万个仓库都用），价值低；`dsh-plugin` 是上架前提。建议的最终集合：

| 操作 | Topic | 理由 |
| --- | --- | --- |
| ➕ 加 | `dsh-plugin` | **上架硬性要求**，市场靠它检索 |
| ➕ 加 | `image-generation` | 精准命中"生图"搜索 |
| ➕ 加 | `image-editing` | 修图能力 |
| ➕ 加 | `openai-compatible` | 说清"接任意兼容接口"这个卖点 |
| ➖ 删 | `ai` | 太泛，占位无收益 |
| ✔ 保留 | `deepseekharness`、`dsh` | 生态基础词 |
| ✔ 保留 | `image` | 大类词 |
| ✔ 保留 | `dsh-image-bridge` | 与仓库名一致，可当"官方标签" |

### 右侧的复选框

- **Releases** ✅ 勾上——想发 GitHub Release（挂预构建 tarball）必须先勾它。
- **Packages** ✅ 勾上——已经发了 npm，勾上更一致。
- **Deployments** 不用勾。

## 4. PR 描述（把差异化点说清楚）

指南对重复功能的规则是：**"不是先来后到，是谁更好"**——重复的插件确实可能被拒，但**做得更好的分叉可以收录**。
所以 PR 里要主动说明差异，而不是只贴一句"新增插件"：

```text
新增：kkj-luna-dsh-image-bridge（生图桥）

给没有生图/修图能力的模型接上外部生图模型。已发布 npm：kkj-luna-dsh-image-bridge@0.4.2

与目录里已有的同类插件（dsh-image-create、dsh-ark9canvas、dsh-tool-imagegen）相比，本插件的取舍是：

- 生图与改图各配一套主用/备用路由（四个槽位），不是全局一个模型。
- 备用接管的触发条件写得很窄且诚实：只在请求发不出去、非 2xx、回包无图时切换；
  用户主动取消、以及"已出图但下载失败"都不切——前者不该重试，后者重试会重复计费。
- 回包里的图片地址过一道 SSRF 逐跳关卡（拒环网/私网/云元数据），同时允许用户自填本机接口地址
  （自建生图服务常在局域网内）。
- 模型候选是全部已连接服务商的模型并集，176 项也能靠输入跳转定位，不必一路按方向键。
- 444 条离线断言（无需联网、无需真实密钥），其中一套专项验证"升级/改名后用户配置零漂移"。

仓库根就是插件包（`dsh.bundle` 在根 package.json），支持一条命令安装。
```

## 5. 提 PR 的步骤

```sh
# 1. fork 后克隆
git clone https://github.com/<你的账号>/awesome-dsh-plugin.git
cd awesome-dsh-plugin

# 2. 新建条目文件（内容见上面第 1 节）
#    data/plugins/kkj-luna__dsh-image-bridge.yml

# 3. 提交并推送到你的 fork
git checkout -b add-kkj-luna-dsh-image-bridge
git add data/plugins/kkj-luna__dsh-image-bridge.yml
git commit -m "Add kkj-luna/dsh-image-bridge"
git push origin add-kkj-luna-dsh-image-bridge

# 4. 在 GitHub 上开 PR 到 awesome-dsh-plugin 的主分支
```

**不要手工改那两个 README**——它们由 `data/plugins/*.yml` 生成，合并后会由维护者在 `main` 上重新生成。
（想本地预览也行：`npm ci && node scripts/generate-readme.mjs`，提交生成结果同样接受，只要与数据源一致。）

## 6. 上架后的效果

合并后，用户可以在插件市场里搜到「生图桥」并一键安装——装的就是 npm 上的包，
**预构建安装不需要 `allowBuilds` 构建授权**（这正是贡献指南推荐把插件发到 npm 的理由）。
