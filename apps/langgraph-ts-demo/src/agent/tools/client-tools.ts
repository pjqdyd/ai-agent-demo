import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * 客户端工具：仅向后端模型声明 schema 供决策，真正执行发生在浏览器端
 * 执行流程：tools 节点检测到客户端工具调用后通过 interrupt() 暂停图执行，
 * 前端确认后调用注册表执行工具，再以 Command({ resume }) 回传结果续跑
 * 注意：下方执行体不会在后端真正运行，结果始终由前端回传
 */

/** 获取当前页面 URL（window.location.href） */
export const getPageUrlTool = tool(
  async () => '',
  {
    name: 'getPageUrl',
    description: '获取用户当前浏览的页面 URL（浏览器环境信息）',
    schema: z.object({}),
  }
);

/** 获取浏览器 userAgent（navigator.userAgent） */
export const getUserAgentTool = tool(
  async () => '',
  {
    name: 'getUserAgent',
    description:
      '获取用户浏览器的 userAgent 信息（浏览器类型、内核版本等环境特征）',
    schema: z.object({}),
  }
);

/** 客户端工具集合：与 calculator 一并绑定给 agent 节点的工具决策模型 */
export const clientTools = [getPageUrlTool, getUserAgentTool];

/** 客户端工具名白名单：tools 节点据此区分"后端执行"与"interrupt 交前端执行" */
export const CLIENT_TOOL_NAMES = new Set(
  clientTools.map(clientTool => clientTool.name)
);
