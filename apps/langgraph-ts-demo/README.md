# @pjqdyd/langgraph-ts-demo

LangGraph.js Agent 最佳实践示例服务。基于 midway(egg) 构建，使用 `StateGraph` 手工编排图结构，完整演示 Agent 的**分支（意图分类路由）、循环（ReAct 工具调用）、多步执行（多节点链路）与错误兜底（重试/告警）**能力；通过 checkpointer（开发态 MemorySaver）按 thread_id 持久化状态实现多轮对话，SSE 流式接口额外下发节点执行进度（step 事件），可直接对接 `apps/web-chat-demo` 中的 antdx（@ant-design/x）前端。

## 技术栈

| 层 | 技术 |
|---|---|
| Web 框架 | midway 3 + `@midwayjs/web`（egg 场景） |
| Agent 编排 | `@langchain/langgraph` 的 `StateGraph` + `MemorySaver`（checkpointer） |
| 模型接入 | `@langchain/openai` 的 `ChatOpenAI`（OpenAI 兼容端点指向 Ollama `/v1`） |
| 向量模型 | `@langchain/ollama` 的 `OllamaEmbeddings`（RAG 检索用） |
| RAG | `langchain` 的 `MemoryVectorStore` + `@langchain/textsplitters` |
| 参数校验 | `zod`（意图分类结构化输出、工具入参 schema） |
| 工程化 | pnpm workspace + turborepo + TypeScript |

## 项目架构

```
apps/langgraph-ts-demo/
├── bootstrap.js                # 启动入口（dev 与生产共用，加载 dist 产物）
├── src/
│   ├── configuration.ts        # midway 入口：注册 web(egg) 组件 + 启动横幅（含 Graph mermaid 图打印）
│   ├── interface.ts            # 类型定义（OllamaConfig、SSE 事件结构 GraphStreamData）
│   ├── config/
│   │   └── config.default.ts   # 通用配置：端口(6002)、Ollama 模型、CSRF 关闭
│   ├── controller/
│   │   └── chat.controller.ts  # Graph 流式问答接口（SSE 协议封装）
│   └── agent/
│       ├── graph.service.ts    # StateGraph 编排：节点/条件边/错误路由/checkpointer/流式事件
│       ├── state.ts            # Graph 全局状态定义（Annotation.Root + reducer）
│       ├── prompts.ts          # 各节点系统提示词集中管理 + 错误兜底模板
│       ├── tools/              # calculator（计算器）
│       └── rag/                # RAG 服务：分割 / 向量化 / 检索 + 示例知识文档
└── doc/
    └── Project.md              # 架构与执行原理详解
```

## 环境要求

- Node.js >= 18、pnpm >= 12（monorepo 根目录已声明）
- Ollama（本地安装并已启动，默认 `http://127.0.0.1:11434`）

首次使用需拉取模型：

```bash
ollama pull qwen3.5:2b          # 对话模型
ollama pull nomic-embed-text    # RAG 向量化模型
```

会话状态由 langgraph checkpointer（开发态 `MemorySaver`）持久化，**无需 MySQL**；生产环境替换为 PostgresSaver 即可获得断点续跑与 human-in-the-loop 能力（见 `doc/Project.md`）。

## 开发运行

在仓库根目录执行（turborepo 编排）：

```bash
pnpm install                 # 安装依赖
pnpm --filter @pjqdyd/langgraph-ts-demo dev
```

启动成功后控制台会打印服务地址、接口清单与 **Graph 结构（mermaid 图，可粘贴到 mermaid.live 渲染）**，服务监听 `http://127.0.0.1:6002`。`dev` 模式由 mwtsc 监听 `src` 变化：自动增量编译到 `dist` 并重启应用。

快速验证：

```bash
curl -N -X POST http://127.0.0.1:6002/api/graph/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"content": "1 + 2 * 3 等于多少"}'
```

LangSmith 链路追踪（可选，无需任何埋点代码）：启动前设置环境变量即可自动上报每个节点 / LLM / 工具的耗时、输入输出与 token 用量：

```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=lsv2_xxx
LANGCHAIN_PROJECT=langgraph-ts-demo
```

## 打包发布运行

```bash
# 编译：TypeScript 产物输出到 dist/（根目录 turbo build 可编排整个 monorepo）
pnpm --filter @pjqdyd/langgraph-ts-demo build

# 生产运行：NODE_ENV=production，加载 dist 编译产物
pnpm --filter @pjqdyd/langgraph-ts-demo start
```

生产环境说明：

- `start` 脚本执行 `node bootstrap.js`，其中 `baseDir` 指向 `dist`，容器只扫描编译产物
- 会话状态生产环境应将 `MemorySaver` 替换为 `PostgresSaver`（跨进程持久化，支持断点续跑与人工审批），替换方式见 [graph.service.ts](file:///d:/DesktopResource/AI/AI-Agent-Demo/apps/langgraph-ts-demo/src/agent/graph.service.ts) 内注释
- 部署机需能访问 Ollama 服务（或通过环境变量/配置指向远端地址）

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/graph/chat/stream` | SSE 流式问答：`{sessionId?, content}`，事件协议见下 |

SSE 事件协议（与 antdx `XRequest` 消费方式对齐，`event` 统一为 `message`，用 `data.type` 区分；相比 langchain-ts-demo 新增 `step` 事件下发节点执行进度）：

```
event: message
data: {"type":"step","threadId":1758630000000,"node":"classify","label":"意图分类","detail":"意图：compute"}
data: {"type":"step","threadId":1758630000000,"node":"agent","label":"Agent 决策","detail":"准备调用工具：calculator"}
data: {"type":"chunk","threadId":1758630000000,"content":"部分回答"}   # 增量内容，可多次
data: {"type":"done","threadId":1758630000000}                        # 结束标记
data: {"type":"error","threadId":1758630000000,"message":"..."}       # 错误（图内已兜底时不出现）
```

`sessionId` 即 langgraph checkpointer 的 `thread_id`：首次请求不传由后端生成（时间戳），后续请求携带同一值即可延续多轮上下文（历史消息由 checkpointer 自动携带，仅传增量输入）。

## 与 web-chat-demo（antdx）对接

前端使用 `@ant-design/x` 的 `XRequest` 将 `baseUrl` 指向本服务（或经 umi proxy 转发 `/api/graph` -> 6002，**注意需配置在 `/api` -> 6001 之前**，proxy 按顺序匹配 key），参考实现见 `apps/web-chat-demo/src/pages/chat-agent-graph.tsx`：`onMessage` 中按 `data.type` 分发——`step` 追加执行时间线、`chunk` 追加增量内容、`done` 结束、`error` 提示错误。
