<p align="center">
  <img src="plugins/dsh-image-bridge-v4/icon.svg" width="96" alt="生图桥">
</p>

# 生图桥 dsh-image-bridge

[English](README.en.md) | 中文

[![stars](https://img.shields.io/github/stars/kkj520/dsh-image-bridge?style=flat)](https://github.com/kkj520/dsh-image-bridge)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4f8cff)](https://github.com/deepseek-ai)

给 [DeepSeek Harness](https://github.com/deepseek-ai) 里**没有作图能力的模型**接上外部生图服务：装一个插件，模型就多出 `image_generate`（生图）与 `image_edit`（改图）两个工具，图片作为持久附件出现在对话里，同时另存到会话工作区 `generated-images/`。

![生图桥设置页](docs/settings-zh.png)

## 安装

```sh
dsh plugin --profile web add <本仓库绝对路径>/plugins/dsh-image-bridge-v4
```

也可以让 Agent 用插件管理器装：`install_bundle`，target 传上面那个目录。装完重启 `dsh web`，打开 **设置 → 生图桥**。

## 你会得到

- **画图不靠模型本身**——当前模型有没有作图能力都不影响：它调用插件，插件去问外部生图服务，图片回传成对话里的图片附件
- **多家服务商并排**——每家各自的接口地址与 API Key，卡片上直接看连通状态；点一次「测试连接」顺带把这家的可用模型列出来
- **模型随便搭**——生图和改图可以选不同厂商的模型，各配一个主用 + 备用；主用失败或超时自动换备用，并告诉你换成了哪个
- **只列能画图的模型**——你的 Key 可能带几百个模型，默认只显示判定为生图的那几个，想看全部点一下开关
- **尺寸可选**——八种常用预设，也可以自己填任意尺寸串
- **密钥不外泄**——API Key 存进 DSH 凭据服务（`$DSH_HOME/.credentials.yaml`，权限 `0600`），不写进配置文件，也不回传浏览器
- **没有密钥就不发请求**——请求里既没有显式密钥、也没有合法的凭据引用时，Host 一个字节都不发，绝不会拿别家服务商的密钥顶上
- **升级不丢配置**——服务商、模型、尺寸存在 profile 里，更新插件不影响

## 快速开始

1. **添加服务商**：设置 → 生图桥 →「＋ 添加模型提供商」，填接口地址（如 `https://api.openai.com/v1`）与 API Key
2. **测试再保存**：点「测试连接」→ 模型列表出来后点「保存」
3. **选模型**：在「模型」区块为生图、改图各选一个模型
4. **画图**：直接对模型说「帮我画一只戴宇航头盔的柴犬」

> 只测试不保存，模型不会进下拉候选。

## 超时与换备用

生图接口是同步的，憋几十秒很正常（实测 42–61 秒），两个超时值都别往小里调：

- **「主模型超时(毫秒)」= `fallbackAfterMs`，默认 90000**：**请求真正发出之后**多久没拿到响应头就改用备用。DNS / TCP / TLS 的连接耗时不计入。
- **`timeoutMs`，默认 180000**：整次调用的上限。
- 超时后 Host 会探活（`GET {baseUrl}/models`），把「服务商挂了」和「服务商在慢慢画」分成两句能读懂的话。

## 支持的服务商

任何 **OpenAI 兼容**接口都行：OpenAI、智谱、通义千问、SiliconFlow，以及各类中转服务。生图打 `POST {接口地址}/images/generations`，改图打 `POST {接口地址}/images/edits`（multipart 上传参考图）。只要两样：接口地址与 API Key。

## 排查

先看设置页的**状态灯**和卡片上的失败原因，多数问题那里就写着答案。

| 现象 | 原因 |
| --- | --- |
| 「没有可用的 API Key」 | 这张卡片没填、也没存过密钥。**不是**网络错误——请求根本没发出去 |
| 「密钥被拒绝（401/403）」 | 请求发出去了，服务商不认这把 Key |
| 「获取可用模型」报 404 | 这家不提供 `/models`，不影响生图 |

三份自诊断都在 `$DSH_HOME/` 下：

| 文件 | 内容 |
| --- | --- |
| `dsh-image-bridge-startup.json` | Host 每次激活覆写，含当前实际在用哪个服务商 |
| `dsh-image-bridge-client.log` | 浏览器侧日志，**不含密钥** |
| `dsh-image-bridge-degraded.json` | 只在依赖解析失败时出现 |

## 测试

```sh
node .dib-verify/verify-manifest.mjs   # 41   清单与跨文件一致性
node .dib-verify/verify-client.mjs     # 162  客户端注册与组件渲染
node .dib-verify/verify-host.mjs       # 143  Host 端到端
node .dib-verify/verify-security.mjs   # 12   安全边界（SSRF 拒收、回包上限）
node .dib-verify/verify-resolve.mjs    # 8    依赖解析健壮性
node .dib-verify/verify-upgrade.mjs    # 24   升级后用户配置是否保留
```

共 **390 条断言**，无需联网、无需真实密钥。跨进程端到端另需先起一个本地模拟接口：

```sh
node .dib-verify/mock-image-api.mjs 8799   # 另开一个终端
node .dib-verify/verify-cross.mjs
```

脚本路径全部现场推导，没有写死机器路径；缺环境时会报错并告诉你要设哪个变量（`DSH_BIN` / `DSH_PROFILE_DIR` / `DIB_PLUGIN_DIR`）。前提是本机装了 dsh。

## 目录

```
plugins/dsh-image-bridge-v4/   插件本体（Host 半 index.js + 客户端半 client.js）
.dib-verify/                   测试与验收套件
generated-images/              生图输出（已忽略，不入库）
```

`dsh-image-bridge/`、`image-bridge/`、`plugins/dsh-image-bridge{,-live,-v3}/` 是历史副本，已被 v4 取代且不入库，请勿在此改动。

## 已知限制

- **改了插件代码要重启 DSH**：Node 缓存已加载模块，热重载忽略 `node_modules`（配置热更新是另一条通道，不受影响）
- **导航栏图标是权宜方案**：外壳按 section id 硬编码图标，第三方插件一律是齿轮。本插件挂载后「认领自己那一行」换成自己的标记；等官方 `settings.section` 支持 `icon` 后应改回官方能力

## 文档

| 文档 | 内容 |
| --- | --- |
| [插件完整说明](plugins/dsh-image-bridge-v4/README.md) | 配置项、行为细节、排查、实现要点 |
| [变更记录](CHANGELOG.md) | 每个版本改了什么（当前 **v0.2.0**） |
| [验证报告](.dib-verify/verify-report.md) · [第二轮](.dib-verify/verify-report-2.md) | 独立验证结论（含未覆盖范围） |

## 许可

[MIT](LICENSE)

