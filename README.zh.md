# dsh-disk-panel

[![npm version](https://img.shields.io/npm/v/dsh-disk-panel)](https://www.npmjs.com/package/dsh-disk-panel)
[![npm downloads](https://img.shields.io/npm/dm/dsh-disk-panel)](https://www.npmjs.com/package/dsh-disk-panel)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)

DeepSeek Harness（DSH）Web UI 的左侧栏磁盘面板：查看各卷剩余空间、统计每个工作区的目录占用、把构建产物安全移入 macOS 废纸篓（带审计与恢复）、把扫描结果交给 Agent 分析，并在空间不足时由 Host 端看门狗提醒。

[English](README.md) | 中文

## 功能

- **卷概览**：`/`、家目录和每个已登记工作区所在卷的剩余/总容量/已用比例；同一底层卷会合并成一张卡。剩余 ≤20GB 或 ≤10% 记警戒，≤5GB 或 ≤5% 记严重（≥1TB 的大盘阈值减半）。
- **工作区占用**：按需由 Host 对工作区根目录执行 `du -kx -d 1`（先 `realpath`，迁移成软链接的项目也能统计），列出顶层大目录；结果缓存 60 秒，30 秒超时，并限制并发数（繁忙时直接返回 busy，不无界排队）。
- **安全清理**：白名单构建产物（`node_modules`、`dist`、`build`、`out`、`target`、`.next`、`.nuxt`、`.svelte-kit`、`.turbo`、`.parcel-cache`、`.cache`、`coverage`、`__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`、`.nyc_output`、`.eslintcache`、`.vite`）可移入 macOS 废纸篓。先 dry-run 校验路径，面板内联确认（完整路径与大小），Host 执行前再校验一次，最后调用 `/usr/bin/trash -v`；**任何情况都不会用 `rm` 永久删除**。
- **审计与恢复**：每次真实清理写入一条 JSONL 审计（含废纸篓落点）。面板列出最近清理，可对仍存在的落点执行 `rename` 恢复。
- **交给 Agent**：把扫描结果生成 Markdown 快照（卷剩余、顶层目录大小、统计时间），新建会话并预填提示词（不会自动发送）；也可复制快照到剪贴板。
- **低空间看门狗**：Host 每 60 秒采样 `statfs`（页面关闭也在跑），带滞回、按卷冷却与按卷静音；侧栏图标显示告警点，窗口失焦时新告警走 Web Notification。
- **设置与趋势**：面板内可改看门狗设置，并展示最近 6 小时的剩余空间采样。

## 环境要求

- **DSH 0.2.2-rc.1**（通过 `engines.dsh` 声明）。
- **Node.js 22 或更高。**
- **macOS 15 或更高**才支持废纸篓清理（`/usr/bin/trash`）。Linux 下面板、扫描、趋势与看门狗可用，但清理按钮禁用（系统废纸篓仅 macOS 实现）；扫描依赖 `du`，Windows 不支持。

## 安装

桌面端：**设置 → 插件** 安装 `dsh-disk-panel`（或把同名 spec 传给 `plugin_manager` 工具）。

`dsh web` profile + CLI：

```sh
dsh plugin --profile web add dsh-disk-panel
```


把 `web` 换成实际 profile 名，然后重启 Host（桌面端可让插件页重新加载）。其他安装方式：

```sh
# 直接从 GitHub 安装（本包没有构建步骤）
dsh plugin --profile web add github:guyue55/dsh-disk-panel

# GitHub Release 上的预构建 tarball
dsh plugin --profile web add https://github.com/guyue55/dsh-disk-panel/releases/latest/download/dsh-disk-panel.tgz
```

## 使用

打开左侧栏「磁盘与工作区」。展开工作区点「计算占用」看顶层大目录；点白名单目录旁的垃圾桶按钮并确认；在「最近清理」里可以恢复。`发给 Agent 分析` 会新建会话并把扫描结果写进提示词。

## 配置

面板内「面板设置」写入 `$DSH_HOME/dev-panel/settings.json`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `monitor` | `true` | 启用看门狗与告警 |
| `notify` | `true` | 发送系统通知 |
| `warnRatio` / `warnFreeGB` | `0.10` / `20` | 警戒阈值（比例或绝对剩余） |
| `critRatio` / `critFreeGB` | `0.05` / `5` | 严重阈值 |
| `cooldownHours` | `6` | 按卷/等级的告警冷却 |
| `ignoredVolumes` | `[]` | 静音告警的卷 key |

客户端另外读取 `localStorage['sidebar-panel.options']` 的 `onlyWhenUnfocused`（默认 `true`）与 `monitor`（客户端静音）。

插件写入的数据（均位于 `$DSH_HOME/dev-panel/`）：

- `settings.json` — 看门狗设置。
- `cleanup-audit.jsonl` — 清理/恢复审计（追加式 JSONL，超过 512KiB 只保留最近 2000 条）。
- `history.jsonl` — 每分钟一条剩余空间采样（超过 2MiB 只保留最近 5000 条）。

共享同一 `DSH_HOME` 的多个 profile/实例会共享这些文件。

## 安全与权限

插件会读取磁盘统计与目录大小，并能把白名单目录移入废纸篓。Host 半体在 `/dev-panel/api` 下注册路由：

- 只读：`overview`、`scan`、`watch`；
- 需要 token：`config`、`audit`、`history`、`cleanup`、`restore`。

写路由需要 overview 下发的进程级 capability token，并经过 `ctx.connection.requestRejection()` 与同源头校验。清理只接受「已登记工作区的直接子目录 + 白名单文件名 + 非符号链接」，Host 执行前会再校验一次。路由由本机 DSH Host 提供；若把 webserver 绑到非回环地址，请自行加访问控制。

## 限制

- 清理仅 macOS；Linux/Windows 只能查看与统计。
- 超大目录或外置盘上的 `du` 可能触发 30 秒超时，面板会明确提示而不是给出错误大小。
- 恢复依赖废纸篓副本仍存在且 Host 用户可访问；否则提示去 Finder 手动放回。
- 通知走浏览器 Web Notification：桌面壳已授权，普通浏览器首次需要手势，macOS 系统层仍可能拦截。
- 看门狗只对未静音的卷告警，且按「卷 + 等级」6 小时冷却。

## 开发

没有构建步骤：Host 半体是 `index.js`，浏览器半体是 `client.js`（`window.__ModuleLoader__` 格式），纯 JavaScript。

```sh
node --check index.js
node --check client.js
npm test          # 清单校验 + 无头客户端行为测试
```

| 路径 | 作用 |
| --- | --- |
| `index.js` | Host：路由、`du`、废纸篓清理/恢复、审计、看门狗 |
| `client.js` | 浏览器：侧栏图标、面板、通知 |
| `cordis.patch.yml` | 插入插件行的 bundle patch |
| `locale/` | 插件管理页的中英文标题与描述 |
| `test/` | 清单校验与无头客户端测试（不需要浏览器） |

## License

[MIT](LICENSE)
