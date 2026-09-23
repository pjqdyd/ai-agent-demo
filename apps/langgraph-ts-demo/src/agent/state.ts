import { Annotation } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { Document } from '@langchain/core/documents';

/**
 * 用户意图分类（classify 节点的结构化输出，也是图的分支依据）
 * - chat：日常闲聊，直接回答
 * - knowledge：涉及公司制度、产品知识等内部信息，走 RAG 检索
 * - compute：数学计算类，进入 Agent 工具调用循环
 */
export type Intent = 'chat' | 'knowledge' | 'compute';

/**
 * Graph 全局状态定义（StateGraph 的单例 State）
 * - messages：对话消息列表（reducer 追加式合并，checkpointer 持久化实现多轮）
 * - intent：意图分类结果（每轮覆盖写入）
 * - retrievedDocs：RAG 检索到的知识片段
 * - error：节点异常信息（非空时触发错误路由：重试 / 告警兜底）
 * - failedNode：出错节点名（retry 节点据此路由回出错节点重试）
 * - retryCount：已重试次数（超过上限进入 errorHandler）
 */
export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  intent: Annotation<Intent>({
    reducer: (_, right) => right,
    default: () => 'chat',
  }),
  retrievedDocs: Annotation<Document[]>({
    reducer: (_, right) => right ?? [],
    default: () => [],
  }),
  error: Annotation<string | null>({
    reducer: (_, right) => right,
    default: () => null,
  }),
  failedNode: Annotation<string>({
    reducer: (_, right) => right ?? '',
    default: () => '',
  }),
  retryCount: Annotation<number>({
    reducer: (_, right) => right,
    default: () => 0,
  }),
});

export type GraphStateType = typeof GraphState.State;
