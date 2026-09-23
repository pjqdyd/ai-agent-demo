/**
 * Ollama 本地模型配置：通过 HTTP API 访问本地 Ollama 服务
 * 对应 src/config/config.default.ts 中的 ollama 配置段
 */
export interface OllamaConfig {
  /** Ollama 服务地址 */
  baseUrl: string;
  /** 对话模型（Agent 主模型） */
  chatModel: string;
  /** RAG 向量化模型 */
  embeddingModel: string;
}

/**
 * Graph 流式事件的数据结构（SSE）
 * 协议与 web-chat-demo 中 antdx XRequest 的消费方式对齐：
 * 统一走 event: message + JSON data，用 type 字段区分消息类型
 * 相比 langchain-ts-demo 新增 step 事件：向后端每个节点的执行进度
 */
export interface GraphStreamData {
  /** 消息类型：step 为节点执行进度，chunk 为增量内容，done 为结束标记，error 为错误 */
  type: 'step' | 'chunk' | 'done' | 'error';
  /** 所属会话线程 ID（langgraph checkpointer 的 thread_id） */
  threadId: number;
  /** 节点标识（type=step 时有值，如 classify / retrieve / agent / tools / respond） */
  node?: string;
  /** 节点中文名（type=step 时有值，前端直接展示） */
  label?: string;
  /** 节点执行摘要（type=step 时有值：意图分类结果、工具名、检索片段数等） */
  detail?: string;
  /** 增量文本内容（type=chunk 时有值） */
  content?: string;
  /** 错误信息（type=error 时有值） */
  message?: string;
}
