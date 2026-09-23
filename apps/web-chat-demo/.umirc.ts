import { defineConfig } from "umi";

export default defineConfig({
  routes: [
    { path: "/", component: "index" },
    { path: "/docs", component: "docs" },
    { path: "/chat", component: "chat" },
    { path: "/chat-sdk", component: "chat-sdk" },
    { path: "/chat-agent", component: "chat-agent" },
    { path: "/chat-agent-graph", component: "chat-agent-graph" },
  ],
  // 本地开发代理：将 /api 请求转发到 langchain-ts-demo（6001 端口），支持 SSE 流式转发
  // SSE 的防压缩依赖后端响应头 Cache-Control: no-transform（compression 中间件检测到即跳过压缩）
  // /api/graph 需放在 /api 之前：proxy 按对象键顺序匹配，长前缀优先转发到 langgraph-ts-demo（6002 端口）
  proxy: {
    "/api/graph": {
      target: "http://localhost:6002",
      changeOrigin: true,
    },
    "/api": {
      target: "http://localhost:6001",
      changeOrigin: true,
    },
  },
  npmClient: 'pnpm',
  esbuildMinifyIIFE: true,
  // utoopack: {},
});
