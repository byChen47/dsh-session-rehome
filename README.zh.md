# dsh-session-rehome

把 DSH 里的一条对话**原地搬到另一个工作区**：历史、标题、归档状态、**会话 id 全都不变**，不复制、不新建会话。

入口在侧栏对话行的「…」菜单里 —— **移动到其他工作区…** → 选目标 → 移动。

> DSH 自己做不到这件事：没有任何"改会话归属"的 API，归属是拿日志头部的 `cwd`
> 现算出来的。所以这个插件做的是真搬家：搬日志 + 改写头部 `cwd` + 改工作区记账。
> 详见下面的[它是怎么做到的](#它是怎么做到的)。

## 安装

```bash
dsh plugin --profile <profile> add dsh-session-rehome
```

在 DSH Desktop 里也可以走 **Plugins → 添加插件**，输入包名 `dsh-session-rehome`（或本仓库的本地路径）。

装完要**重启一次 DSH**：Host 半边是 Node 模块，不重启不会加载；之后刷新页面，菜单里才会出现这一项。

## 用起来

1. 鼠标移到侧栏里某个对话上，点 **…**；
2. 点 **移动到其他工作区…** —— 对话框只列出**别的**工作区（已经在里面的不会出现）；
3. 选一个、确认。列表立刻刷新，这条对话出现在目标工作区下面；
4. 打开它继续聊：它的 `cwd`、文件沙箱根、工具工作目录都已经在新目录里了。

如果搬的正是屏幕上打开的那个对话，**刷新一次页面**再打开它 —— 浏览器手里那份是旧的。

## 它会拒绝的情况

这些情况插件直接返回错误码，一个字节都不动：

| 情况 | 错误码 |
|---|---|
| 会话正在跑一轮（agent status = running） | `session-running` |
| 会话还没落盘（没发过消息） | `session-not-stored` |
| 子代理会话（`origin: subagent` 或 `delegationDepth > 0`） | `subagent-session` |
| 同一个 id 出现在多个项目目录下 | `duplicate-log` |
| 会话目录里有多份历史格式日志，或还有不认识的杂项文件 | `multiple-generations` / `session-dir-has-extras` |
| 目标工作区目录不存在 | `workspace-missing` |
| 写句柄里有没落盘的批次，刷盘失败 | `flush-failed` |

**正在跑一轮的会话宁可让你等一下，也不碰运行中的写链**：那一轮随时可能 append，搬家窗口里
挪目录会让事件写到一个不存在的路径。这是本插件和「正在回答也能搬」那类实现的核心取舍。

## 它是怎么做到的

DSH 里"一条会话属于哪个工作区"不是一张能随便改的表，而是**由日志头部的 `cwd` 现算**的
（`Workspace.candidateMatches` 拿 `realpath(header.cwd)` 跟工作区路径比），而日志目录名也是
从同一个字符串现推的（`projectKey`）。所以一次搬迁必须同时做三件事：

1. 日志从 `<sessions root>/<projectKey(旧cwd)>/<会话id>/` 搬到
   `<sessions root>/<projectKey(新cwd)>/<会话id>/`；
2. 日志第一帧里的 header `cwd` 改写成目标工作区路径 —— **只重压第一帧，后面所有事件帧
   逐字节原样保留**；
3. 目标工作区 `attachSession`、原工作区 `detachSession`。

如果这条会话此刻正被 Host 持有（`ctx.sessions` 里有它，或有未关闭的写句柄），同时改写内存里
的 `header.cwd` 与写句柄的 header，让它之后继续往新位置写。

三处不能颠倒的顺序，都是踩出来的：

- **先重建注册表头部索引，再 attach**。注册表只在服务启动时索引一次，不重建的话
  `attachSession` 会拿缓存里的旧 `cwd` 校验，直接报 `its cwd resolves to <旧路径>`。
- **先 detach，再 attach**。反过来说这个 id 会同时记在两个工作区的记账表里，
  `validateStoredState` 会在下次启动时抛 `accounted by both`，**整个应用起不来**。
- **先 flush 写句柄，再搬文件**。句柄缓冲里那批事件如果落后于搬家，会跟着被删的 inode 一起丢。

### 落盘是一个三步改名，不是一次 rename

1. 新日志以 `<生成名>.relocate-tmp` 写进目标目录 —— 这个名字不算 generation，后端看不见；
2. 源日志改名成 `<生成名>.relocate-old`；
3. `.relocate-tmp` 改名成规范名，然后删掉 `.relocate-old`、清掉空目录。

保证**任何时刻都不存在两份规范名日志**（后端发现同一 id 在两处会直接抛错，整个列表都读不出来）。

### 中断了怎么办

如果进程恰好在 2 与 3 之间挂掉，两边文件都还在：

- 新数据：`<目标目录>/session.v4.jsonl.zstd.relocate-tmp`
- 旧数据：`<源目录>/session.v4.jsonl.zstd.relocate-old`

把它们改名回 `session.v4.jsonl.zstd` 即可各自恢复。插件日志里有这对路径。

## 日志与端点

插件日志：`$DSH_HOME/logs/session-rehome.log`（默认 `~/.dsh/logs/session-rehome.log`），
一行一件事：挂载时的 client bundle 状态、每次搬迁的源/目标路径与字节数、每次拒绝的错误码。

同源、仅 owner。失败一律 `{"ok": false, "code": "...", "message": "..."}`。

| 端点 | 方法 | 入参 | 结果 |
|---|---|---|---|
| `/session-rehome/workspaces` | GET | — | `{ ok, workspaces: [{ id, title, path, sessionIds }] }` |
| `/session-rehome/move` | POST | `{ sessionId, workspaceId }` | `{ ok, sessionId, from, to, workspace, storage, memory, ... }` |

## 自测

```bash
npm test    # node test/rehome.test.mjs
```

20 项检查，全部现场合成数据、不碰任何真实会话：帧结构、字节守恒、header 封闭键集与键序、
目录名与 `projectKey(cwd)` 的一致性，以及各种拒绝条件。

## 已知限制

- **正在跑一轮的会话搬不了**，等它跑完再搬（这是刻意的安全取舍，见上）。
- 一个会话同时只能属于一个工作区 —— 这是 DSH 的模型，不是插件的选择。
- 用的是几个包私有入口（`sessionPersistence.tracker.writers`、`workspaceRegistry.headers`、
  `replaceHeaderIndex`、写句柄的 `header` 槽位）。每一处都做了 feature-detect：探测不到就
  退化或整体放弃，不会半途而废。DSH 换 rc 版本时这些可能变。
- **当前构建上验证过的是 DSH 0.2.1-rc.5**（Windows / Node 24）。其他版本没测。
- 需要 Node ≥ 22.15（内置 zstd）。

## 同类插件

这个领域已经有两个成熟的实现，按需选：

- [`dsh-session-relocate`](https://www.npmjs.com/package/dsh-session-relocate) —— 能搬**正在回答**的
  对话，还带拖拽、批量、子对话级联。功能最全。
- [`dsh-move-to-workspace`](https://www.npmjs.com/package/dsh-move-to-workspace) —— 复制历史成新会话、
  归档原会话（**会话 id 会变**）。

`dsh-session-rehome` 的定位是最小实现：只做真移动，会话 id 不变，拒绝运行中的会话，
代码量小、可逐行审。

## License

MIT
