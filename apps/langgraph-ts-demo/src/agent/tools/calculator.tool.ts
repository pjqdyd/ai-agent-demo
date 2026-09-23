import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * 计算器工具：演示如何用 zod schema 定义参数并接入 Agent 工具循环
 * 表达式先做字符白名单校验，防止动态执行注入风险
 */
export const calculatorTool = tool(
  async ({ expression }) => {
    if (!/^[\d+\-*/().\s]+$/.test(expression)) {
      return '表达式包含不支持的字符，仅支持数字与 + - * / ( )';
    }
    try {
      // eslint-disable-next-line no-new-func
      const result = new Function(`return (${expression})`)();
      return `计算结果：${result}`;
    } catch {
      return '表达式解析失败，请检查格式';
    }
  },
  {
    name: 'calculator',
    description: '计算数学表达式，支持加减乘除与括号，例如 "1 + 2 * 3"',
    schema: z.object({
      expression: z.string().describe('待计算的数学表达式'),
    }),
  }
);
