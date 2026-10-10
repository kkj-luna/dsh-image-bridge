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
| `.dib-verify/` | 测试与验收套件：`verify-*.mjs`（204 条断言）、`mock-image-api.mjs`（本地模拟生图接口） |
| `generated-images/` | 生图插件的落盘输出（已在 `.gitignore` 中忽略） |
| `dsh-image-bridge/`、`image-bridge/`、`plugins/dsh-image-bridge{,-live,-v3}/` | **过期副本**，仅作历史参考；不要在这里改代码 |

插件的详细文档见 [plugins/dsh-image-bridge-v4/README.md](plugins/dsh-image-bridge-v4/README.md)。

## 跑测试

```powershell
cd <workspace>
node .dib-verify\verify-manifest.mjs
node .dib-verify\verify-client.mjs
node .dib-verify\verify-host.mjs
node .dib-verify\verify-resolve.mjs

# 跨进程端到端（先起本地模拟接口）
node .dib-verify\mock-image-api.mjs 8799   # 另开一个终端
node .dib-verify\verify-cross.mjs
```

## 安装

用 Harness 的插件管理器安装该目录（`plugin_manager` 的 `install_bundle`，target 传绝对路径 `plugins/dsh-image-bridge-v4`）。插件行 id 为 `image-bridge-v4`，同时就是它的设置命名空间。

## 已知待办

- 过期副本尚未清理（`dsh-image-bridge/`、`image-bridge/`、`plugins/dsh-image-bridge{,-live,-v3}/`），确认不再需要后可删除。
- profile 里可能仍留有早期改名产生的惰性依赖记录，功能无影响。
