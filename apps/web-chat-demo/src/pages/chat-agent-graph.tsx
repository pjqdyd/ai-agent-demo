import React from 'react';
import { SyncOutlined } from '@ant-design/icons';
import type { BubbleListProps } from '@ant-design/x';
import { Bubble, Sender } from '@ant-design/x';
import XMarkdown from '@ant-design/x-markdown';
import {
    AbstractChatProvider,
    useXChat,
    XRequest,
} from '@ant-design/x-sdk';
import type {
    ChatProviderConfig,
    SSEOutput,
    TransformMessage,
    XRequestOptions,
} from '@ant-design/x-sdk';
import { Button, Flex, Timeline, Tooltip, Alert } from 'antd';

/**
 * langgraph-ts-demo 流式问答接口（umi dev server 通过 proxy 转发到后端 6002 端口）
 * 对话与客户端工具恢复（resume）复用同一端点，按请求参数区分
 */
const CHAT_STREAM_URL = '/api/graph/chat/stream';

/** 客户端工具结果回传后展示的本地提示文案 */
const TOOL_RESULT_SENT_TEXT = '客户端工具结果已回传，等待 Agent 继续';

/**
 * 客户端工具注册表：后端 interrupt 暂停后，经用户确认在浏览器内执行
 * key 与 langgraph-ts-demo src/agent/tools/client-tools.ts 的工具名对齐
 */
const clientToolRegistry: Record<string, () => string> = {
    getPageUrl: () => window.location.href,
    getUserAgent: () => navigator.userAgent,
};

/**
 * 后端 SSE 事件的数据结构（与 langgraph-ts-demo src/interface.ts 的 GraphStreamData 对齐）
 * 相比 langchain-ts-demo 新增 step 事件：上报 Graph 每个节点的执行进度
 * 新增 interrupt 事件：客户端工具待用户确认后在浏览器执行
 */
interface GraphStreamData {
    /** 消息类型：step 为节点执行进度，chunk 为增量内容，interrupt 为客户端工具待执行，done 为结束标记，error 为错误 */
    type: 'step' | 'chunk' | 'interrupt' | 'done' | 'error';
    /** 所属会话线程 ID（langgraph checkpointer 的 thread_id） */
    threadId: number;
    /** 节点标识（type=step 时有值） */
    node?: string;
    /** 节点中文名（type=step 时有值） */
    label?: string;
    /** 节点执行摘要（type=step 时有值：意图、工具名、检索片段数等） */
    detail?: string;
    /** 待前端执行的客户端工具调用（type=interrupt 时有值） */
    toolCalls?: ClientToolCall[];
    /** 增量文本内容（type=chunk 时有值） */
    content?: string;
    /** 错误信息（type=error 时有值） */
    message?: string;
}

/** 客户端工具调用描述（interrupt 事件携带，前端在浏览器内执行） */
interface ClientToolCall {
    /** 工具调用 ID（与后端 LLM tool_calls 的 id 对齐） */
    id: string;
    /** 工具名（如 getPageUrl / getUserAgent） */
    name: string;
    /** 工具参数（当前两个客户端工具均为空对象） */
    args: Record<string, unknown>;
}

/** 发送给后端的请求参数（sessionId 可选；resume 用于客户端工具结果回传） */
interface GraphRequestParams {
    sessionId?: number;
    content: string;
    /** 客户端工具执行结果（与 interrupt 事件的 toolCalls 顺序对齐） */
    resume?: { results: string[] };
}

/** 执行步骤条目：Graph 单个节点的执行记录，用于 Timeline 展示 */
interface GraphStepItem {
    /** 节点标识 */
    node: string;
    /** 节点中文名 */
    label: string;
    /** 节点执行摘要 */
    detail: string;
}

/** 聊天消息结构：在文本基础上附带 Graph 执行步骤与待执行的客户端工具 */
interface GraphChatMessage {
    role: 'user' | 'assistant';
    content: string;
    /** assistant 消息的节点执行步骤（按执行顺序累积） */
    steps: GraphStepItem[];
    /** 待确认执行的客户端工具调用（interrupt 事件挂载，确认后清除） */
    pendingToolCalls?: ClientToolCall[];
}

// 本地化钩子：根据当前语言环境返回对应的文本
const useLocale = () => {
    const isCN = true;
    return {
        abort: isCN ? '中止' : 'abort',
        placeholder: isCN
            ? '请输入内容，按下 Enter 发送消息（试试：公司年假有几天？ / 计算 (12 + 8) * 3 / 我当前页面的 URL 是什么？）'
            : 'Please enter content and press Enter to send message',
        waiting: isCN ? 'Graph 执行中，请稍候...' : 'Graph is running, please wait...',
        requestFailed: isCN ? '请求失败，请重试！' : 'Request failed, please try again!',
        requestAborted: isCN ? '请求已中止' : 'Request is aborted',
        noMessages: isCN
            ? '暂无消息，请输入问题并发送'
            : 'No messages yet, please enter a question and send',
        requesting: isCN ? '请求中' : 'Requesting',
        qaCompleted: isCN ? '问答完成' : 'Q&A completed',
        retry: isCN ? '重试' : 'Retry',
        currentStatus: isCN ? '当前状态：' : 'Current status:',
        stepsTitle: isCN ? '执行步骤' : 'Execution steps',
        confirmToolTitle: isCN
            ? 'Agent 请求调用客户端工具，确认后将在浏览器内执行'
            : 'Agent requests client tools, they will run in the browser',
        allowToolRun: isCN ? '允许执行并回传结果' : 'Allow and send results',
    };
};

/**
 * Graph 聊天 Provider：对接 langgraph-ts-demo 的自定义 SSE 协议
 * 在 langchain-ts-demo 的 Provider 基础上扩展 step 事件：
 * 每个节点执行完成后追加一条执行步骤，供 Timeline 组件展示
 */
class GraphChatProvider extends AbstractChatProvider<
    GraphChatMessage,
    GraphRequestParams,
    SSEOutput
> {
    // 会话线程 ID 引用：首次请求由后端生成，后续请求携带以延续多轮上下文（checkpointer thread）
    private readonly sessionIdRef: React.MutableRefObject<number | undefined>;

    constructor(
        config: ChatProviderConfig<
            GraphRequestParams,
            SSEOutput,
            GraphChatMessage
        >,
        sessionIdRef: React.MutableRefObject<number | undefined>,
    ) {
        super(config);
        this.sessionIdRef = sessionIdRef;
    }

    // 转换请求参数：组装后端需要的 { sessionId?, content, resume? }
    transformParams(
        requestParams: Partial<GraphRequestParams>,
        options: XRequestOptions<GraphRequestParams, SSEOutput, GraphChatMessage>,
    ): GraphRequestParams {
        return {
            ...(options?.params || {}),
            // 首次对话无 sessionId，由后端生成线程 ID 后随 SSE 事件返回
            ...(this.sessionIdRef.current !== undefined
                ? { sessionId: this.sessionIdRef.current }
                : {}),
            // 客户端工具恢复模式：透传结果数组，后端据此从 interrupt 断点续跑
            ...(requestParams?.resume ? { resume: requestParams.resume } : {}),
            content: requestParams?.content || '',
        };
    }

    // 用户发送的内容转换为本地渲染消息（resume 轮展示工具结果回传提示）
    transformLocalMessage(
        requestParams: Partial<GraphRequestParams>,
    ): GraphChatMessage {
        if (requestParams?.resume) {
            return {
                role: 'assistant',
                content: TOOL_RESULT_SENT_TEXT,
                steps: [],
            };
        }
        return {
            role: 'user',
            content: requestParams?.content || '',
            steps: [],
        };
    }

    // 解析 SSE chunk：累积节点步骤与回答内容，并记录线程 ID
    transformMessage(
        info: TransformMessage<GraphChatMessage, SSEOutput>,
    ): GraphChatMessage {
        const { originMessage, chunk } = info;
        // 请求成功收尾时会以 chunk=undefined 触发一次，直接沿用已有内容
        if (!chunk) {
            return {
                role: 'assistant',
                content: originMessage?.content || '',
                steps: originMessage?.steps || [],
                pendingToolCalls: originMessage?.pendingToolCalls,
            };
        }
        let content = originMessage?.content || '';
        const steps = [...(originMessage?.steps || [])];
        // 默认继承已有挂起值：interrupt 之后的 done 等事件不会清空待执行工具
        let pendingToolCalls = originMessage?.pendingToolCalls;
        try {
            const data: GraphStreamData = JSON.parse(chunk.data);
            if (data.type === 'step') {
                // 节点执行完成：追加执行步骤，供 Timeline 展示
                steps.push({
                    node: data.node || '',
                    label: data.label || data.node || '',
                    detail: data.detail || '',
                });
            } else if (data.type === 'interrupt') {
                // 客户端工具待执行：挂到消息上，由组件层渲染确认卡片
                pendingToolCalls = data.toolCalls || [];
                steps.push({
                    node: 'clientTools',
                    label: '客户端工具',
                    detail: `等待确认执行：${pendingToolCalls
                        .map(toolCall => toolCall.name)
                        .join('、')}`,
                });
            } else if (data.type === 'chunk') {
                // 记录后端返回的线程 ID，实现多轮对话
                this.sessionIdRef.current = data.threadId;
                content += data.content || '';
            } else if (data.type === 'error') {
                // 后端处理异常时，将错误信息直接展示在回答中
                content += data.message || '服务异常，请稍后重试';
            }
            // type=done 为结束标记，无正文，沿用已有内容
        } catch (error) {
            console.error('解析 SSE 数据失败', error);
        }
        return {
            role: 'assistant',
            content,
            steps,
            pendingToolCalls,
        };
    }
}

/**
 * 助手消息渲染：上方 Timeline 展示 Graph 执行步骤，下方 Markdown 渲染回答
 */
function renderAssistantMessage(
    content: string,
    steps: GraphStepItem[],
    stepsTitle: string,
) {
    return (
        <Flex vertical gap="small">
            {steps.length > 0 && (
                <Timeline
                    items={[
                        // 标题项：指示下方为节点执行顺序
                        { children: <strong>{stepsTitle}</strong> },
                        ...steps.map((step) => ({
                            children: step.detail
                                ? `${step.label}：${step.detail}`
                                : step.label,
                        })),
                    ]}
                />
            )}
            {/* marked 默认把单个 '\n' 当软换行折叠为空格，开启 breaks 让其渲染为 <br>，
                同时保留列表、标题等块级语法的正常解析（此前 replace '<br/>' 会破坏列表行首标记） */}
            <XMarkdown config={{ breaks: true }} content={content} />
        </Flex>
    );
}

const ChatAgentGraph = () => {
    const [content, setContent] = React.useState('');
    // 会话线程 ID：首次请求由后端生成，随 SSE 事件返回后记录
    const sessionIdRef = React.useRef<number | undefined>(undefined);
    // 已确认执行的客户端工具调用 key：防止同一次 interrupt 重复发起恢复请求
    const resumedToolCallKeysRef = React.useRef<Set<string>>(new Set());
    const locale = useLocale();

    // 自定义 Provider：对接 langgraph-ts-demo 的 SSE 协议
    // 显式声明 Content-Type，否则后端 egg body-parser 无法解析 JSON 请求体
    const [provider] = React.useState(() => {
        return new GraphChatProvider(
            {
                request: XRequest<
                    GraphRequestParams,
                    SSEOutput,
                    GraphChatMessage
                >(CHAT_STREAM_URL, {
                    manual: true,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }),
            },
            sessionIdRef,
        );
    });

    // 聊天消息管理：处理消息列表、请求占位、失败回退等
    const { onRequest, messages, isRequesting, abort, onReload } = useXChat<
        GraphChatMessage,
        GraphChatMessage,
        GraphRequestParams,
        SSEOutput
    >({
        provider,
        requestFallback: (_, { error, messageInfo }) => {
            // 请求失败回退：区分中止错误和其他错误
            if (error.name === 'AbortError') {
                return {
                    content:
                        messageInfo?.message?.content || locale.requestAborted,
                    role: 'assistant',
                    steps: messageInfo?.message?.steps || [],
                };
            }
            return {
                content: error.message || locale.requestFailed,
                role: 'assistant',
                steps: messageInfo?.message?.steps || [],
            };
        },
        requestPlaceholder: () => {
            // 请求占位符：在等待响应时显示等待消息
            return {
                content: locale.waiting,
                role: 'assistant',
                steps: [],
            };
        },
    });

    // 最新 assistant 消息挂起的客户端工具调用（请求空闲时才展示确认卡片）
    const latestMessage = messages?.at(-1)?.message;
    const pendingToolCalls =
        !isRequesting ? latestMessage?.pendingToolCalls : undefined;

    // 确认执行：按 interrupt 下发的调用顺序执行本地注册表，回传结果数组
    const handleAllowToolRun = () => {
        if (!pendingToolCalls?.length) {
            return;
        }
        const resumeKey = pendingToolCalls
            .map(toolCall => toolCall.id)
            .join(',');
        if (resumedToolCallKeysRef.current.has(resumeKey)) {
            return;
        }
        resumedToolCallKeysRef.current.add(resumeKey);
        onRequest({
            resume: {
                results: pendingToolCalls.map(
                    toolCall =>
                        clientToolRegistry[toolCall.name]?.() ??
                        '前端未实现该工具'
                ),
            },
        });
    };

    return (
        <Flex vertical gap="middle">
            {/* 状态区域：显示当前请求状态并提供中止操作 */}
            <Flex align="center" gap="middle">
                <div>
                    {locale.currentStatus}{' '}
                    {isRequesting
                        ? locale.requesting
                        : messages.length === 0
                            ? locale.noMessages
                            : locale.qaCompleted}
                </div>
                {/* 中止按钮：仅在请求进行中时可用 */}
                <Button disabled={!isRequesting} onClick={abort}>
                    {locale.abort}
                </Button>
            </Flex>

            {/* 消息列表：助手消息附 Timeline 执行步骤，支持 Markdown 与重试 */}
            <Bubble.List
                style={{ height: 500 }}
                role={{
                    assistant: {
                        placement: 'start',
                    },
                    user: {
                        placement: 'end',
                    },
                } as BubbleListProps['role']}
                items={messages.map(({ id, message, status }, index) => ({
                    key: id,
                    role: message.role,
                    status: status,
                    loading: status === 'loading',
                    content: message.content,
                    // 助手消息自定义渲染：Timeline 执行步骤 + Markdown 回答
                    contentRender:
                        message.role === 'assistant'
                            ? () =>
                                  renderAssistantMessage(
                                      message.content,
                                      message.steps,
                                      locale.stepsTitle,
                                  )
                            : undefined,
                    // 为助手消息添加重试按钮：取该回答前最近一条用户消息重新请求
                    components:
                        message.role === 'assistant'
                            ? {
                                footer: (
                                    <Tooltip title={locale.retry}>
                                        <Button
                                            size="small"
                                            type="text"
                                            icon={<SyncOutlined />}
                                            style={{ marginInlineEnd: 'auto' }}
                                            onClick={() => {
                                                const userMessage = messages
                                                    .slice(0, index)
                                                    .reverse()
                                                    .find(
                                                        (msgInfo) =>
                                                            msgInfo.message
                                                                .role ===
                                                            'user',
                                                    );
                                                onReload(id, {
                                                    content:
                                                        userMessage?.message
                                                            .content || '',
                                                });
                                            }}
                                        />
                                    </Tooltip>
                                ),
                            }
                            : {},
                }))}
            />
            {/* 客户端工具确认卡片：interrupt 后由用户确认，浏览器内执行并回传结果 */}
            {pendingToolCalls?.length ? (
                <Alert
                    type="warning"
                    showIcon
                    message={locale.confirmToolTitle}
                    description={pendingToolCalls
                        .map(toolCall => toolCall.name)
                        .join('、')}
                    action={
                        <Button
                            size="small"
                            type="primary"
                            onClick={handleAllowToolRun}
                        >
                            {locale.allowToolRun}
                        </Button>
                    }
                />
            ) : null}
            <Sender
                loading={isRequesting}
                value={content}
                onCancel={() => {
                    abort();
                }}
                onChange={setContent}
                placeholder={locale.placeholder}
                onSubmit={(nextContent) => {
                    onRequest({
                        content: nextContent,
                    });
                    setContent('');
                }}
            />
        </Flex>
    );
};

export default ChatAgentGraph;
