# 这是旧副本，不是生效的那一份

插件的**权威副本**在 `..\image-bridge`，包名 `@local/dsh-image-bridge`。

profile 里当前生效（已启用）的 bundle 就是 `@local/dsh-image-bridge`，它指向
`<workspace>\image-bridge`。本目录只是重命名前留下的旧路径：

- profile 的依赖里还残留一条 `"dsh-image-bridge": "link:<workspace>/dsh-image-bridge"`；
- 该 bundle 已从 profile 的 `bundles` 列表中移除（`set_bundle enabled=false`），不会参与启动；
- 保留本目录只是为了不让上面那条依赖变成断链。

下次重启 DSH 之后，本目录连同那条残留依赖都可以安全删除：

```
plugin_manager  action: remove_bundle  target: dsh-image-bridge
```

（若仍报 `bundle-in-use`，先 `set_bundle enabled=false` 再删。）

**请勿在本目录修改代码** —— 改了也不会生效。
