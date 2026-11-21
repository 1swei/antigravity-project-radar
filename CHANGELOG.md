# 更新日志

## v1.0.5（2026-11-21）

- **兼容 Antigravity `2.34.0+` 宿主注入凭据**：[client.mjs](sidecars/panel/client.mjs) 新增并导出 `serverFromEnv()` 与 `serverFromDiscovery()`，当新版 `language_server` 不再通过命令行传递 `--csrf_token` 时自动使用宿主注入的 `ANTIGRAVITY_LS_ADDRESS` 与 scoped `ANTIGRAVITY_CSRF_TOKEN`；严格校验环回 HTTP 地址与安全 Token，保留旧版兼容，防止跨代端口错配并支持多实例消歧。
- **无 CDP 调试口时的 Sidecar 保活与诊断**：[main.mjs](sidecars/panel/main.mjs) 启用 `integration.start({ keepAlive: true })`，避免在 Antigravity `2.33.0+` 未传入 `--remote-debugging-port=0` 时每 60s 退出退避重启；[runtime-ui.mjs](compat/runtime-ui.mjs) 补充 `cdp-port-missing` 状态码与诊断说明。

## v1.0.4（2026-11-18）

- **重绘无黑底透明轮廓 Logo**：[logo.svg](assets/logo.svg) 去掉暗色圆角方框，改用通透钴蓝雷达盘搭配亮青扫描扇区/弧线与琥珀等待节点，右下角翠绿完成角标通过 SVG `<mask>` 做透明镂空分隔，在浅色与深色背景的 Plugins 列表与 README 中均清晰利落。

## v1.0.3（2026-11-18）

- **首个公开发布版本**：在 Antigravity 2.0 左侧 `Projects` 列表折叠状态下，于项目行最右侧实时展示并行任务状态（运行中 / 待确认 / 异常 / 未读刚完成）。
- **固定最右侧布局与悬停避让**：项目行徽标及 `Projects` 标题栏全局汇总胶囊统一对齐在最右侧；悬停项目行时原生 `⋮` / `+` 自动左移至徽标左侧，既不遮挡操作按钮也不让徽标在鼠标下偏移。
- **悬停/点击任务浮层 & 零刷新 SPA 跳转**：无需展开项目目录即可预览各会话状态与子任务数，点击通过宿主 TanStack Router 无刷新直达对应会话；仅运行中任务每秒读秒，等待与已完成任务展示静态具体时刻。
- **精准归属 & 双向已读同步**：基于 `GetAllCascadeTrajectories` 与 `workspaces`（含中文 URI 解码）归类项目并收敛子 Agent 计数；通过 `radar-state.json` 持久化未读完成态，并与宿主 `annotations.lastUserViewTime` 双向同步消退。
- **原生主题与字体自适应**：自动继承宿主 `document.body` 字体与明暗主题色板，独立 CDP 通道与 `antigravity-context` 无冲突共存。
