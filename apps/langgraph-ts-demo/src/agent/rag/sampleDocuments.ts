/**
 * 示例知识文档：演示 RAG 入库与检索，首次检索前自动写入向量库
 */
export interface SampleDocument {
  title: string;
  content: string;
}

export const SAMPLE_DOCUMENTS: SampleDocument[] = [
  {
    title: 'AI-Agent-Demo 产品介绍',
    content: `AI-Agent-Demo 是一个演示型全栈 AI 应用工程示例。后端基于 midway.js + egg + typeorm 构建，
提供会话管理、Agent 编排与 RAG 知识库能力；模型层通过 Ollama API 调用本地大语言模型。
前端 web-chat-demo 使用 React + antd + antdx（@ant-design/x）构建对话界面。
项目采用 pnpm workspace 管理的 monorepo 结构，由 turborepo 负责编排构建任务。`,
  },
  {
    title: '员工考勤与请假制度',
    content: `AI-Agent-Demo 演示公司的考勤制度如下：
1. 工作时间为每周一至周五 9:00-18:00，午休时间 12:00-13:30。
2. 年假：入职满 1 年享有 5 天年假，每满 2 年增加 1 天，上限 10 天。
3. 病假：需提供二级及以上医院证明，全年带薪病假不超过 10 天。
4. 事假：提前 1 个工作日在 OA 系统申请，事假期间不计薪。`,
  },
];
