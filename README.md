# dsh-knowledge-base · 我的知识库

[![Release](https://img.shields.io/github/v/release/qinshige/dsh-knowledge-base)](https://github.com/qinshige/dsh-knowledge-base/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

给 DeepSeek Harness 加一个**左侧栏入口 + 独立知识库页面**：

- 在「我的知识库」里**上传跨境选品知识文档**（Markdown / TXT / DOCX / XLSX / CSV / HTML 等）；
- 之后在**任意对话**里问跨境选品问题，Agent 会**先检索知识库、再回答**，并引用文档标题；
- 知识库内容会以动态上下文的形式出现在每次模型请求里（文档清单），模型不必先调工具就知道库里有什么。

## 功能

### 左侧栏入口与知识库页面

- 左侧栏面板图标区新增「**我的知识库**」图标，点开是完整的知识库页面；
- **上传**：拖拽或多个选择、按分类入库存档；逐文件显示上传状态与失败原因；
- **列表**：标题、分类、字数、片段数、入库时间、正文首行预览；可直接改分类；
- **检索测试**：页面内按关键词检索知识库，命中片段高亮关键词，可跳转文档预览；
- **预览**：查看文档全文（弹层，Esc / 点遮罩关闭）；
- **删除**：两步确认后删除（不可恢复）。

### 给 Agent 的 6 个工具

| 工具 | 作用 |
| --- | --- |
| `kb_list_documents` | 列出知识库文档与统计，回答前确认覆盖范围 |
| `kb_search` | 中文 BM25 检索（bigram 分词），返回片段 + 文档标题 + docId |
| `kb_read_document` | 按片段读取某篇文档全文（分段读，避免一次撑爆上下文） |
| `kb_add_document` | 从本地路径导入文件（用户说「把这个文档加进知识库」） |
| `kb_update_document` | 修改文档标题 / 分类 |
| `kb_delete_document` | 删除文档（必须先得到用户明确同意，且传 `confirm: true`） |

### 系统提示

- 静态规则：跨境选品问题 → 先 `kb_search` → 不够再 `kb_read_document` → 回答引用文档标题；库内没有的内容必须标注为「知识库外的通用经验」；
- 动态上下文：每次请求注入当前文档清单（标题 / 分类 / 字数 / id），知识库为空时给出上传指引。

## 使用

1. 左侧栏点「我的知识库」；
2. 把文档拖进上传区（或点「选择文件」），选一个分类，等状态变为「已入库」；
3. 回到任意对话，直接提问，例如：
   - 「按照我的知识库，新手做亚马逊美国站应该按什么标准选品？」
   - 「我的知识库里关于物流成本的阈值是多少？」
   - 「把知识库里合规相关的内容整理成清单」
4. 也可以在对话里说「把 `~/Desktop/选品资料.docx` 加进知识库」，Agent 会调 `kb_add_document`。

仓库自带一份示例文档：[sample/跨境选品示例文档.md](sample/跨境选品示例文档.md)，上传后即可验证问答效果。

## 数据在哪

| 内容 | 位置 |
| --- | --- |
| 文档正文 + 元数据 | `$DSH_HOME/knowledge-base/docs/<id>.json` |
| 未设置 `DSH_HOME` 时 | `~/.dsh/knowledge-base/docs/` |

- 页面底部会显示实际数据目录；备份/迁移直接拷贝整个 `knowledge-base/` 目录即可；
- 原始文件字节不保存，只保存提取后的正文（上限 60 万字/篇），因此不支持「下载原文件」；
- 检索索引是内存派生缓存，启动后首次检索时按需构建。

## 支持格式与限制

支持：`.md` `.markdown` `.txt` `.csv` `.tsv` `.json` `.html` `.yml` `.yaml` `.docx` `.xlsx`。

- **PDF 不支持**：解析 CJK 字体映射需要完整 PDF 引擎，做不对比做不了更糟；请另存为 `.docx` / `.txt` 后上传；
- `.doc` / `.xls` / `.ppt` 等旧格式不支持，请另存为新格式；
- 单文件 ≤ 25MB、单篇正文 ≤ 60 万字（超出部分截断）；
- 接口只接受本机环回访问（不对外暴露）。

## 安装 / 分发

插件是**纯 JS 源包**：没有构建步骤、没有 `install` / `prepare` 脚本、没有第三方依赖，
所以 `pnpm` 的构建闸门不会拦它，任何标准 DSH 0.2.x（实测 0.2.1-rc.5）都能直接装。

### 方式 A：Release tarball（推荐，给其他人用）

从 [Releases](https://github.com/qinshige/dsh-knowledge-base/releases) 下载 `dsh-knowledge-base-0.1.0.tgz`，对方执行：

```sh
# 本地文件
dsh plugin --profile <profile> add /绝对路径/dsh-knowledge-base-0.1.0.tgz
# 或直接用 URL（Release 资产直链）
dsh plugin --profile <profile> add https://github.com/qinshige/dsh-knowledge-base/releases/download/v0.1.0/dsh-knowledge-base-0.1.0.tgz

# 确认已进入层栈
dsh --profile <profile> --dump-config | grep dsh-knowledge-base
```

装完**重启 Harness**，刷新 Web 页面；左侧栏出现「我的知识库」图标即成功。
（首次插入宿主行有时可热生效，但重启是最稳的路径。）

### 方式 B：从 Git 仓库装

```sh
dsh plugin --profile <profile> add https://github.com/qinshige/dsh-knowledge-base.git
```

> ⚠️ **别用仓库地址代替 tarball 装**：Git 依赖会走 pnpm 的构建闸门，可能要求 `allowBuilds`。
> 本插件**没有**构建脚本，tarball 路径不受影响；要用仓库地址请用 `--ignore-scripts` 或先 clone 再 `add <目录>`。

### 方式 C：发布到 npm

1. `npm publish`（`package.json` 已去掉 `private` 字段，可直接发布）；
2. 若 `dsh-knowledge-base` 这个包名已被占用，改成 `@你的scope/dsh-knowledge-base`，
   并同步修改 `cordis.patch.yml` 里的 `name` 与 `client.js` 里的模块 `id`；
3. 使用者改为：`dsh plugin --profile <profile> add dsh-knowledge-base`。

### 方式 D：本地目录（开发用）

`dsh plugin add <目录绝对路径>`（或 Harness 的 `plugin_manager` `install_bundle`）：
pnpm 会以 link 方式接入，改代码即时生效（宿主半需重启，client 半配合 `pnpm run dev:web` 可热更新）。

### 升级

改版本号 → 重新 `pnpm pack`（或重新发布）→ 使用者重装；**替换已安装包必须重启 Harness**。
数据目录 `~/.dsh/knowledge-base` 与包版本无关，升级不会丢文档。

### 兼容性

- 需要带 `webServer` / `systemPrompt` / `tools` 服务的标准 Web profile（desktop、`dsh web` 默认即是）；
- client 半使用 `sidebar.panellist` + `main` 插槽和 `locale` 服务，DSH 0.2.x 实测可用；
- 不依赖任何厂商 Key / 网络服务，装完即可离线使用。

### 打包命令

```sh
pnpm pack --pack-destination ./release   # 产物：release/dsh-knowledge-base-0.1.0.tgz
tar -tzf release/dsh-knowledge-base-0.1.0.tgz   # 核对包内文件
```

## 开发与测试

```sh
node --test test/smoke.mjs test/routes.mjs   # 纯 Node，无第三方依赖
```

- `test/smoke.mjs`：提取（含现场构造 docx/xlsx）、分块、BM25、知识库增删改查/持久化、6 个工具、系统提示；
- `test/routes.mjs`：真起 HTTP server，跑上传 → 列表 → 检索 → 预览 → 改分类 → 删除，以及错误语义。

## 目录

```
index.js          宿主入口：注册工具、惰性挂载 HTTP 路由与系统提示
client.js         client 半：侧栏图标 + 知识库页面（手写 JS，无构建）
host/
  paths.js        数据目录解析与路径安全
  extract.js      正文提取（纯文本 / HTML / DOCX / XLSX，零依赖）
  chunk.js        分块（段落/句子 + 目标字数 + 重叠）
  search.js       中文 BM25（CJK bigram + 英文单词）
  library.js      存储、索引、增删改查、目录摘要
  tools.js        6 个 kb_* 工具
  routes.js       /knowledge-base/api/* HTTP 接口
  guidance.js     系统提示静态规则 + 动态文档清单
locale/           插件管理器显示名（中/英）
sample/           示例知识文档
test/             node:test 测试
```

## 安全边界

- HTTP 接口只接受 `127.0.0.1` / `::1` 等环回来源；
- 上传/JSON 体都有字节上限，超限立即拒绝；
- 文档 id 由插件生成（`kb_<base36><hex>`）并做白名单校验，不接受任意路径；
- `kb_delete_document` 工具强制 `confirm: true`，且要求在用户明确同意后调用。
