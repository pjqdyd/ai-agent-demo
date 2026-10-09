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
import { Button, Flex, Tooltip } from 'antd';

/**
 * langchain-ts-demo 流式问答接口（umi dev server 通过 proxy 转发到后端 6001 端口）
 */
const CHAT_STREAM_URL = '/api/chat/stream';

/**
 * 后端 SSE 事件的数据结构（与 langchain-ts-demo src/interface.ts 的 ChatStreamData 对齐）
 */
interface ChatStreamData {
    /** 消息类型：chunk 为增量内容，done 为结束标记，error 为错误 */
    type: 'chunk' | 'done' | 'error';
    /** 所属会话 ID */
    sessionId: number;
    /** 增量文本内容（type=chunk 时有值） */
    content?: string;
    /** 错误信息（type=error 时有值） */
    message?: string;
}

/** 发送给后端的请求参数（sessionId 可选：首次对话由后端创建会话） */
interface AgentRequestParams {
    sessionId?: number;
    content: string;
}

/** 聊天消息结构：用于 useXChat 的消息管理与渲染 */
interface AgentChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

// 本地化钩子：根据当前语言环境返回对应的文本
const useLocale = () => {
    const isCN = true;
    return {
        abort: isCN ? '中止' : 'abort',
        placeholder: isCN
            ? '请输入内容，按下 Enter 发送消息'
            : 'Please enter content and press Enter to send message',
        waiting: isCN ? '请稍候...' : 'Please wait...',
        requestFailed: isCN ? '请求失败，请重试！' : 'Request failed, please try again!',
        requestAborted: isCN ? '请求已中止' : 'Request is aborted',
        noMessages: isCN
            ? '暂无消息，请输入问题并发送'
            : 'No messages yet, please enter a question and send',
        requesting: isCN ? '请求中' : 'Requesting',
        qaCompleted: isCN ? '问答完成' : 'Q&A completed',
        retry: isCN ? '重试' : 'Retry',
        currentStatus: isCN ? '当前状态：' : 'Current status:',
    };
};

/**
 * Agent 聊天 Provider：对接 langchain-ts-demo 的自定义 SSE 协议
 * 与 OpenAIChatProvider 不同：后端 SSE 的 data 为 JSON 字符串，
 * 需要自行解析并通过 type 字段区分增量内容 / 结束 / 错误
 */
class AgentChatProvider extends AbstractChatProvider<
    AgentChatMessage,
    AgentRequestParams,
    SSEOutput
> {
    // 会话 ID 引用：首次请求由后端创建，后续请求携带以保持多轮上下文
    private readonly sessionIdRef: React.MutableRefObject<number | undefined>;

    constructor(
        config: ChatProviderConfig<
            AgentRequestParams,
            SSEOutput,
            AgentChatMessage
        >,
        sessionIdRef: React.MutableRefObject<number | undefined>,
    ) {
        super(config);
        this.sessionIdRef = sessionIdRef;
    }

    // 转换请求参数：组装后端需要的 { sessionId?, content }
    transformParams(
        requestParams: Partial<AgentRequestParams>,
        options: XRequestOptions<AgentRequestParams, SSEOutput, AgentChatMessage>,
    ): AgentRequestParams {
        return {
            ...(options?.params || {}),
            // 首次对话无 sessionId，由后端创建会话后随 SSE chunk 返回
            ...(this.sessionIdRef.current !== undefined
                ? { sessionId: this.sessionIdRef.current }
                : {}),
            content: requestParams?.content || '',
        };
    }

    // 用户发送的内容转换为本地渲染消息
    transformLocalMessage(
        requestParams: Partial<AgentRequestParams>,
    ): AgentChatMessage {
        return {
            role: 'user',
            content: requestParams?.content || '',
        };
    }

    // 解析 SSE chunk：累积 assistant 回答内容并记录会话 ID
    transformMessage(
        info: TransformMessage<AgentChatMessage, SSEOutput>,
    ): AgentChatMessage {
        const { originMessage, chunk } = info;
        // 请求成功收尾时会以 chunk=undefined 触发一次，直接沿用已有内容
        if (!chunk) {
            return { role: 'assistant', content: originMessage?.content || '' };
        }
        let content = originMessage?.content || '';
        try {
            const data: ChatStreamData = JSON.parse(chunk.data);
            if (data.type === 'chunk') {
                // 记录后端返回的会话 ID，实现多轮对话
                this.sessionIdRef.current = data.sessionId;
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
        };
    }
}

// 消息角色配置：定义助手和用户消息的布局和渲染方式
const role: BubbleListProps['role'] = {
    assistant: {
        placement: 'start',
        contentRender(content: string) {
            // marked 默认把单个 '\n' 当软换行折叠为空格，开启 breaks 让其渲染为 <br>，
            // 同时保留列表、标题等块级语法的正常解析（此前 replace '<br/>' 会破坏列表行首标记）
            return <XMarkdown config={{ breaks: true }} content={content} />;
        },
    },
    user: {
        placement: 'end',
    },
};

const ChatAgent = () => {
    const [content, setContent] = React.useState('');
    // 会话 ID：首次请求由后端创建，随 SSE chunk 返回后记录
    const sessionIdRef = React.useRef<number | undefined>(undefined);
    const locale = useLocale();

    // 自定义 Provider：对接 langchain-ts-demo 的 SSE 协议
    // 显式声明 Content-Type，否则后端 egg body-parser 无法解析 JSON 请求体
    const [provider] = React.useState(() => {
        return new AgentChatProvider(
            {
                request: XRequest<AgentRequestParams, SSEOutput, AgentChatMessage>(
                    CHAT_STREAM_URL,
                    {
                        manual: true,
                        headers: {
                            'Content-Type': 'application/json',
                        },
                    },
                ),
            },
            sessionIdRef,
        );
    });

    // 聊天消息管理：处理消息列表、请求占位、失败回退等
    const { onRequest, messages, isRequesting, abort, onReload } = useXChat<
        AgentChatMessage,
        AgentChatMessage,
        AgentRequestParams,
        SSEOutput
    >({
        provider,
        requestFallback: (_, { error, messageInfo }) => {
            // 请求失败回退：区分中止错误和其他错误
            if (error.name === 'AbortError') {
                return {
                    content: messageInfo?.message?.content || locale.requestAborted,
                    role: 'assistant',
                };
            }
            return {
                content: error.message || locale.requestFailed,
                role: 'assistant',
            };
        },
        requestPlaceholder: () => {
            // 请求占位符：在等待响应时显示等待消息
            return {
                content: locale.waiting,
                role: 'assistant',
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

            {/* 消息列表：展示对话内容，助手消息支持 Markdown 与重试 */}
            <Bubble.List
                style={{ height: 500 }}
                role={role}
                items={messages.map(({ id, message, status }, index) => ({
                    key: id,
                    role: message.role,
                    status: status,
                    loading: status === 'loading',
                    content: message.content,
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
                                                            msgInfo.message.role === 'user',
                                                    );
                                                onReload(id, {
                                                    content:
                                                        userMessage?.message.content || '',
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

export default ChatAgent;
