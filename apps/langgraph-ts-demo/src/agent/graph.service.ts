import { Provide, Scope, ScopeEnum, Config, Inject } from '@midwayjs/core';
import { StateGraph, MemorySaver, START, END } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { OllamaConfig, GraphStreamData } from '../interface';
import { RagService } from './rag/rag.service';
import { calculatorTool } from './tools/calculator.tool';
import { GraphState } from './state';
import type { GraphStateType, Intent } from './state';
import {
  CLASSIFY_SYSTEM_PROMPT,
  AGENT_SYSTEM_PROMPT,
  RESPOND_SYSTEM_PROMPT,
  ERROR_FALLBACK_TEMPLATE,
} from './prompts';

/** 错误重试次数上限：超过后路由到告警兜底节点 */
const MAX_RETRY_COUNT = 1;

/**
 * 节点中文名映射：随 step 事件下发给前端 Timeline 直接展示
 */
const NODE_LABELS: Record<string, string> = {
  classify: '意图分类',
  retrieve: '知识检索（RAG）',
  agent: 'Agent 决策',
  tools: '工具执行',
  respond: '回答生成',
  retry: '错误重试',
  errorHandler: '告警兜底',
};

/**
 * Graph 编排服务：基于 StateGraph 手工编排以下能力（区别于 langchain-ts-demo 的 createReactAgent）
 * - 分支：classify 节点按意图路由到 respond（闲聊）/ retrieve（RAG）/ agent（工具循环）
 * - 循环：agent ⇄ tools 的 ReAct 工具调用循环
 * - 多步：classify → retrieve → respond / agent → tools → respond 的多节点链路
 * - 错误处理：节点异常写入 state.error，统一路由到重试（retry）或告警兜底（errorHandler）
 * - 状态持久化：checkpointer（开发态 MemorySaver）按 thread_id 隔离，实现多轮对话与断点续跑
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class GraphService {
  @Config('ollama')
  ollamaConfig: OllamaConfig;

  @Inject()
  ragService: RagService;

  /** 编译后的 Graph 惰性构建缓存（类型由 compileWorkflow 的返回值推断） */
  private graph: ReturnType<GraphService['compileWorkflow']> | null = null;

  /**
   * 检查点存储器（state 持久化核心）：
   * - 开发态使用 MemorySaver：状态存内存，服务重启后丢失，按 thread_id 隔离多轮对话
   * - 生产环境替换为 PostgresSaver 实现跨进程持久化（断点续跑 / human-in-the-loop 依赖它）：
   *     pnpm add @langchain/langgraph-checkpoint-postgres
   *     import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
   *     const checkpointer = PostgresSaver.fromConnString('postgresql://user:pass@host:5432/db');
   *     await checkpointer.setup(); // 首次运行自动建表
   */
  private checkpointer = new MemorySaver();

  /**
   * 获取编译后的 Graph：首次调用时构建并缓存
   */
  buildGraph() {
    if (!this.graph) {
      this.graph = this.compileWorkflow();
    }
    return this.graph;
  }

  /**
   * 构建 Graph：节点注册 + 条件边（分支/循环/错误路由）+ checkpointer 编译
   */
  private compileWorkflow() {
    const baseModel = this.createModel();
    // 意图分类模型：结构化输出枚举，作为图分支依据
    const classifyModel = baseModel.withStructuredOutput(
      z.object({
        intent: z
          .enum(['chat', 'knowledge', 'compute'])
          .describe('用户意图分类结果'),
      })
    );
    // 工具决策模型：绑定 calculator，进入 ReAct 工具调用循环
    const toolModel = baseModel.bindTools([calculatorTool]);
    // 回答生成模型：chat / knowledge 分支的统一出口
    const respondModel = baseModel;

    /** classify 节点：意图分类（LLM 结构化输出），异常写入 state.error */
    const classifyNode = async (state: GraphStateType) => {
      try {
        const question = getLastUserContent(state.messages);
        const { intent } = await classifyModel.invoke([
          new SystemMessage(CLASSIFY_SYSTEM_PROMPT),
          new HumanMessage(question),
        ]);
        return { intent };
      } catch (error) {
        return buildNodeError('classify', error);
      }
    };

    /** retrieve 节点：RAG 知识检索（检索结果写入 state 供 respond 节点引用） */
    const retrieveNode = async (state: GraphStateType) => {
      try {
        const question = getLastUserContent(state.messages);
        const documents = await this.ragService.search(question);
        return { retrievedDocs: documents };
      } catch (error) {
        return buildNodeError('retrieve', error);
      }
    };

    /** agent 节点：ReAct 循环的推理节点，产出工具调用或最终回答 */
    const agentNode = async (state: GraphStateType) => {
      try {
        const response = await toolModel.invoke([
          new SystemMessage(AGENT_SYSTEM_PROMPT),
          ...state.messages,
        ]);
        if (!response.tool_calls?.length) {
          // 最终回答：剥离思考标签后入库，保持 checkpointer 历史干净
          return {
            messages: [
              new AIMessage({ content: stripThinkTags(String(response.content)) }),
            ],
          };
        }
        return { messages: [response] };
      } catch (error) {
        return buildNodeError('agent', error);
      }
    };

    /** tools 节点：执行 agent 产出的工具调用，结果以 ToolMessage 回填触发下一轮循环 */
    const toolsNode = async (state: GraphStateType) => {
      try {
        const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
        const toolResults: ToolMessage[] = [];
        for (const toolCall of lastMessage.tool_calls ?? []) {
          const observed = await calculatorTool.invoke(toolCall);
          toolResults.push(
            new ToolMessage({
              content: String(observed),
              tool_call_id: toolCall.id ?? '',
              name: toolCall.name,
            })
          );
        }
        return { messages: toolResults };
      } catch (error) {
        return buildNodeError('tools', error);
      }
    };

    /** respond 节点：最终回答生成（knowledge 分支拼接检索上下文） */
    const respondNode = async (state: GraphStateType) => {
      try {
        const knowledgeContext =
          state.retrievedDocs.map(document => document.pageContent).join('\n---\n') ||
          '（知识库未检索到内容）';
        const systemPrompt = RESPOND_SYSTEM_PROMPT.replace(
          '{{knowledgeContext}}',
          knowledgeContext
        );
        const answer = await respondModel.invoke([
          new SystemMessage(systemPrompt),
          ...state.messages,
        ]);
        return {
          messages: [
            new AIMessage({ content: stripThinkTags(String(answer.content)) }),
          ],
        };
      } catch (error) {
        return buildNodeError('respond', error);
      }
    };

    /** retry 节点：清空错误并累计重试次数，随后条件边路由回出错节点 */
    const retryNode = async (state: GraphStateType) => ({
      error: null,
      retryCount: state.retryCount + 1,
    });

    /** errorHandler 节点：告警兜底（模板文案，不调用 LLM，避免故障时二次失败） */
    const errorHandlerNode = async (state: GraphStateType) => ({
      messages: [
        new AIMessage({
          content: ERROR_FALLBACK_TEMPLATE.replace(
            '{{errorMessage}}',
            state.error ?? '未知错误'
          ),
        }),
      ],
    });

    /** 出错时的统一路由：未超重试上限则重试，否则进入告警兜底 */
    const routeByError = (state: GraphStateType): 'retry' | 'errorHandler' =>
      state.retryCount < MAX_RETRY_COUNT ? 'retry' : 'errorHandler';

    const routeAfterClassify = (state: GraphStateType): string => {
      if (state.error) {
        return routeByError(state);
      }
      const intentRoutes: Record<Intent, string> = {
        chat: 'respond',
        knowledge: 'retrieve',
        compute: 'agent',
      };
      return intentRoutes[state.intent];
    };

    const routeAfterRetrieve = (state: GraphStateType): 'respond' | 'retry' | 'errorHandler' =>
      state.error ? routeByError(state) : 'respond';

    const routeAfterAgent = (state: GraphStateType): string => {
      if (state.error) {
        return routeByError(state);
      }
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      // 有工具调用则进入 tools 节点（循环），否则结束
      return lastMessage.tool_calls?.length ? 'tools' : END;
    };

    const routeAfterTools = (state: GraphStateType): string =>
      state.error ? routeByError(state) : 'agent';

    const routeAfterRespond = (
      state: GraphStateType
    ): typeof END | 'retry' | 'errorHandler' => (state.error ? routeByError(state) : END);

    const routeAfterRetry = (state: GraphStateType): string =>
      state.failedNode || 'errorHandler';

    const workflow = new StateGraph(GraphState)
      .addNode('classify', classifyNode)
      .addNode('retrieve', retrieveNode)
      .addNode('agent', agentNode)
      .addNode('tools', toolsNode)
      .addNode('respond', respondNode)
      .addNode('retry', retryNode)
      .addNode('errorHandler', errorHandlerNode)
      .addEdge(START, 'classify')
      .addConditionalEdges('classify', routeAfterClassify, [
        'retrieve',
        'agent',
        'respond',
        'retry',
        'errorHandler',
      ])
      .addConditionalEdges('retrieve', routeAfterRetrieve, [
        'respond',
        'retry',
        'errorHandler',
      ])
      .addConditionalEdges('agent', routeAfterAgent, [
        'tools',
        END,
        'retry',
        'errorHandler',
      ])
      .addConditionalEdges('tools', routeAfterTools, [
        'agent',
        'retry',
        'errorHandler',
      ])
      .addConditionalEdges('respond', routeAfterRespond, [
        END,
        'retry',
        'errorHandler',
      ])
      .addConditionalEdges('retry', routeAfterRetry, [
        'classify',
        'retrieve',
        'agent',
        'tools',
        'respond',
        'errorHandler',
      ])
      .addEdge('errorHandler', END);

    return workflow.compile({
      checkpointer: this.checkpointer,
      // human-in-the-loop（可选）：配置 interruptBefore 可在指定节点前暂停执行，
      // 配合 checkpointer 实现人工审批后从断点续跑：
      //   interruptBefore: ['tools']
      // 审批通过后恢复执行：graph.stream(null, { configurable: { thread_id } })
    });
  }

  /**
   * 导出 Graph 的 mermaid 图文本（文档 / 调试用）
   */
  exportMermaid(): string {
    return this.buildGraph().getGraph().drawMermaid();
  }

  /**
   * 流式执行 Graph：逐步产出 step（节点进度）与 chunk（AI 文本增量）事件
   * 通过 streamMode 组合同时消费节点更新（updates）与 LLM token 流（messages）
   */
  async *chatStream(
    threadId: number,
    content: string
  ): AsyncGenerator<GraphStreamData, void, undefined> {
    const graph = this.buildGraph();
    // 多轮上下文依赖 checkpointer：仅传增量用户消息，历史由 thread state 自动携带
    const stream = await graph.stream(
      { messages: [new HumanMessage(content)] },
      {
        configurable: { thread_id: String(threadId) },
        streamMode: ['updates', 'messages'],
      }
    );
    const thinkStripper = new ThinkTagStripper();
    let lastError: string | null = null;

    for await (const entry of stream) {
      const [mode, payload] = entry as [string, unknown];
      if (mode === 'updates') {
        // updates：节点执行完成的 state 增量，据此下发 step 事件
        for (const [nodeName, delta] of Object.entries(
          payload as Record<string, Partial<GraphStateType>>
        )) {
          if (delta?.error) {
            lastError = delta.error;
          }
          yield {
            type: 'step',
            threadId,
            node: nodeName,
            label: NODE_LABELS[nodeName] ?? nodeName,
            detail: summarizeNodeDelta(nodeName, delta),
          };
          // errorHandler 的兜底文案不经过 LLM，无 token 流，需手动下发
          if (nodeName === 'errorHandler') {
            const fallbackContent = delta?.messages?.at(-1)?.content;
            if (typeof fallbackContent === 'string' && fallbackContent) {
              yield { type: 'chunk', threadId, content: fallbackContent };
            }
          }
        }
        continue;
      }
      // messages：LLM token 流，只透传 AI 文本增量，过滤工具调用等中间过程
      // 多 streamMode 下 payload 兼容两种形状：AIMessageChunk 或 [chunk, metadata] 元组
      const messageChunk = (
        Array.isArray(payload) ? payload[0] : payload
      ) as unknown;
      if (!(messageChunk instanceof AIMessageChunk)) continue;
      if (messageChunk.tool_call_chunks?.length) continue;
      if (typeof messageChunk.content !== 'string' || messageChunk.content === '') {
        continue;
      }
      const visibleText = thinkStripper.push(messageChunk.content);
      if (visibleText) {
        yield { type: 'chunk', threadId, content: visibleText };
      }
    }
    const restText = thinkStripper.flush();
    if (restText) {
      yield { type: 'chunk', threadId, content: restText };
    }
    // 流结束统一上抛错误事件（兜底文案已作为 chunk 展示）
    if (lastError) {
      yield { type: 'error', threadId, message: lastError };
    }
  }

  /**
   * 创建基础对话模型：OpenAI 兼容客户端指向 Ollama 的 /v1 端点
   */
  private createModel(): ChatOpenAI {
    return new ChatOpenAI({
      model: this.ollamaConfig.chatModel,
      streaming: true,
      configuration: {
        baseURL: `${this.ollamaConfig.baseUrl}/v1`,
      },
      // 本地Ollama不校验API Key，langchain要求非空，占位即可
      apiKey: 'ollama',
      // 关闭 qwen3.5 的思考模式：本地小模型思考耗时过长，关闭后响应从分钟级降到秒级
      // 需要深度推理时可改为 low / medium / high，或删除该参数恢复默认思考
      modelKwargs: { reasoning_effort: 'none' },
    });
  }
}

/**
 * 提取消息列表中最后一条用户输入（意图分类 / RAG 检索的 query 来源）
 */
function getLastUserContent(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) {
      return String(messages[i].content);
    }
  }
  return '';
}

/**
 * 构造节点异常的 state 增量：错误信息 + 出错节点名（供 retry 节点路由回源）
 */
function buildNodeError(nodeName: string, error: unknown) {
  return {
    error: `${nodeName} 节点执行失败：${
      error instanceof Error ? error.message : String(error)
    }`,
    failedNode: nodeName,
  };
}

/**
 * 生成 step 事件的节点执行摘要（detail）：从 state 增量提取可读信息
 */
function summarizeNodeDelta(
  nodeName: string,
  delta: Partial<GraphStateType>
): string {
  if (nodeName === 'classify') {
    return `意图：${delta.intent}`;
  }
  if (nodeName === 'retrieve') {
    return `检索到 ${delta.retrievedDocs?.length ?? 0} 个知识片段`;
  }
  if (nodeName === 'agent') {
    const lastMessage = delta.messages?.[delta.messages.length - 1] as AIMessage;
    const toolNames = lastMessage?.tool_calls?.map(toolCall => toolCall.name) ?? [];
    return toolNames.length ? `准备调用工具：${toolNames.join('、')}` : '产出最终回答';
  }
  if (nodeName === 'tools') {
    const toolNames =
      delta.messages?.map(message => (message as ToolMessage).name ?? '') ?? [];
    return `已执行工具：${toolNames.join('、')}`;
  }
  if (nodeName === 'respond') {
    return '生成最终回答';
  }
  if (nodeName === 'retry') {
    return `第 ${delta.retryCount} 次重试`;
  }
  if (nodeName === 'errorHandler') {
    return '错误已进入告警兜底分支';
  }
  return '';
}

/**
 * 剥离完整文本中的思考内容（qwen3 系列模型，非流式场景）
 */
function stripThinkTags(text: string): string {
  const thinkPattern = new RegExp(`<think>[\\s\\S]*?</think>`, 'g');
  return text.replace(thinkPattern, '').trim();
}

/**
 * 流式输出中剥离思考内容（<think>...</think>）的状态机
 * 标签可能被拆分在多个 chunk 中到达，需跨 chunk 维护缓冲区
 */
class ThinkTagStripper {
  private static readonly START_TAG = '<' + 'think>';
  private static readonly END_TAG = '</' + 'think>';

  private buffer = '';
  private insideThink = false;

  /**
   * 写入一段增量文本，返回可安全输出的部分
   */
  push(text: string): string {
    this.buffer += text;
    let output = '';
    while (this.buffer.length > 0) {
      if (this.insideThink) {
        const endIndex = this.buffer.indexOf(ThinkTagStripper.END_TAG);
        if (endIndex === -1) {
          // 思考内容：丢弃已确认安全的部分，仅保留可能的半截结束标签
          const keepLength = this.trailingTagPrefixLength(ThinkTagStripper.END_TAG);
          this.buffer = this.buffer.slice(-keepLength);
          break;
        }
        this.buffer = this.buffer.slice(
          endIndex + ThinkTagStripper.END_TAG.length
        );
        this.insideThink = false;
      } else {
        const startIndex = this.buffer.indexOf(ThinkTagStripper.START_TAG);
        if (startIndex === -1) {
          // 输出已确认安全的部分，仅保留可能的半截开始标签
          const keepLength = this.trailingTagPrefixLength(ThinkTagStripper.START_TAG);
          const safeLength = this.buffer.length - keepLength;
          if (safeLength > 0) {
            output += this.buffer.slice(0, safeLength);
            this.buffer = this.buffer.slice(safeLength);
          }
          break;
        }
        output += this.buffer.slice(0, startIndex);
        this.buffer = this.buffer.slice(
          startIndex + ThinkTagStripper.START_TAG.length
        );
        this.insideThink = true;
      }
    }
    return output;
  }

  /**
   * 流结束时冲刷缓冲区，返回残余内容
   */
  flush(): string {
    const rest = this.insideThink ? '' : this.buffer;
    this.buffer = '';
    return rest;
  }

  /**
   * 计算缓冲区尾部与标签的最大公共前缀长度（跨 chunk 的半截标签场景）
   */
  private trailingTagPrefixLength(tag: string): number {
    const maxCheckLength = Math.min(this.buffer.length, tag.length - 1);
    for (let i = maxCheckLength; i > 0; i--) {
      if (tag.startsWith(this.buffer.slice(-i))) {
        return i;
      }
    }
    return 0;
  }
}
