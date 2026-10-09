import { Controller, Post, Inject, Body, httpError } from '@midwayjs/core';
import { Context } from '@midwayjs/web';
import { GraphService } from '../agent/graph.service';
import type { GraphStreamData } from '../interface';

/**
 * 对话接口层：Graph 流式问答（SSE）
 * SSE 协议与 web-chat-demo 中 antdx XRequest 的消费方式对齐：
 * event 统一为 message，data 内用 type 字段区分 step / chunk / done / error
 */
@Controller('/api/graph')
export class ChatController {
  @Inject()
  ctx: Context;

  @Inject()
  graphService: GraphService;

  /**
   * 流式问答（复用端点，按请求参数区分两种模式）：
   * - 对话模式：body.content → 新开一轮 Graph 执行
   * - 恢复模式：body.resume → 客户端工具结果回传后从 interrupt 断点续跑
   * SSE 输出节点执行进度（step）、AI 文本增量（chunk）、
   * 客户端工具待执行（interrupt）等事件
   * sessionId 即 langgraph checkpointer 的 thread_id：
   * 首次对话由后端生成（时间戳），后续请求携带同一值即可延续多轮上下文
   */
  @Post('/chat/stream')
  async chatStream(
    @Body()
    body: {
      sessionId?: number;
      content?: string;
      resume?: { results: string[] };
    }
  ) {
    const { content, resume } = body;
    if (!content?.trim() && !resume?.results?.length) {
      throw new httpError.BadRequestError('content 与 resume 不能同时为空');
    }
    const sessionId = body.sessionId ?? Date.now();

    // SSE 响应头：禁用缓存与代理缓冲，保证 token 级实时输出
    // no-transform 是关键：HTTP 标准指令，禁止中间层转换响应体。
    // umi dev server 的 compression 中间件检测到该头会直接跳过 gzip/br
    // 压缩（实测验证），否则 SSE 小 chunk 会积压在 zlib 缓冲区导致无流式效果
    this.ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
    this.ctx.set('Cache-Control', 'no-cache, no-transform');
    this.ctx.set('Connection', 'keep-alive');
    this.ctx.set('X-Accel-Buffering', 'no');
    this.ctx.status = 200;
    this.ctx.res.flushHeaders?.();

    const send = (data: GraphStreamData) => {
      this.ctx.res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // 恢复模式走 resumeChatStream（同一 thread_id 从断点续跑），否则新开对话
      const eventIterable = resume
        ? this.graphService.resumeChatStream(sessionId, resume.results)
        : this.graphService.chatStream(sessionId, content!);
      for await (const event of eventIterable) {
        send(event);
      }
      send({ type: 'done', threadId: sessionId });
    } catch (error) {
      // 出错时也保证完整的 SSE 事件序列，便于前端统一收口
      send({
        type: 'error',
        threadId: sessionId,
        message: String(error),
      });
    } finally {
      this.ctx.res.end();
    }
  }
}
