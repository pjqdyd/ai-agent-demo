import { Configuration, App, Config, Inject } from '@midwayjs/core';
import * as web from '@midwayjs/web';
import { join } from 'path';
import { GraphService } from './agent/graph.service';
import type { OllamaConfig } from './interface';

/**
 * midway 应用入口：注册 web（egg 场景，提供 HTTP 服务能力）组件
 * 会话状态由 langgraph checkpointer（MemorySaver）持久化，无需 ORM
 */
@Configuration({
  imports: [web],
  importConfigs: [join(__dirname, './config')],
})
export class MainConfiguration {
  @App()
  app: web.Application;

  @Config('egg')
  eggConfig: { port?: number };

  @Config('ollama')
  ollamaConfig: OllamaConfig;

  @Inject()
  graphService: GraphService;

  async onReady() {
    // 应用就绪钩子：预留扩展点（如预热连接、健康检查上报等）
  }

  /**
   * HTTP 服务监听完成后打印启动信息（地址、端口、模型、接口清单、Graph mermaid 图）
   */
  async onServerReady() {
    const port = process.env.MIDWAY_HTTP_PORT || this.eggConfig?.port;
    console.log('');
    console.log('==================================== langgraph-ts-demo Agent 服务已启动');
    console.log(`  - 服务地址: http://127.0.0.1:${port}`);
    console.log(`  - 对话模型: ${this.ollamaConfig.chatModel}（Ollama: ${this.ollamaConfig.baseUrl}）`);
    console.log(`  - 向量模型: ${this.ollamaConfig.embeddingModel}`);
    console.log('  - 接口清单:');
    console.log('      POST /api/graph/chat/stream             流式问答（SSE，含节点执行进度）');
    console.log('=======================================================================================');
    // Graph 可视化：drawMermaid 导出图结构，可粘贴到 mermaid.live 或 IDE 插件渲染（文档 / 调试）
    try {
      console.log('  - Graph 结构（mermaid）:');
      console.log(this.graphService.exportMermaid());
    } catch (error) {
      // mermaid 导出失败不影响服务，仅提示
      console.warn(`  - Graph mermaid 导出失败：${String(error)}`);
    }
    console.log('=======================================================================================');
  }
}
