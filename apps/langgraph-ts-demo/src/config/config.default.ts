import { MidwayConfig } from '@midwayjs/core';

/**
 * 通用配置：端口、Ollama 模型
 * LangSmith 链路追踪（可选，无需任何埋点）：启动前设置环境变量即可自动上报
 * 每个节点 / LLM / tool 的耗时、输入输出与 token 用量：
 *   LANGCHAIN_TRACING_V2=true
 *   LANGCHAIN_API_KEY=lsv2_xxx
 *   LANGCHAIN_PROJECT=langgraph-ts-demo
 */
export default {
  // 会话安全密钥（egg cookie 签名用）
  keys: 'ai-agent-demo-session-keys',

  // HTTP 服务端口：egg 场景从 egg.port 读取监听端口
  // web-chat-demo 通过 umi proxy 将 /api/graph 转发到此端口
  egg: {
    port: 6002,
  },

  // Ollama 本地模型配置（通过 API 调用本地 Ollama 服务）
  // 首次使用需执行：ollama pull qwen3.5:2b 与 ollama pull nomic-embed-text
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    chatModel: 'qwen3.5:2b',
    embeddingModel: 'nomic-embed-text',
  },

  // 关闭 egg-security 默认的 CSRF 校验：
  // 本项目是纯 JSON API 服务，POST 接口供 web-chat-demo（antdx）直接调用，不使用表单
  security: {
    csrf: {
      enable: false,
    },
  },
} as MidwayConfig;
