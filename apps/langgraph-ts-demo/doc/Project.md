# Project.md — 架构与执行原理详解

本文档详细描述 `@pjqdyd/langgraph-ts-demo` 的整体架构，以及一次对话请求从 HTTP 接口进入，经过 **意图分类 → 分支路由 → RAG 检索 / ReAct 工具循环 → 回答生成** 的完整执行过程与原理。区别于 `langchain-ts-demo` 使用 `createReactAgent` 预置图，本项目用 `StateGraph` 手工编排，完整展示 langgraph 的**分支、循环、多步执行与错误兜底**能力。

## 1. 整体架构

```
                          ┌───────────────────────────────────────────────────────┐
                          │                 midway (egg) 应用                      │
                          │                                                       │
 HTTP 请求 ─────────────▶ │  ChatController (SSE 封装)                             │
                          │       │                                               │
                          │       ▼                                               │
                          │  GraphService (Singleton)                             │
                          │   ├─ StateGraph（7 节点手工编排）                       │
                          │   │    START ──▶ classify                             │
                          │   │                ├─ chat ──────▶ respond ──▶ END    │
                          │   │                ├─ knowledge ─▶ retrieve ─▶ respond│
                          │   │                └─ compute ───▶ agent ⇄ tools      │
                          │   │  错误路由：error → retry（回出错节点）/ errorHandler │
                          │   ├─ checkpointer: MemorySaver（按 thread_id 隔离）    │
                          │   ├─ tools: calculator                                │
                          │   │        │                                          │
                          │   │        ▼                                          │
                          │   │  RagService                                       │
                          │   │ (分割 → OllamaEmbeddings → MemoryVectorStore)     │
                          │   ▼                                                   │
                          │  ChatOpenAI ── HTTP(/v1) ──▶ Ollama (qwen3.5:2b)      │
                          └───────────────────────────────────────────────────────┘
```

分层职责：

| 层 | 文件 | 职责 |
|---|---|---|
| 接口层 | `controller/chat.controller.ts` | 参数校验、sessionId（thread_id）生成、SSE 协议封装 |
| 编排层 | `agent/graph.service.ts` | StateGraph 构建、节点实现、条件路由、流式事件产出 |
| 状态层 | `agent/state.ts` | Graph 全局状态定义（Annotation.Root + reducer） |
| 提示词层 | `agent/prompts.ts` | 各节点系统提示词集中管理 + 错误兜底模板 |
| 工具层 | `agent/tools/*` | 以 zod schema 声明的可调用工具（calculator） |
| 知识层 | `agent/rag/*` | 文档分割、向量化、相似度检索（MemoryVectorStore） |
| 配置层 | `config/*` | 端口、Ollama 模型等通用配置 |

## 2. 一次流式问答的完整执行过程

以 `POST /api/graph/chat/stream {"content": "1 + 2 * 3 等于多少"}` 为例：

```
1. Controller 校验 content 非空
   └─ 无 sessionId → 生成（Date.now()）；即 checkpointer 的 thread_id
2. 设置 SSE 响应头（Content-Type / no-cache / no-transform / X-Accel-Buffering）
3. GraphService.chatStream()
   ├─ buildGraph()：惰性构建并缓存编译后的 Graph（首次请求才创建模型连接）
   ├─ graph.stream(
   │     { messages: [new HumanMessage(content)] },      ← 仅传增量用户消息
   │     { configurable: { thread_id }, streamMode: ['updates', 'messages'] }
   │  )
   │    │
   │    │  Graph 执行（langgraph 驱动）：
   │    ├─ ① classify：LLM 结构化输出意图分类（chat / knowledge / compute）
   │    │      → SSE 下发 step 事件 { node:'classify', label:'意图分类', detail:'意图：compute' }
   │    ├─ ② 条件边按 intent 分支：
   │    │      compute → agent；knowledge → retrieve → respond；chat → respond
   │    ├─ ③ agent（ReAct 推理）：返回 tool_calls → step 事件 + 进入 tools 节点
   │    │      tools：执行 calculator，结果以 ToolMessage 回填 → 回到 agent（循环）
   │    │      agent 无 tool_calls → 结束，最终 AIMessage 即回答
   │    └─ ④ 各节点产出的 AI 文本 token 以 chunk 事件流式下发
   └─ 流结束：thinkStripper.flush() 冲刷缓冲 → send done（或 error）事件
4. 对话状态由 checkpointer 自动持久化（thread state），无需手动落库
   下次同 thread_id 请求仅传增量消息，历史由 state.messages 自动携带
```

要点：**多轮"记忆"不在业务代码里，而在 checkpointer 的线程状态里**——`messages` 的 reducer 是追加式合并，每个节点返回的消息增量都会合并进线程状态并持久化。

## 3. 关键机制与原理

### 3.1 State 定义与 reducer

图的全局状态用 `Annotation.Root` 声明，每个字段可指定 `reducer`（合并策略）与 `default`（初始值）：

```ts
// agent/state.ts（节选）
export const GraphState = Annotation.Root({
  // 对话消息：追加式合并，checkpointer 持久化实现多轮
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  intent: Annotation<Intent>({ reducer: (_, right) => right, default: () => 'chat' }),
  retrievedDocs: Annotation<Document[]>({
    reducer: (_, right) => right ?? [],
    default: () => [],
  }),
  error: Annotation<string | null>({ reducer: (_, right) => right, default: () => null }),
  failedNode: Annotation<string>({ reducer: (_, right) => right ?? '', default: () => '' }),
  retryCount: Annotation<number>({ reducer: (_, right) => right, default: () => 0 }),
});
```

原理：节点只需返回**增量**（如 `{ intent }`），langgraph 按 reducer 将其合并进全局状态。`messages` 用 concat 追加，其余字段用覆盖写入——这决定了"节点返回什么，状态就变成什么"的心智模型。

### 3.2 意图分类与分支路由（分支能力）

`classify` 节点用 `withStructuredOutput` 让 LLM 输出 zod 枚举，作为图分支依据：

```ts
// agent/graph.service.ts（节选）
const classifyModel = baseModel.withStructuredOutput(
  z.object({
    intent: z.enum(['chat', 'knowledge', 'compute']).describe('用户意图分类结果'),
  })
);

// 条件边：意图 → 目标节点
const intentRoutes: Record<Intent, string> = {
  chat: 'respond',       // 闲聊：直接生成回答
  knowledge: 'retrieve', // 内部知识：先 RAG 检索再回答
  compute: 'agent',      // 计算：进入 ReAct 工具循环
};
workflow.addConditionalEdges('classify', routeAfterClassify, [
  'retrieve', 'agent', 'respond', 'retry', 'errorHandler',
]);
```

原理：结构化输出将"分类"约束为枚举，模型不可能返回枚举外的值，比让模型输出自由文本再正则解析可靠得多；分类结果写入 `state.intent`，条件边读取它完成路由——**分支逻辑完全由图结构承载，而非代码里的 if-else**。

### 3.3 ReAct 工具循环（循环能力）

`agent ⇄ tools` 构成经典 ReAct 循环，工具用 `bindTools` 绑定到模型：

```ts
// agent/graph.service.ts（节选）
const toolModel = baseModel.bindTools([calculatorTool]);

// agent 节点：有 tool_calls 则原样入状态，否则视为最终回答
const agentNode = async (state: GraphStateType) => {
  const response = await toolModel.invoke([
    new SystemMessage(AGENT_SYSTEM_PROMPT),
    ...state.messages,
  ]);
  if (!response.tool_calls?.length) {
    return { messages: [new AIMessage({ content: stripThinkTags(String(response.content)) })] };
  }
  return { messages: [response] };
};

// 条件边：有工具调用 → tools（循环），否则 → END
return lastMessage.tool_calls?.length ? 'tools' : END;
```

`tools` 节点逐个执行工具调用，结果包装为 `ToolMessage`（携带 `tool_call_id`）追加进消息序列，回到 `agent` 继续推理——模型每轮都能看到自己上一轮的工具调用与观测结果。

### 3.4 错误处理路由（错误兜底能力）

每个业务节点的 try/catch 将异常写入 state（而非直接抛出），由条件边统一路由：

```ts
// agent/graph.service.ts（节选）
const MAX_RETRY_COUNT = 1;

// 节点异常 → 写入 state 增量（不抛出）
function buildNodeError(nodeName: string, error: unknown) {
  return {
    error: `${nodeName} 节点执行失败：${...}`,
    failedNode: nodeName,     // retry 节点据此路由回出错节点
  };
}

// 出错时的统一路由：未超重试上限则重试，否则进入告警兜底
const routeByError = (state: GraphStateType): 'retry' | 'errorHandler' =>
  state.retryCount < MAX_RETRY_COUNT ? 'retry' : 'errorHandler';

// retry 节点：清空错误 + 累计次数，随后条件边送回 failedNode
const retryNode = async (state: GraphStateType) => ({
  error: null,
  retryCount: state.retryCount + 1,
});

// errorHandler 节点：模板兜底，不调用 LLM（避免故障时二次失败）
```

原理：

- **异常即状态**：错误写入 `state.error` 后走正常边路由，图不会中断，前端始终能收到完整的 SSE 事件序列
- **`failedNode` 记录出错位置**：retry 节点执行后由 `routeAfterRetry` 路由回出错节点，实现"精准重试"而非从头重跑整图
- **`MAX_RETRY_COUNT` 上限**：防止无限重试；超限后进入 `errorHandler` 输出兜底文案（不经过 LLM），并通过 SSE `error` 事件上抛真实错误信息

### 3.5 Checkpointer 状态持久化（多轮对话 / 断点续跑）

编译时注入 checkpointer，状态按 `thread_id` 隔离持久化：

```ts
// agent/graph.service.ts（节选）
// 开发态：MemorySaver——状态存内存，重启即失，按 thread_id 隔离多轮对话
// 生产态：替换为 PostgresSaver 实现跨进程持久化（断点续跑 / human-in-the-loop 依赖它）：
//   pnpm add @langchain/langgraph-checkpoint-postgres
//   import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
//   const checkpointer = PostgresSaver.fromConnString('postgresql://user:pass@host:5432/db');
//   await checkpointer.setup(); // 首次运行自动建表
private checkpointer = new MemorySaver();

return workflow.compile({
  checkpointer: this.checkpointer,
  // human-in-the-loop（可选）：interruptBefore 可在指定节点前暂停，
  // 审批通过后 graph.stream(null, { configurable: { thread_id } }) 从断点续跑
  //   interruptBefore: ['tools']
});
```

流式调用时**仅传增量用户消息**，历史由线程状态自动携带：

```ts
// agent/graph.service.ts（节选）
const stream = await graph.stream(
  { messages: [new HumanMessage(content)] },
  { configurable: { thread_id: String(threadId) }, streamMode: ['updates', 'messages'] }
);
```

原理：checkpointer 在每个节点（super-step）执行后保存状态快照，同 `thread_id` 再次调用时自动恢复——因此多轮上下文、断点续跑、human-in-the-loop 都是同一机制的三个应用场景，业务代码零改动。

### 3.6 RAG（检索增强生成）

与 langchain-ts-demo 的 Agentic RAG（检索作为工具）不同，本项目将检索实现为**独立节点**（`retrieve`），由意图分类决定是否触发：

```ts
// agent/rag/rag.service.ts（节选）
// 分割：递归字符分割，500 字符一片，相邻片重叠 50 字符保证语义连续
const documents = await splitter.createDocuments([content], [{ title }]);
await vectorStore.addDocuments(documents);

// 检索：query 先经 embedding 模型转向量，再与库内向量做余弦相似度排序取 topK
async search(query: string, topK = 3): Promise<Document[]> {
  await this.ensureSeeded();   // 首次检索自动写入示例知识，保证 demo 开箱可用
  const vectorStore = await this.getVectorStore();
  return vectorStore.similaritySearch(query, topK);
}
```

`respond` 节点将检索结果拼入系统提示词的 `{{knowledgeContext}}` 占位符，并约束模型"未检索到内容时如实告知"，抑制幻觉。

原理：**节点式 RAG vs 工具式 RAG**——节点由图结构固定触发（意图为 knowledge 才检索），链路确定、便于在 Timeline 中展示进度；工具式由模型自主触发，更灵活但多一次工具决策调用。向量库为内存实现（重启即失），生产可替换 pgvector/Milvus（只需替换 VectorStore 实现，调用方不变）。

### 3.7 SSE 双 streamMode 流式输出

`streamMode: ['updates', 'messages']` 同时消费两类事件：`updates` 是节点执行完成的 state 增量（用于 Timeline 进度），`messages` 是 LLM token 流（用于正文）：

```ts
// agent/graph.service.ts（节选）
for await (const entry of stream) {
  const [mode, payload] = entry as [string, unknown];
  if (mode === 'updates') {
    for (const [nodeName, delta] of Object.entries(payload)) {
      yield { type: 'step', threadId, node: nodeName,
              label: NODE_LABELS[nodeName] ?? nodeName,
              detail: summarizeNodeDelta(nodeName, delta) };
    }
    continue;
  }
  // messages：只透传 AI 文本增量，过滤工具调用等中间过程
  const messageChunk = (Array.isArray(payload) ? payload[0] : payload) as unknown;
  if (!(messageChunk instanceof AIMessageChunk)) continue;
  if (messageChunk.tool_call_chunks?.length) continue;
  ...
}
```

Controller 层封装为 SSE 事件流（协议与 antdx `XRequest` 对齐）：

```ts
// controller/chat.controller.ts（节选）
this.ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
this.ctx.set('Cache-Control', 'no-cache, no-transform');  // no-transform：禁中间层转换
this.ctx.set('X-Accel-Buffering', 'no');                  // 禁用代理缓冲
for await (const event of this.graphService.chatStream(sessionId, content)) {
  send(event);   // event: message\ndata: {...}\n\n
}
```

原理：

- `no-transform` 是关键：umi dev server 的 compression 中间件检测到该头会跳过 gzip/br 压缩，否则 SSE 小 chunk 积压在 zlib 缓冲区导致无流式效果
- 多 streamMode 下 `messages` 的 payload 形状不稳定：可能是裸 `AIMessageChunk`，也可能是 `[chunk, metadata]` 元组，必须用 `Array.isArray(payload) ? payload[0] : payload` 兼容
- `errorHandler` 的兜底文案不经过 LLM（无 token 流），需在 `updates` 分支中检测到该节点时手动下发 `chunk` 事件

### 3.8 思考内容剥离（qwen3 系列）

qwen3 系列模型会在回答前输出 `<think>...</think>` 思考内容。非流式（agent/respond 节点入库前）用正则一次剥离；流式因标签可能被拆在多个 chunk 里，使用跨 chunk 状态机：

```ts
// agent/graph.service.ts（节选）
// 非流式：一次性剥离
const thinkPattern = new RegExp(`<think>[\\s\\S]*?</think>`, 'g');
return text.replace(thinkPattern, '').trim();

// 流式：状态机持有缓冲区，仅输出确认安全（不可能包含半截标签）的部分
const visibleText = thinkStripper.push(messageChunk.content);
```

状态机核心逻辑：输出方向上保留尾部可能与 `<think>` 成前缀的字符（如已收到 `<th`），确保不把半个标签泄漏给前端；思考模式下丢弃内容直至出现完整 `</think>`；流结束时 `flush()` 冲刷残余缓冲。

另外，模型侧通过 `modelKwargs: { reasoning_effort: 'none' }` 关闭 qwen3.5 的思考模式（本地小模型思考耗时过长，关闭后响应从分钟级降到秒级；需要深度推理时可改为 low/medium/high 或删除该参数）。

### 3.9 模型接入（ChatOpenAI 指向 Ollama /v1）

对话模型使用 `@langchain/openai` 的 `ChatOpenAI`，将 OpenAI 兼容客户端指向 Ollama 的 `/v1` 端点：

```ts
// agent/graph.service.ts（节选）
private createModel(): ChatOpenAI {
  return new ChatOpenAI({
    model: this.ollamaConfig.chatModel,
    streaming: true,
    configuration: { baseURL: `${this.ollamaConfig.baseUrl}/v1` },
    apiKey: 'ollama',   // 本地 Ollama 不校验 API Key，langchain 要求非空，占位即可
    modelKwargs: { reasoning_effort: 'none' },
  });
}
```

注意：RAG 的向量化模型仍用 `@langchain/ollama` 的 `OllamaEmbeddings`（走 Ollama 原生 API，非 `/v1` 端点）。

## 4. Graph 可视化

编译后的 Graph 可通过 `drawMermaid()` 导出 mermaid 文本，应用启动时在 `onServerReady` 钩子自动打印到控制台，可粘贴到 mermaid.live 或 IDE 插件渲染（文档 / 调试用）：

```ts
// agent/graph.service.ts（节选）
exportMermaid(): string {
  return this.buildGraph().getGraph().drawMermaid();
}
```

## 5. 配置分层与启动流程

midway 按 `NODE_ENV` 加载 `src/config/config.{env}.ts`：

- `config.default.ts`：端口（`egg.port: 6002`）、Ollama 模型名（chatModel / embeddingModel）、关闭 CSRF（纯 JSON API 服务，供前端直接 POST）
- LangSmith 追踪（可选）：启动前设置 `LANGCHAIN_TRACING_V2=true` + `LANGCHAIN_API_KEY` + `LANGCHAIN_PROJECT` 环境变量，langchain 自动上报每个节点 / LLM / 工具的耗时、输入输出与 token 用量，无需任何埋点代码

启动链路（`bootstrap.js` → `Bootstrap.configure` → `Bootstrap.run`）：

```js
// bootstrap.js（节选）
Bootstrap.configure({
  appDir: __dirname,
  baseDir: join(__dirname, 'dist'),          // 容器只扫描编译产物，避免误加载 src 源码
  configurationModule: require('./dist/configuration'),
});
Bootstrap.run();
```

`src/configuration.ts` 中注册 `web`（egg 场景）组件，`onServerReady` 钩子打印服务地址、接口清单与 Graph mermaid 图。

## 6. 技术决策备忘

| 决策 | 原因 |
|---|---|
| 手工 `StateGraph` 而非 `createReactAgent` | 完整演示分支（意图路由）、循环（agent ⇄ tools）、多步（多节点链路）与错误兜底能力，预置图只有单层工具循环 |
| `ChatOpenAI` 而非 `ChatOllama` | Ollama 提供 OpenAI 兼容端点 `/v1`；`reasoning_effort` 等扩展参数经 `modelKwargs` 下发，实测关闭思考后响应从分钟级降到秒级 |
| `withStructuredOutput` 做意图分类 | 结构化输出约束为 zod 枚举，比自由文本 + 正则解析可靠；分类结果直接作为图分支依据 |
| 错误写入 state 而非抛出 | 异常即状态，图不中断，由条件边统一路由到重试/告警，前端始终收到完整 SSE 事件序列 |
| `errorHandler` 不调用 LLM | 兜底文案用模板生成，避免故障时二次失败 |
| 开发态 `MemorySaver` | 零依赖实现多轮对话与断点演示；生产替换 PostgresSaver 即获得跨进程持久化与 human-in-the-loop，业务代码零改动 |
| 无 MySQL / typeorm | 会话状态由 checkpointer 托管，无需自行维护消息表——这是与 langchain-ts-demo 架构上的核心差异 |
| SSE 增加 `no-transform` 头 | umi dev server 的 compression 中间件会缓冲 SSE 小 chunk，实测加该头后其跳过压缩，流式效果恢复 |
| 多 streamMode payload 兼容 | @langchain/langgraph 0.2.62 多模式下 `messages` 可能是裸 chunk 或 `[chunk, metadata]` 元组，解析时需 `Array.isArray` 判断 |
| Graph 惰性构建（首次请求创建） | 应用启动不依赖 Ollama 在线，避免启动顺序耦合 |
| `drawMermaid` 导出图结构 | 图拓扑复杂（7 节点 6 组条件边），启动时自动打印 mermaid 文本便于文档与调试 |
