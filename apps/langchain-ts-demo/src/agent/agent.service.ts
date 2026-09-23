import { Provide, Scope, ScopeEnum, Inject, Config } from '@midwayjs/core';
import { ChatOpenAI } from '@langchain/openai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { OllamaConfig } from '../interface';
import { ChatHistoryService } from '../service/chatHistory.service';
import { RagService } from './rag/rag.service';
import { AGENT_SYSTEM_PROMPT } from './prompts';
import { calculatorTool } from './tools/calculator.tool';
import { createKnowledgeSearchTool } from './tools/knowledge.tool';

/**
 * Agent 编排服务：基于 langgraph 的 createReactAgent 组合以下能力
 * - prompt：系统提示词（prompts.ts 集中管理）
 * - 上下文：从 MySQL 加载会话历史，随每轮请求传入
 * - tools：calculator（数学计算）+ knowledge_search（RAG 检索）
 * - 模型：ChatOpenAI（OpenAI 兼容客户端）指向本地 Ollama 的 /v1 端点
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class AgentService {
  @Config('ollama')
  ollamaConfig: OllamaConfig;

  @Inject()
  chatHistoryService: ChatHistoryService;

  @Inject()
  ragService: RagService;

  /** Agent 惰性构建缓存 */
  private agent: ReturnType<typeof createReactAgent> | null = null;

  /**
   * 惰性构建 Agent：延迟到首次请求，避免应用启动时创建模型连接
   */
  private getAgent(): ReturnType<typeof createReactAgent> {
    if (!this.agent) {
      // 使用 OpenAI 兼容客户端指向 Ollama 的 /v1 端点：
      const model = new ChatOpenAI({
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
      this.agent = createReactAgent({
        llm: model,
        tools: [calculatorTool, createKnowledgeSearchTool(this.ragService)],
        prompt: AGENT_SYSTEM_PROMPT,
      });
    }
    return this.agent;
  }

  /**
   * 同步问答：等待完整回答后一次性返回（已剥离思考内容）
   */
  async chat(sessionId: number, content: string): Promise<string> {
    const history = await this.chatHistoryService.loadHistory(sessionId);
    const result = await this.getAgent().invoke({
      messages: [...history, new HumanMessage(content)],
    });
    const lastMessage = result.messages[result.messages.length - 1];
    return stripThinkTags(String(lastMessage.content));
  }

  /**
   * 流式问答：逐 chunk 输出增量内容（已剥离思考内容）
   */
  async *chatStream(
    sessionId: number,
    content: string
  ): AsyncGenerator<string, void, undefined> {
    const history = await this.chatHistoryService.loadHistory(sessionId);
    const stream = await this.getAgent().stream(
      { messages: [...history, new HumanMessage(content)] },
      { streamMode: 'messages' }
    );
    const thinkStripper = new ThinkTagStripper();
    for await (const [messageChunk] of stream) {
      // 只透传 AI 文本增量，过滤工具调用等中间过程
      if (!(messageChunk instanceof AIMessageChunk)) continue;
      if (messageChunk.tool_call_chunks?.length) continue;
      if (typeof messageChunk.content !== 'string' || messageChunk.content === '') {
        continue;
      }
      const visibleText = thinkStripper.push(messageChunk.content);
      if (visibleText) yield visibleText;
    }
    const restText = thinkStripper.flush();
    if (restText) yield restText;
  }
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
