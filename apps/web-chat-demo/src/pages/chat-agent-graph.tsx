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
import { Button, Flex, Timeline, Tooltip } from 'antd';

/**
 * langgraph-ts-demo 流式问答接口（umi dev server 通过 proxy 转发到后端 6002 端口）
 */
const CHAT_STREAM_URL = '/api/graph/chat/stream';

/**
 * 后端 SSE 事件的数据结构（与 langgraph-ts-demo src/interface.ts 的 GraphStreamData 对齐）
 * 相比 langchain-ts-demo 新增 step 事件：上报 Graph 每个节点的执行进度
 */
interface GraphStreamData {
    /** 消息类型：step 为节点执行进度，chunk 为增量内容，done 为结束标记，error 为错误 */
    type: 'step' | 'chunk' | 'done' | 'error';
    /** 所属会话线程 ID（langgraph checkpointer 的 thread_id） */
    threadId: number;
    /** 节点标识（type=step 时有值） */
    node?: string;
    /** 节点中文名（type=step 时有值） */
    label?: string;
    /** 节点执行摘要（type=step 时有值：意图、工具名、检索片段数等） */
    detail?: string;
    /** 增量文本内容（type=chunk 时有值） */
    content?: string;
    /** 错误信息（type=error 时有值） */
    message?: string;
}

/** 发送给后端的请求参数（sessionId 可选：首次对话由后端生成线程 ID） */
interface GraphRequestParams {
    sessionId?: number;
    content: string;
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

/** 聊天消息结构：在文本基础上附带 Graph 执行步骤 */
interface GraphChatMessage {
    role: 'user' | 'assistant';
    content: string;
    /** assistant 消息的节点执行步骤（按执行顺序累积） */
    steps: GraphStepItem[];
}

// 本地化钩子：根据当前语言环境返回对应的文本
const useLocale = () => {
    const isCN = true;
    return {
        abort: isCN ? '中止' : 'abort',
        placeholder: isCN
            ? '请输入内容，按下 Enter 发送消息（试试：公司年假有几天？ / 计算 (12 + 8) * 3）'
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

    // 转换请求参数：组装后端需要的 { sessionId?, content }
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
            content: requestParams?.content || '',
        };
    }

    // 用户发送的内容转换为本地渲染消息
    transformLocalMessage(
        requestParams: Partial<GraphRequestParams>,
    ): GraphChatMessage {
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
            };
        }
        let content = originMessage?.content || '';
        const steps = [...(originMessage?.steps || [])];
        try {
            const data: GraphStreamData = JSON.parse(chunk.data);
            if (data.type === 'step') {
                // 节点执行完成：追加执行步骤，供 Timeline 展示
                steps.push({
                    node: data.node || '',
                    label: data.label || data.node || '',
                    detail: data.detail || '',
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
            {/* 双 '\n' 在markdown中会被解析为新段落，因此需要替换为单个 '\n' */}
            <XMarkdown content={content.replace(/\n\n/g, '<br/><br/>')} />
        </Flex>
    );
}

const ChatAgentGraph = () => {
    const [content, setContent] = React.useState('');
    // 会话线程 ID：首次请求由后端生成，随 SSE 事件返回后记录
    const sessionIdRef = React.useRef<number | undefined>(undefined);
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
