/**
 * dsh-knowledge-base —— Client 半（手写 JS，无构建步骤）。
 *
 * 装载契约（与 dsh-pixmart 一致）：
 *   - 产物是 `window.__ModuleLoader__.load({ id:'dsh-knowledge-base', factory })`；
 *   - `factory(require)` 只收到 `require`，没有 `host.call`；与宿主的通信**只能**走
 *     本插件自己的 HTTP 路由（`/knowledge-base/api/*`）。
 *
 * 两个落点：
 *   ① `sidebar.panellist` → 左侧栏多一个「我的知识库」入口（id 与主面板 key 一一对应）；
 *   ② `main`（keyed, key = 'knowledge-base'）→ 中央知识库页面：上传 / 列表 / 检索 / 预览 / 删除。
 *
 * 硬约束：
 *   - 只用 `require('react')` + `React.createElement`（无 JSX）；
 *   - 所有副作用（插槽注册 / 样式 / 监听）都包在 `ctx.effect` 里，随卸载清理；
 *   - 任何插槽注册失败只让该功能缺失，不冒泡；
 *   - 配色只用 DSH 主题 token（`--dsw-alias-*`），深浅色主题自动一致；
 *   - HTTP 基址相对挂载点解析，不写死 `/knowledge-base/...` 根绝对路径。
 */
window.__ModuleLoader__.load({
  id: 'dsh-knowledge-base',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PLUGIN = 'dsh-knowledge-base'
    const PANEL_KEY = 'knowledge-base'
    const NS = 'dsh-knowledge-base'
    const STYLE_ID = 'dsh-knowledge-base-style'

    /** 相对挂载点解析基址（支持路径前缀部署）。 */
    const API = (() => {
      try {
        return new URL('knowledge-base/api/', document.baseURI)
      } catch {
        return null
      }
    })()

    const ACCEPT =
      '.md,.markdown,.mdx,.txt,.text,.log,.csv,.tsv,.json,.jsonl,.html,.htm,.xml,.yml,.yaml,.docx,.xlsx'

    const DEFAULT_CATEGORIES = [
      '未分类',
      '选品方法',
      '平台规则',
      '品类研究',
      '市场数据',
      '供应链物流',
      '合规认证',
      '营销广告',
      '其他',
    ]

    // ────────────────────────────────────────────────────────────── 文案（locale）

    const ZH = {
      'panel.entryLabel': '我的知识库',
      'panel.title': '我的知识库',
      'panel.subtitle': '上传跨境选品文档；对话里的选品问题会先检索这里，再作答',
      'panel.refresh': '刷新',
      'panel.refreshAria': '刷新知识库列表',
      'panel.loading': '正在读取知识库…',
      'panel.errorTitle': '知识库加载失败',
      'panel.retry': '重试',

      'stats.summary': '{docs} 篇文档 · {chunks} 个片段',
      'stats.empty': '还没有文档',

      'upload.title': '上传知识文档',
      'upload.hint':
        '拖拽文件到这里，或点击选择。支持 .md / .txt / .docx / .xlsx / .csv / .html，单个文件 ≤ 25MB；PDF 请先转存为 .docx 或 .txt。',
      'upload.choose': '选择文件',
      'upload.dropActive': '松开即可上传',
      'upload.category': '入库分类',
      'upload.uploading': '上传中…',
      'upload.done': '已入库',
      'upload.failed': '失败',
      'upload.again': '移除',
      'upload.empty': '没有可上传的文件',
      'upload.dismiss': '清除记录',

      'search.title': '检索测试',
      'search.placeholder': '检索知识库，例如：亚马逊 选品 利润率',
      'search.aria': '检索知识库',
      'search.clear': '清空检索',
      'search.hint': '这里只是测试检索效果；在对话里直接问选品问题，Agent 会自动检索知识库。',
      'search.results': '命中 {n} 个片段',
      'search.loading': '检索中…',
      'search.empty': '没有命中，换个关键词或分类试试。',
      'search.failed': '检索失败',
      'search.viewDoc': '查看文档',
      'search.categoryAll': '全部分类',

      'list.title': '文档列表',
      'list.count': '{n} 篇',
      'list.emptyTitle': '知识库还是空的',
      'list.emptyBody':
        '先上传跨境选品相关的文档（.md / .txt / .docx / .xlsx / .csv / .html），然后在任意对话里直接问选品问题——Agent 会先检索这里的内容再回答。',
      'list.preview': '预览',
      'list.delete': '删除',
      'list.deleteConfirm': '确认删除',
      'list.deleteCancel': '取消',
      'list.deleting': '删除中…',
      'list.categoryAria': '修改「{title}」的分类',
      'list.addedAt': '入库于 {time}',
      'list.units': '{chars} · {chunks}',

      'preview.title': '文档预览',
      'preview.close': '关闭预览',
      'preview.loading': '正在读取文档…',
      'preview.failed': '文档读取失败',
      'preview.meta': '{category} · {chars} · {chunks} · 入库于 {time}',
      'preview.empty': '这篇文档没有正文内容。',

      'footer.dataDir': '数据目录：{path}',
      'footer.formats': '支持格式：{formats}',
      'footer.use': '用法：在任何对话里问跨境选品问题，Agent 会先检索知识库；也可以说「把这份文件加进知识库」。',

      'unit.chars': '{n} 字',
      'unit.charsWan': '{n} 万字',
      'unit.chunks': '{n} 个片段',
      'unit.count': '{n}',
      'unit.docs': '{n} 篇',

      'error.generic': '操作失败',
      'error.hint': '提示',
    }

    const EN = {
      'panel.entryLabel': 'My Knowledge Base',
      'panel.title': 'My Knowledge Base',
      'panel.subtitle': 'Upload cross-border sourcing docs; chat questions are answered from this library first',
      'panel.refresh': 'Refresh',
      'panel.refreshAria': 'Refresh the document list',
      'panel.loading': 'Loading knowledge base…',
      'panel.errorTitle': 'Failed to load the knowledge base',
      'panel.retry': 'Retry',

      'stats.summary': '{docs} docs · {chunks} chunks',
      'stats.empty': 'No documents yet',

      'upload.title': 'Upload knowledge documents',
      'upload.hint':
        'Drop files here or click to choose. Supports .md / .txt / .docx / .xlsx / .csv / .html, up to 25MB each. Convert PDF to .docx or .txt first.',
      'upload.choose': 'Choose files',
      'upload.dropActive': 'Release to upload',
      'upload.category': 'Category',
      'upload.uploading': 'Uploading…',
      'upload.done': 'Added',
      'upload.failed': 'Failed',
      'upload.again': 'Remove',
      'upload.empty': 'No files to upload',
      'upload.dismiss': 'Clear',

      'search.title': 'Search test',
      'search.placeholder': 'Search the knowledge base, e.g. Amazon sourcing margin',
      'search.aria': 'Search the knowledge base',
      'search.clear': 'Clear search',
      'search.hint': 'This only tests retrieval. In chat, just ask a sourcing question — the agent retrieves from this library automatically.',
      'search.results': '{n} matching chunks',
      'search.loading': 'Searching…',
      'search.empty': 'No matches. Try other keywords or another category.',
      'search.failed': 'Search failed',
      'search.viewDoc': 'Open document',
      'search.categoryAll': 'All categories',

      'list.title': 'Documents',
      'list.count': '{n}',
      'list.emptyTitle': 'The knowledge base is empty',
      'list.emptyBody':
        'Upload cross-border sourcing documents (.md / .txt / .docx / .xlsx / .csv / .html), then ask sourcing questions in any chat — the agent retrieves from here before answering.',
      'list.preview': 'Preview',
      'list.delete': 'Delete',
      'list.deleteConfirm': 'Confirm delete',
      'list.deleteCancel': 'Cancel',
      'list.deleting': 'Deleting…',
      'list.categoryAria': 'Change the category of {title}',
      'list.addedAt': 'added {time}',
      'list.units': '{chars} · {chunks}',

      'preview.title': 'Document preview',
      'preview.close': 'Close preview',
      'preview.loading': 'Loading document…',
      'preview.failed': 'Failed to load the document',
      'preview.meta': '{category} · {chars} · {chunks} · added {time}',
      'preview.empty': 'This document has no text content.',

      'footer.dataDir': 'Data directory: {path}',
      'footer.formats': 'Supported: {formats}',
      'footer.use':
        'Usage: ask cross-border sourcing questions in any chat; the agent retrieves from this library first. You can also say “add this file to my knowledge base”.',

      'unit.chars': '{n} chars',
      'unit.charsWan': '{n}×10k chars',
      'unit.chunks': '{n} chunks',
      'unit.count': '{n}',
      'unit.docs': '{n}',

      'error.generic': 'Operation failed',
      'error.hint': 'Hint',
    }

    const LOCALE_TAGS = ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', 'zh-Hant', 'en', 'en-US']

    // ────────────────────────────────────────────────────────────── HTTP

    async function request(path, options) {
      if (API === null) throw new Error('API base unavailable')
      let response
      try {
        response = await fetch(new URL(path, API), {
          credentials: 'same-origin',
          cache: 'no-store',
          ...options,
        })
      } catch (error) {
        throw new Error(`无法连接宿主接口：${error && error.message ? error.message : String(error)}`)
      }
      let data = null
      try {
        data = await response.json()
      } catch {
        /* 非 JSON 响应由下面的状态码分支处理 */
      }
      if (!response.ok || data === null || data.ok !== true) {
        const detail = data && data.error ? data.error : null
        const error = new Error(detail && detail.message ? detail.message : `请求失败（HTTP ${response.status}）`)
        if (detail && detail.code) error.code = detail.code
        if (detail && detail.hint) error.hint = detail.hint
        throw error
      }
      return data
    }

    async function uploadFile(file, category) {
      const headers = {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
      }
      if (category) headers['x-category'] = encodeURIComponent(category)
      return request('upload', { method: 'POST', headers, body: file })
    }

    function formatTime(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return '—'
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    /** 在正文里截取命中词附近的片段，并把命中词包成 `<mark>`。 */
    function makeSnippet(text, query, maxChars) {
      const limit = maxChars === undefined ? 300 : maxChars
      const source = String(text || '')
      const terms = String(query || '')
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 0)
      let start = 0
      let earliest = -1
      for (const term of terms) {
        const index = source.toLowerCase().indexOf(term.toLowerCase())
        if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index
      }
      if (earliest > 60) start = earliest - 60
      let snippet = source.slice(start, start + limit)
      const prefix = start > 0 ? '…' : ''
      const suffix = start + limit < source.length ? '…' : ''
      if (terms.length === 0) return [prefix + snippet + suffix]
      const pattern = new RegExp('(' + terms.map(escapeRegExp).join('|') + ')', 'gi')
      const parts = snippet.split(pattern)
      const nodes = []
      parts.forEach((part, index) => {
        if (part === '') return
        if (index % 2 === 1) nodes.push(h('mark', { key: `m${index}`, className: 'kb-mark' }, part))
        else nodes.push(part)
      })
      return [prefix, ...nodes, suffix]
    }

    // ────────────────────────────────────────────────────────────── 图标

    function svgBase(size, children) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: '0 0 auto' },
        },
        ...children,
      )
    }

    function IconBook(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      return svgBase(size, [
        h('path', { key: 'a', d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H11v18H6.5A2.5 2.5 0 0 0 4 23.5v-18Z' }),
        h('path', { key: 'b', d: 'M20 5.5A2.5 2.5 0 0 0 17.5 3H13v18h4.5a2.5 2.5 0 0 1 2.5 2.5v-18Z' }),
      ])
    }

    function IconUpload(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      return svgBase(size, [
        h('path', { key: 'a', d: 'M12 16V4' }),
        h('path', { key: 'b', d: 'm7 9 5-5 5 5' }),
        h('path', { key: 'c', d: 'M4 16v2.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V16' }),
      ])
    }

    function IconSearch(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      return svgBase(size, [
        h('circle', { key: 'a', cx: 11, cy: 11, r: 6.5 }),
        h('path', { key: 'b', d: 'm16 16 4.5 4.5' }),
      ])
    }

    function IconRefresh(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      return svgBase(size, [
        h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.3 5.7' }),
        h('path', { key: 'b', d: 'M20 4v7h-7' }),
      ])
    }

    function IconTrash(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      return svgBase(size, [
        h('path', { key: 'a', d: 'M4 7h16' }),
        h('path', { key: 'b', d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }),
        h('path', { key: 'c', d: 'M6 7l.8 12a2 2 0 0 0 2 1.9h6.4a2 2 0 0 0 2-1.9L18 7' }),
        h('path', { key: 'd', d: 'M10 11v6M14 11v6' }),
      ])
    }

    function IconClose(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      return svgBase(size, [h('path', { key: 'a', d: 'M6 6l12 12M18 6 6 18' })])
    }

    function IconFile(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 16
      return svgBase(size, [
        h('path', { key: 'a', d: 'M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Z' }),
        h('path', { key: 'b', d: 'M13 3v6h6' }),
      ])
    }

    function Spinner(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 14
      return h('span', {
        className: 'kb-spinner',
        style: { width: size + 'px', height: size + 'px' },
        'aria-hidden': 'true',
      })
    }

    // ────────────────────────────────────────────────────────────── 页面组件

    function createPanel(ctx) {
      const translate = (() => {
        try {
          const bound = ctx.locale.bind(NS)
          return typeof bound === 'function' ? bound : (key) => key
        } catch {
          return (key) => key
        }
      })()

      function t(key, vars) {
        let raw
        try {
          raw = translate(key)
        } catch {
          raw = key
        }
        if (!vars) return raw
        return String(raw).replace(/\{(\w+)\}/g, (match, name) =>
          vars[name] === undefined ? match : String(vars[name]),
        )
      }

      function useLocaleTick() {
        const [, setRevision] = React.useState(0)
        React.useEffect(() => {
          if (typeof ctx.locale.subscribe !== 'function') return undefined
          let alive = true
          let unsubscribe = null
          try {
            unsubscribe = ctx.locale.subscribe(() => {
              if (alive) setRevision((value) => value + 1)
            })
          } catch {
            return undefined
          }
          return () => {
            alive = false
            if (typeof unsubscribe === 'function') unsubscribe()
          }
        }, [])
      }

      function formatChars(chars) {
        const value = Number(chars) || 0
        if (value >= 10000) return t('unit.charsWan', { n: (value / 10000).toFixed(1) })
        return t('unit.chars', { n: value })
      }

      function formatChunks(count) {
        return t('unit.chunks', { n: Number(count) || 0 })
      }

      function errorText(error) {
        if (!error) return t('error.generic')
        return String(error.message || error)
      }

      /** 文档分类下拉：预设分类 + 文档里出现过的自定义分类。 */
      function categoryOptions(categories, current) {
        const set = new Set(DEFAULT_CATEGORIES)
        for (const category of Array.isArray(categories) ? categories : []) {
          if (typeof category === 'string' && category !== '') set.add(category)
        }
        if (typeof current === 'string' && current !== '') set.add(current)
        return [...set]
      }

      // ── 数据加载 ─────────────────────────────────────────────────────────

      function useLibrary() {
        const [state, setState] = React.useState({
          phase: 'loading',
          docs: [],
          stats: null,
          categories: DEFAULT_CATEGORIES,
          error: null,
        })
        const reload = React.useCallback(async () => {
          setState((previous) => ({
            ...previous,
            phase: previous.stats === null ? 'loading' : 'refreshing',
            error: null,
          }))
          try {
            const data = await request('library')
            setState({
              phase: 'ready',
              docs: Array.isArray(data.docs) ? data.docs : [],
              stats: data.stats || null,
              categories: Array.isArray(data.categories) ? data.categories : DEFAULT_CATEGORIES,
              error: null,
            })
          } catch (error) {
            setState((previous) => ({ ...previous, phase: 'error', error }))
          }
        }, [])
        React.useEffect(() => {
          void reload()
        }, [reload])
        return { state, reload }
      }

      // ── 上传 ─────────────────────────────────────────────────────────────

      function UploadCard(props) {
        const { categories, onUploaded } = props
        const inputRef = React.useRef(null)
        const [dragging, setDragging] = React.useState(false)
        const [category, setCategory] = React.useState('未分类')
        const [queue, setQueue] = React.useState([])
        const queueRef = React.useRef([])
        const [busy, setBusy] = React.useState(false)

        const updateQueue = React.useCallback((updater) => {
          queueRef.current = updater(queueRef.current)
          setQueue(queueRef.current)
        }, [])

        const handleFiles = React.useCallback(
          async (fileList) => {
            const files = Array.from(fileList || []).filter((file) => file && file.size > 0)
            if (files.length === 0) {
              updateQueue((previous) => [
                ...previous,
                { id: `empty-${Date.now()}`, name: t('upload.empty'), status: 'error', message: '' },
              ])
              return
            }
            const entries = files.map((file, index) => ({
              id: `${Date.now()}-${index}-${file.name}`,
              name: file.name,
              size: file.size,
              status: 'queued',
              file,
            }))
            updateQueue((previous) => [...previous, ...entries])
            setBusy(true)
            for (const entry of entries) {
              updateQueue((previous) =>
                previous.map((item) => (item.id === entry.id ? { ...item, status: 'uploading' } : item)),
              )
              try {
                await uploadFile(entry.file, category === '未分类' ? '' : category)
                updateQueue((previous) =>
                  previous.map((item) =>
                    item.id === entry.id ? { ...item, status: 'done', message: '' } : item,
                  ),
                )
              } catch (error) {
                updateQueue((previous) =>
                  previous.map((item) =>
                    item.id === entry.id
                      ? { ...item, status: 'error', message: errorText(error), hint: error && error.hint }
                      : item,
                  ),
                )
              }
            }
            setBusy(false)
            onUploaded()
          },
          [category, onUploaded, updateQueue],
        )

        const onDrop = (event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(false)
          void handleFiles(event.dataTransfer && event.dataTransfer.files)
        }

        const onDragOver = (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (!dragging) setDragging(true)
        }

        const onDragLeave = (event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(false)
        }

        const pending = queue.filter((item) => item.status === 'uploading' || item.status === 'queued').length

        return h(
          'section',
          { className: 'kb-card kb-upload' },
          h(
            'div',
            { className: 'kb-card-head' },
            h('span', { className: 'kb-card-icon' }, h(IconUpload, { size: 16 })),
            h('h2', { className: 'kb-card-title' }, t('upload.title')),
            busy ? h(Spinner, { size: 14 }) : null,
            h('span', { className: 'kb-spacer' }),
            h(
              'label',
              { className: 'kb-field' },
              h('span', { className: 'kb-field-label' }, t('upload.category')),
              h(
                'select',
                {
                  className: 'kb-select',
                  value: category,
                  onChange: (event) => setCategory(event.target.value),
                  disabled: busy,
                },
                categoryOptions(categories, category).map((option) =>
                  h('option', { key: option, value: option }, option),
                ),
              ),
            ),
          ),
          h(
            'div',
            {
              className: 'kb-drop',
              'data-over': dragging ? 'true' : 'false',
              role: 'button',
              tabIndex: 0,
              'aria-label': t('upload.choose'),
              onClick: () => {
                if (inputRef.current) inputRef.current.click()
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  if (inputRef.current) inputRef.current.click()
                }
              },
              onDragEnter: onDragOver,
              onDragOver,
              onDragLeave,
              onDrop,
            },
            h('span', { className: 'kb-drop-icon' }, h(IconUpload, { size: 22 })),
            h('span', { className: 'kb-drop-title' }, dragging ? t('upload.dropActive') : t('upload.choose')),
            h('span', { className: 'kb-drop-hint' }, t('upload.hint')),
          ),
          h('input', {
            ref: inputRef,
            type: 'file',
            multiple: true,
            accept: ACCEPT,
            style: { display: 'none' },
            onChange: (event) => {
              const files = event.target.files
              void handleFiles(files)
              event.target.value = ''
            },
          }),
          queue.length > 0
            ? h(
                'ul',
                { className: 'kb-queue' },
                ...queue.map((item) =>
                  h(
                    'li',
                    { key: item.id, className: 'kb-queue-item' },
                    h('span', { className: 'kb-queue-name', title: item.name }, item.name),
                    h(
                      'span',
                      { className: 'kb-queue-status', 'data-status': item.status },
                      item.status === 'uploading'
                        ? h(React.Fragment, null, h(Spinner, { size: 11 }), ' ', t('upload.uploading'))
                        : item.status === 'done'
                          ? t('upload.done')
                          : item.status === 'error'
                            ? t('upload.failed')
                            : '…',
                    ),
                    item.status === 'error' && item.message
                      ? h('span', { className: 'kb-queue-error' }, item.message)
                      : null,
                    item.status === 'error'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'kb-btn kb-btn-ghost',
                            onClick: () => {
                              updateQueue((previous) => previous.filter((entry) => entry.id !== item.id))
                            },
                          },
                          t('upload.again'),
                        )
                      : null,
                  ),
                ),
                h(
                  'li',
                  { className: 'kb-queue-clear' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'kb-btn kb-btn-ghost',
                      onClick: () => updateQueue(() => []),
                      disabled: pending > 0,
                    },
                    t('upload.dismiss'),
                  ),
                ),
              )
            : null,
        )
      }

      // ── 检索 ─────────────────────────────────────────────────────────────

      function SearchCard(props) {
        const { categories, onOpenDoc } = props
        const [query, setQuery] = React.useState('')
        const [category, setCategory] = React.useState('')
        const [state, setState] = React.useState({ phase: 'idle', results: [], error: null })
        const sequence = React.useRef(0)

        React.useEffect(() => {
          const value = query.trim()
          if (value === '') {
            setState({ phase: 'idle', results: [], error: null })
            return undefined
          }
          const ticket = sequence.current + 1
          sequence.current = ticket
          setState((previous) => ({ ...previous, phase: 'loading', error: null }))
          const timer = setTimeout(async () => {
            try {
              const params = new URLSearchParams({ q: value, limit: '10' })
              if (category !== '') params.set('category', category)
              const data = await request(`search?${params.toString()}`)
              if (sequence.current !== ticket) return
              setState({ phase: 'ready', results: Array.isArray(data.results) ? data.results : [], error: null })
            } catch (error) {
              if (sequence.current !== ticket) return
              setState({ phase: 'error', results: [], error })
            }
          }, 260)
          return () => clearTimeout(timer)
        }, [query, category])

        return h(
          'section',
          { className: 'kb-card' },
          h('h2', { className: 'kb-card-title kb-search-title' }, t('search.title')),
          h(
            'div',
            { className: 'kb-search-row' },
            h('span', { className: 'kb-search-icon' }, h(IconSearch, { size: 16 })),
            h('input', {
              className: 'kb-input kb-search-input',
              type: 'search',
              value: query,
              placeholder: t('search.placeholder'),
              'aria-label': t('search.aria'),
              onChange: (event) => setQuery(event.target.value),
            }),
            h(
              'select',
              {
                className: 'kb-select',
                value: category,
                'aria-label': t('search.categoryAll'),
                onChange: (event) => setCategory(event.target.value),
              },
              h('option', { value: '' }, t('search.categoryAll')),
              ...categoryOptions(categories).map((option) => h('option', { key: option, value: option }, option)),
            ),
            query !== ''
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'kb-btn kb-btn-ghost kb-icon-btn',
                    title: t('search.clear'),
                    'aria-label': t('search.clear'),
                    onClick: () => setQuery(''),
                  },
                  h(IconClose, { size: 14 }),
                )
              : null,
          ),
          h('p', { className: 'kb-hint' }, t('search.hint')),
          state.phase === 'loading'
            ? h('p', { className: 'kb-muted' }, h(Spinner, { size: 12 }), ' ', t('search.loading'))
            : null,
          state.phase === 'error'
            ? h('p', { className: 'kb-error-text' }, t('search.failed'), '：', errorText(state.error))
            : null,
          state.phase === 'ready'
            ? h(
                React.Fragment,
                null,
                h('p', { className: 'kb-muted' }, t('search.results', { n: state.results.length })),
                state.results.length === 0
                  ? h('p', { className: 'kb-muted' }, t('search.empty'))
                  : h(
                      'ul',
                      { className: 'kb-results' },
                      ...state.results.map((result, index) =>
                        h(
                          'li',
                          { key: `${result.docId}-${result.chunkIndex}-${index}`, className: 'kb-result' },
                          h(
                            'div',
                            { className: 'kb-result-head' },
                            h('span', { className: 'kb-result-title' }, result.title),
                            h('span', { className: 'kb-badge' }, result.category),
                            h('span', { className: 'kb-muted kb-result-chunk' }, `#${Number(result.chunkIndex) + 1}`),
                            h('span', { className: 'kb-spacer' }),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'kb-btn kb-btn-ghost',
                                onClick: () => onOpenDoc(result.docId),
                              },
                              t('search.viewDoc'),
                            ),
                          ),
                          h('p', { className: 'kb-result-text' }, ...makeSnippet(result.text, query, 320)),
                        ),
                      ),
                    ),
              )
            : null,
        )
      }

      // ── 文档列表 ─────────────────────────────────────────────────────────

      function DocRow(props) {
        const { doc, categories, onPreview, onDelete, onCategory, deleting } = props
        const [confirming, setConfirming] = React.useState(false)
        return h(
          'li',
          { className: 'kb-doc' },
          h('span', { className: 'kb-doc-icon' }, h(IconFile, { size: 17 })),
          h(
            'div',
            { className: 'kb-doc-main' },
            h('div', { className: 'kb-doc-title-row' }, h('span', { className: 'kb-doc-title', title: doc.title }, doc.title)),
            h(
              'div',
              { className: 'kb-doc-meta' },
              h(
                'select',
                {
                  className: 'kb-select kb-select-inline',
                  value: doc.category,
                  'aria-label': t('list.categoryAria', { title: doc.title }),
                  onChange: (event) => onCategory(doc.id, event.target.value),
                },
                ...categoryOptions(categories, doc.category).map((option) =>
                  h('option', { key: option, value: option }, option),
                ),
              ),
              h(
                'span',
                null,
                t('list.units', {
                  chars: formatChars(doc.chars),
                  chunks: formatChunks(doc.chunkCount),
                }),
              ),
              h('span', null, t('list.addedAt', { time: formatTime(doc.createdAt) })),
            ),
            doc.preview ? h('p', { className: 'kb-doc-preview' }, doc.preview) : null,
          ),
          h(
            'div',
            { className: 'kb-doc-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'kb-btn kb-btn-ghost',
                onClick: () => onPreview(doc.id),
              },
              t('list.preview'),
            ),
            confirming
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'kb-btn kb-btn-danger',
                      disabled: deleting,
                      onClick: () => {
                        setConfirming(false)
                        onDelete(doc.id)
                      },
                    },
                    deleting ? h(Spinner, { size: 11 }) : null,
                    ' ',
                    t('list.deleteConfirm'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'kb-btn kb-btn-ghost',
                      disabled: deleting,
                      onClick: () => setConfirming(false),
                    },
                    t('list.deleteCancel'),
                  ),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'kb-btn kb-btn-ghost',
                    onClick: () => setConfirming(true),
                  },
                  h(IconTrash, { size: 14 }),
                  ' ',
                  t('list.delete'),
                ),
          ),
        )
      }

      function DocList(props) {
        const { docs, categories, onPreview, onDelete, onCategory, deletingId, loading } = props
        return h(
          'section',
          { className: 'kb-card' },
          h(
            'div',
            { className: 'kb-card-head' },
            h('span', { className: 'kb-card-icon' }, h(IconFile, { size: 16 })),
            h('h2', { className: 'kb-card-title' }, t('list.title')),
            h('span', { className: 'kb-muted' }, t('list.count', { n: docs.length })),
            loading ? h(Spinner, { size: 12 }) : null,
          ),
          docs.length === 0
            ? h(
                'div',
                { className: 'kb-empty' },
                h('div', { className: 'kb-empty-icon' }, h(IconBook, { size: 30 })),
                h('div', { className: 'kb-empty-title' }, t('list.emptyTitle')),
                h('p', { className: 'kb-empty-body' }, t('list.emptyBody')),
              )
            : h(
                'ul',
                { className: 'kb-docs' },
                ...docs.map((doc) =>
                  h(DocRow, {
                    key: doc.id,
                    doc,
                    categories,
                    onPreview,
                    onDelete,
                    onCategory,
                    deleting: deletingId === doc.id,
                  }),
                ),
              ),
        )
      }

      // ── 预览弹层 ─────────────────────────────────────────────────────────

      function PreviewModal(props) {
        const { preview, onClose, onDelete, deleting } = props
        const closeRef = React.useRef(null)
        const [confirming, setConfirming] = React.useState(false)

        React.useEffect(() => {
          setConfirming(false)
          if (closeRef.current && typeof closeRef.current.focus === 'function') closeRef.current.focus()
        }, [preview && preview.id])

        React.useEffect(() => {
          const onKeyDown = (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              onClose()
            }
          }
          window.addEventListener('keydown', onKeyDown)
          const previousOverflow = document.body.style.overflow
          document.body.style.overflow = 'hidden'
          return () => {
            window.removeEventListener('keydown', onKeyDown)
            document.body.style.overflow = previousOverflow
          }
        }, [onClose])

        const doc = preview && preview.doc ? preview.doc : null
        return h(
          'div',
          {
            className: 'kb-overlay',
            role: 'presentation',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) onClose()
            },
          },
          h(
            'div',
            {
              className: 'kb-modal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': doc ? doc.title : t('preview.title'),
            },
            h(
              'div',
              { className: 'kb-modal-head' },
              h('span', { className: 'kb-card-icon' }, h(IconFile, { size: 16 })),
              h(
                'div',
                { className: 'kb-modal-heading' },
                h('h2', { className: 'kb-modal-title' }, doc ? doc.title : t('preview.title')),
                doc
                  ? h(
                      'p',
                      { className: 'kb-modal-meta' },
                      t('preview.meta', {
                        category: doc.category,
                        chars: formatChars(doc.chars),
                        chunks: formatChunks(doc.chunkCount || (doc.text ? 1 : 0)),
                        time: formatTime(doc.createdAt),
                      }),
                    )
                  : null,
              ),
              h(
                'button',
                {
                  ref: closeRef,
                  type: 'button',
                  className: 'kb-btn kb-btn-ghost kb-icon-btn',
                  title: t('preview.close'),
                  'aria-label': t('preview.close'),
                  onClick: onClose,
                },
                h(IconClose, { size: 16 }),
              ),
            ),
            h(
              'div',
              { className: 'kb-modal-body' },
              preview && preview.phase === 'loading'
                ? h('p', { className: 'kb-muted' }, h(Spinner, { size: 13 }), ' ', t('preview.loading'))
                : preview && preview.phase === 'error'
                  ? h(
                      'p',
                      { className: 'kb-error-text' },
                      t('preview.failed'),
                      '：',
                      errorText(preview.error),
                    )
                  : doc && typeof doc.text === 'string' && doc.text !== ''
                    ? h('pre', { className: 'kb-doc-text' }, doc.text)
                    : h('p', { className: 'kb-muted' }, t('preview.empty')),
            ),
            doc
              ? h(
                  'div',
                  { className: 'kb-modal-foot' },
                  confirming
                    ? h(
                        React.Fragment,
                        null,
                        h('span', { className: 'kb-muted' }, t('list.deleteConfirm'), '?'),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'kb-btn kb-btn-danger',
                            disabled: deleting,
                            onClick: () => {
                              setConfirming(false)
                              onDelete(doc.id)
                            },
                          },
                          deleting ? h(Spinner, { size: 11 }) : null,
                          ' ',
                          t('list.deleteConfirm'),
                        ),
                        h(
                          'button',
                          { type: 'button', className: 'kb-btn kb-btn-ghost', onClick: () => setConfirming(false) },
                          t('list.deleteCancel'),
                        ),
                      )
                    : h(
                        'button',
                        { type: 'button', className: 'kb-btn kb-btn-ghost', onClick: () => setConfirming(true) },
                        h(IconTrash, { size: 14 }),
                        ' ',
                        t('list.delete'),
                      ),
                  h('span', { className: 'kb-spacer' }),
                  h('button', { type: 'button', className: 'kb-btn', onClick: onClose }, t('preview.close')),
                )
              : null,
          ),
        )
      }

      // ── 面板根组件 ───────────────────────────────────────────────────────

      function Panel() {
        useLocaleTick()
        const { state, reload } = useLibrary()
        const [preview, setPreview] = React.useState(null)
        const [deletingId, setDeletingId] = React.useState(null)
        const [actionError, setActionError] = React.useState(null)

        const openDoc = React.useCallback(async (id) => {
          setPreview({ id, phase: 'loading', doc: null, error: null })
          try {
            const data = await request(`doc?id=${encodeURIComponent(id)}`)
            setPreview({ id, phase: 'ready', doc: data.doc, error: null })
          } catch (error) {
            setPreview({ id, phase: 'error', doc: null, error })
          }
        }, [])

        const closePreview = React.useCallback(() => setPreview(null), [])

        const deleteDoc = React.useCallback(
          async (id) => {
            setDeletingId(id)
            setActionError(null)
            try {
              await request('delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id }),
              })
              if (preview && preview.id === id) setPreview(null)
              await reload()
            } catch (error) {
              setActionError(error)
            } finally {
              setDeletingId(null)
            }
          },
          [preview, reload],
        )

        const changeCategory = React.useCallback(
          async (id, category) => {
            setActionError(null)
            try {
              await request('update', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id, category }),
              })
              await reload()
            } catch (error) {
              setActionError(error)
            }
          },
          [reload],
        )

        const docs = state.docs
        const stats = state.stats
        const summary =
          stats && stats.docCount > 0
            ? t('stats.summary', { docs: stats.docCount, chunks: stats.chunkCount })
            : t('stats.empty')

        return h(
          'div',
          { className: 'kb-root', 'data-kb-panel': PANEL_KEY },
          h(
            'header',
            { className: 'kb-head' },
            h(
              'div',
              { className: 'kb-head-main' },
              h(
                'div',
                { className: 'kb-title-row' },
                h('span', { className: 'kb-title-icon' }, h(IconBook, { size: 20 })),
                h('h1', { className: 'kb-title' }, t('panel.title')),
                h('span', { className: 'kb-count' }, summary),
              ),
              h('p', { className: 'kb-sub' }, t('panel.subtitle')),
            ),
            h(
              'div',
              { className: 'kb-head-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'kb-btn',
                  title: t('panel.refreshAria'),
                  'aria-label': t('panel.refreshAria'),
                  onClick: () => void reload(),
                  disabled: state.phase === 'loading' || state.phase === 'refreshing',
                },
                state.phase === 'refreshing' ? h(Spinner, { size: 13 }) : h(IconRefresh, { size: 14 }),
                ' ',
                t('panel.refresh'),
              ),
            ),
          ),
          actionError
            ? h(
                'div',
                { className: 'kb-banner kb-banner-error', role: 'alert' },
                h('span', null, errorText(actionError)),
                actionError.hint ? h('span', { className: 'kb-banner-hint' }, actionError.hint) : null,
                h(
                  'button',
                  { type: 'button', className: 'kb-btn kb-btn-ghost', onClick: () => setActionError(null) },
                  t('list.deleteCancel'),
                ),
              )
            : null,
          h(
            'div',
            { className: 'kb-scroll' },
            state.phase === 'loading'
              ? h('div', { className: 'kb-loading' }, h(Spinner, { size: 16 }), ' ', t('panel.loading'))
              : state.phase === 'error'
                ? h(
                    'div',
                    { className: 'kb-error-box', role: 'alert' },
                    h('div', { className: 'kb-empty-title' }, t('panel.errorTitle')),
                    h('p', { className: 'kb-empty-body' }, errorText(state.error)),
                    h(
                      'button',
                      { type: 'button', className: 'kb-btn kb-btn-primary', onClick: () => void reload() },
                      t('panel.retry'),
                    ),
                  )
                : h(
                    React.Fragment,
                    null,
                    h(UploadCard, { categories: state.categories, onUploaded: () => void reload() }),
                    h(SearchCard, { categories: state.categories, onOpenDoc: (id) => void openDoc(id) }),
                    h(DocList, {
                      docs,
                      categories: state.categories,
                      onPreview: (id) => void openDoc(id),
                      onDelete: (id) => void deleteDoc(id),
                      onCategory: (id, category) => void changeCategory(id, category),
                      deletingId,
                      loading: state.phase === 'refreshing',
                    }),
                    h(
                      'footer',
                      { className: 'kb-footer' },
                      stats && stats.dataDir
                        ? h('p', { className: 'kb-footer-line' }, t('footer.dataDir', { path: stats.dataDir }))
                        : null,
                      stats && stats.supportedFormats
                        ? h('p', { className: 'kb-footer-line' }, t('footer.formats', { formats: stats.supportedFormats }))
                        : null,
                      h('p', { className: 'kb-footer-line' }, t('footer.use')),
                    ),
                  ),
          ),
          preview ? h(PreviewModal, { preview, onClose: closePreview, onDelete: (id) => void deleteDoc(id), deleting: deletingId === (preview && preview.id) }) : null,
        )
      }

      return Panel
    }

    // ────────────────────────────────────────────────────────────── 侧栏图标

    function PanelIcon(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 18
      const active = props && props.active === true
      return h(
        'span',
        {
          className: 'kb-panel-icon',
          'data-active': active ? 'true' : 'false',
          'aria-hidden': 'true',
          style: { width: size + 'px', height: size + 'px' },
        },
        h(IconBook, { size: size }),
      )
    }

    // ────────────────────────────────────────────────────────────── 样式

    const CSS = [
      '.kb-root{box-sizing:border-box;height:100%;min-height:0;flex:1 1 auto;display:flex;flex-direction:column;gap:14px;padding:18px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;}',
      '.kb-head{flex:0 0 auto;display:flex;align-items:flex-start;gap:12px;}',
      '.kb-head-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;}',
      '.kb-title-row{display:flex;align-items:center;gap:9px;min-width:0;flex-wrap:wrap;}',
      '.kb-title-icon{display:inline-flex;color:var(--dsw-alias-brand-primary);}',
      '.kb-title{margin:0;font-size:18px;line-height:1.35;font-weight:600;letter-spacing:.01em;}',
      '.kb-count{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 9px;white-space:nowrap;}',
      '.kb-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.kb-head-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding-top:2px;}',
      '.kb-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:14px;padding-right:4px;}',
      '.kb-card{flex:0 0 auto;display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-2);}',
      '.kb-card-head{display:flex;align-items:center;gap:8px;min-height:24px;flex-wrap:wrap;}',
      '.kb-card-icon{display:inline-flex;color:var(--dsw-alias-label-secondary);}',
      '.kb-card-title{margin:0;font-size:13.5px;font-weight:600;}',
      '.kb-spacer{flex:1 1 auto;}',
      '.kb-muted{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:6px;}',
      '.kb-hint{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.kb-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4;padding:5px 11px;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,opacity .12s ease;}',
      '.kb-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);}',
      '.kb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.kb-btn:disabled{opacity:.55;cursor:default;}',
      '.kb-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);}',
      '.kb-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.9;}',
      '.kb-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l1);}',
      '.kb-btn-ghost{border-color:transparent;}',
      '.kb-icon-btn{padding:5px 7px;}',
      '.kb-field{display:inline-flex;align-items:center;gap:6px;}',
      '.kb-field-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.kb-select{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4;padding:4px 22px 4px 8px;max-width:190px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-secondary) 50%),linear-gradient(135deg,var(--dsw-alias-label-secondary) 50%,transparent 50%);background-position:calc(100% - 13px) 52%,calc(100% - 9px) 52%;background-size:4px 4px,4px 4px;background-repeat:no-repeat;}',
      '.kb-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.kb-select-inline{padding:2px 20px 2px 7px;font-size:11.5px;max-width:150px;background-color:transparent;}',
      '.kb-input{box-sizing:border-box;flex:1 1 auto;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.4;padding:7px 10px;}',
      '.kb-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.8;}',
      '.kb-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:transparent;}',
      '.kb-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;text-align:center;padding:18px 16px;border:1.5px dashed var(--dsw-alias-border-l2);border-radius:12px;background:transparent;cursor:pointer;transition:border-color .12s ease,background .12s ease;}',
      '.kb-drop:hover{background:var(--dsw-alias-bg-layer-1);}',
      '.kb-drop:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.kb-drop[data-over="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);}',
      '.kb-drop-icon{display:inline-flex;color:var(--dsw-alias-label-secondary);}',
      '.kb-drop-title{font-size:13px;font-weight:600;}',
      '.kb-drop-hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:640px;}',
      '.kb-queue{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;}',
      '.kb-queue-item{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0;}',
      '.kb-queue-name{max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);}',
      '.kb-queue-status{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;}',
      '.kb-queue-status[data-status="done"]{color:var(--dsw-alias-state-success-primary);}',
      '.kb-queue-status[data-status="error"]{color:var(--dsw-alias-state-error-primary);}',
      '.kb-queue-error{color:var(--dsw-alias-state-error-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%;}',
      '.kb-queue-clear{display:flex;justify-content:flex-end;}',
      '.kb-search-title{font-size:13.5px;}',
      '.kb-search-row{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.kb-search-icon{display:inline-flex;color:var(--dsw-alias-label-secondary);}',
      '.kb-search-input{flex:1 1 auto;}',
      '.kb-results{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}',
      '.kb-result{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 11px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-1);}',
      '.kb-result-head{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;}',
      '.kb-result-title{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%;}',
      '.kb-result-chunk{font-size:11px;}',
      '.kb-result-text{margin:0;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;}',
      '.kb-mark{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary);border-radius:3px;padding:0 1px;}',
      '.kb-docs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;}',
      '.kb-doc{display:flex;align-items:flex-start;gap:10px;padding:10px 8px;border-radius:10px;border:1px solid transparent;min-width:0;}',
      '.kb-doc:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);}',
      '.kb-doc-icon{display:inline-flex;color:var(--dsw-alias-label-secondary);padding-top:2px;}',
      '.kb-doc-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.kb-doc-title-row{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.kb-doc-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.kb-doc-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);}',
      '.kb-doc-preview{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;}',
      '.kb-doc-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;padding-top:1px;}',
      '.kb-badge{font-size:10.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 7px;white-space:nowrap;}',
      '.kb-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:7px;padding:26px 16px;border:1px dashed var(--dsw-alias-border-l1);border-radius:12px;}',
      '.kb-empty-icon{display:inline-flex;color:var(--dsw-alias-label-secondary);opacity:.8;}',
      '.kb-empty-title{font-size:13.5px;font-weight:600;}',
      '.kb-empty-body{margin:0;max-width:560px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);}',
      '.kb-loading{display:flex;align-items:center;gap:8px;padding:28px 10px;justify-content:center;font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.kb-error-box{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:24px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;}',
      '.kb-error-text{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary);}',
      '.kb-banner{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;font-size:12px;flex:0 0 auto;}',
      '.kb-banner-error{border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.kb-banner-hint{color:var(--dsw-alias-label-secondary);}',
      '.kb-footer{display:flex;flex-direction:column;gap:3px;padding:2px 2px 6px;}',
      '.kb-footer-line{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-all;}',
      '.kb-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-overlay);background:color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent);}',
      '.kb-modal{display:flex;flex-direction:column;width:min(880px,100%);max-height:calc(100vh - 48px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:0 18px 48px -18px var(--dsw-alias-bg-base);overflow:hidden;}',
      '.kb-modal-head{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;}',
      '.kb-modal-heading{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}',
      '.kb-modal-title{margin:0;font-size:14.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.kb-modal-meta{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
      '.kb-modal-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px;}',
      '.kb-doc-text{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.75;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);}',
      '.kb-modal-foot{display:flex;align-items:center;gap:8px;padding:11px 16px;border-top:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;}',
      '.kb-panel-icon{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);border-radius:5px;}',
      '.kb-panel-icon[data-active="true"]{color:var(--dsw-alias-label-primary);}',
      '.kb-spinner{display:inline-block;box-sizing:border-box;border:1.6px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:kb-spin .8s linear infinite;vertical-align:middle;}',
      '@keyframes kb-spin{to{transform:rotate(360deg);}}',
      '@media (prefers-reduced-motion:reduce){.kb-spinner{animation:none;border-top-color:var(--dsw-alias-border-l2);}}',
      '@media (max-width:720px){.kb-root{padding:14px;}.kb-head{flex-direction:column;}.kb-head-actions{padding-top:0;}.kb-search-row{flex-wrap:wrap;}.kb-doc{align-items:stretch;flex-wrap:wrap;}.kb-doc-actions{margin-left:26px;}}',
    ].join('\n')

    function mountStyle() {
      if (typeof document === 'undefined' || document.head === null) return () => {}
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) existing.remove()
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', PLUGIN)
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    // ────────────────────────────────────────────────────────────── apply

    function warn(where, error) {
      try {
        console.warn(`[${PLUGIN}] ${where} 失败：${error && error.message ? error.message : String(error)}`)
      } catch {
        /* 控制台不可用也无所谓 */
      }
    }

    function registerSlot(ctx, slotName, params, Component, effectLabel) {
      ctx.effect(() => {
        let dispose = null
        try {
          dispose = ctx.slots.inject(slotName, () => {
            try {
              return ctx.slots.register(params, Component)
            } catch (error) {
              warn(`register ${slotName}`, error)
              return undefined
            }
          })
        } catch (error) {
          warn(`inject ${slotName}`, error)
          return undefined
        }
        return () => {
          if (typeof dispose === 'function') {
            try {
              dispose()
            } catch (error) {
              warn(`dispose ${slotName}`, error)
            }
          }
        }
      }, effectLabel)
    }

    function apply(ctx) {
      // ① 文案：中英字典都注册（注册失败只影响文案，不影响功能）。
      ctx.effect(() => {
        const disposers = []
        for (const tag of LOCALE_TAGS) {
          const dict = /^en/i.test(tag) ? EN : ZH
          try {
            disposers.push(ctx.locale.register(NS, tag, dict))
          } catch (error) {
            if (!(error && /already|duplicate|occupied/i.test(String(error.message)))) {
              warn(`locale ${tag}`, error)
            }
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* 幂等 disposer */
            }
          }
        }
      }, 'dsh-knowledge-base: locale')

      // ② 样式随 fiber 清理。
      ctx.effect(() => mountStyle(), 'dsh-knowledge-base: styles')

      const Panel = createPanel(ctx)

      // ③ 侧栏入口（id 与主面板 key 一一对应）。
      registerSlot(
        ctx,
        'sidebar.panellist',
        {
          name: 'sidebar.panellist',
          id: PANEL_KEY,
          order: 20,
          label: () => {
            try {
              return ctx.locale.bind(NS)('panel.entryLabel')
            } catch {
              return '我的知识库'
            }
          },
        },
        PanelIcon,
        'dsh-knowledge-base: sidebar panel icon',
      )

      // ④ 中央主面板。
      registerSlot(
        ctx,
        'main',
        { name: 'main', key: PANEL_KEY },
        Panel,
        'dsh-knowledge-base: main panel',
      )
    }

    return { name: PLUGIN, inject: ['slots', 'locale'], apply }
  },
})
