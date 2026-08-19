# ws-cleaner — DSH 工作区自动/手动清理插件

DSH 动态 Cordis 插件(Host 半部),注册工具 `clean_workspace`:在每次任务完成后自动清理工作区里的不必要文件,并支持用户随时手动清理。

## 功能

- **任务完成后自动清理**:监听 `agent/turn-stopping` 与 `agent/status`(idle)双信号(5 秒防抖去重),按保守垃圾规则清理;默认把命中文件移入 `.dsh-trash/<时间戳>/` 回收区(可恢复),配置 `permanent: true` 时直接永久删除;同时清空超过 `trashKeepDays`(默认 7 天)的旧回收区
- **随时手动清理**:工具 `clean_workspace`,支持 `dry_run`(只统计)、`permanent`(永久删除)、`age_days`、`trash_keep_days`、`extra_patterns`、`keep_patterns`

## 清理规则(保守)

| 类别 | 规则 |
| --- | --- |
| 临时/备份/转储 | `*.tmp *.temp *.bak *.orig *.old *.dmp *.partial *.crdownload *.pyc` |
| 系统残留 | `.DS_Store`、`Thumbs.db`、`~$*` |
| 缓存目录 | `__pycache__` |
| 旧日志 | 超过 `ageDays`(默认 7 天)未修改的 `*.log` |

**永不触碰**:`.git` 目录、`.dsh-trash` 自身、`keepPatterns` 命中的文件。

## 配置

工作区根目录可选 `.dsh-cleaner.json`:

```json
{
  "enabled": true,
  "permanent": false,
  "ageDays": 7,
  "trashKeepDays": 7,
  "extraPatterns": ["*.abc"],
  "keepPatterns": ["*.ps1"]
}
```

- `permanent: true` → 自动清理直接永久删除(不进回收区)
- `enabled: false` → 关闭自动清理(手动工具不受影响)

## 加载到 DSH

1. 把本文件从 `return {` 开始到结尾的内容作为 `code.host` 交给动态插件工具 `cordis_define`(新插件给 3–6 位小写字母前缀,如 `clean`)
2. 用 `cordis_run` 运行插件
3. 会话内即可直接调用工具 `clean_workspace`

依赖服务(Host):`fs`(可选,读配置)、`shell`、`timer`、`harness`。

## 工具参数

| 参数 | 说明 |
| --- | --- |
| `dry_run` | `true` 只统计命中数量,不移动不删除 |
| `permanent` | `true` 直接永久删除,否则移入 `.dsh-trash` 回收区 |
| `age_days` | `*.log` 保留天数,超过才清理(默认 7) |
| `purge_trash` | 是否清空超过 `trash_keep_days` 天的旧回收区(默认 true) |
| `trash_keep_days` | 回收区保留天数(默认 7) |
| `extra_patterns` | 额外通配符(如 `*.abc`),追加到内置规则 |
| `keep_patterns` | 永不清理的通配符(如 `*.ps1`,按文件名匹配) |

## 版本

- **v1**:`clean_workspace` 手动清理工具 + `agent/turn-stopping` 自动清理(移入回收区)
- **v2**:自动清理改双信号触发(`agent/turn-stopping` + `agent/status`→idle,防抖去重、不依赖定时器调度,修复 v1 自动触发未生效问题);新增 `permanent` 配置,支持自动清理永久删除模式
