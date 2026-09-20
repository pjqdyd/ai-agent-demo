### AI-Agent-Demo AI智能体案例项目

<div align="center" 
     style="
        width: 100%; 
        height: 50px; 
        display: flex; 
        flex-direction:column; 
        justify-content: center; 
        align-items: center;">
            <h1 style="display: inline-block; font-size: 20px; line-height: 20px; font-weight: bold;">
                <b>ai-agent-demo</b>
            </h1>
</div>

<p align="middle">
    <a href="https://github.com/pjqdyd/AI-Agent-Demo" target="_blank">
        <img src="https://badgen.net/badge/version/v1.0.0"/>
    </a>
    <img src="https://badgen.net/badge/language/antdx/cyan"/>
    <img src="https://badgen.net/badge/language/langchain/blue"/>
    <img src="https://badgen.net/badge/package/langgraph/cyan"/>
    <img src="https://badgen.net/badge/license/monorepo/green"/>
    <img src="https://badgen.net/badge/contributors/1/blue"/>
</p>

#### 项目实现:

> 1. Ollama 本地部署模型
> 2. WebChat 功能实现
> 3. LangChain: Prompt、RAG、Tools 实现
> 4. LangGraph: 简单ReAct实现，循环调用
> 5. MCP功能实现：[MCP-TS-DEMO](https://github.com/pjqdyd/mcp-ts-demo)
> 6. AI 全栈工程化

#### 技术选型：
 - 环境：Node18+、TypeScript
 - 构建工具：pnpm、monorepo、turbo、changeset
 - 前端框架：Umi、React18、AntD
 - 后端框架：Midway.js、Egg.js、TypeORM、MySql、Zod
 - Agent SDK: LangChain.JS、LangGraph.JS
 - WebChat组件: AntDesignX、X-SDK

#### 项目目录:

```
 ├─apps                 apps项目
    ├─web-chat-demo     webchat项目
    └─langchain-ts-demo langchain agent项目     
 ├─packages             子包目录
    ├─types             ts类型定义
    └─utils             工具类   
 ├─package.json         package配置
 ├─tsconfig.json        ts配置文件
 ├─turbo.json           构建配置文件
 ├─pnpm-workspace.yaml  monorepo配置文件
 ├─README.md            README.md文件
 └─.gitignore           .gitignore文件             
```
#### 如何运行：

 - 本地启动Ollama：例如`ollama run qwen3.5:0.8b`
 - 通过交互式CLI命令行访问
 - 通过配置web项目的BASE_URL: `http://localhost:11434/v1/chat/completions`接入访问
 - 进入web-chat-demo项目：运行`pnpm run dev`启动应用，访问页面/chat-sdk

 - 如果要启动langchain-ts-demo项目，请查看对应目录下的README.md文件
 - 前置依赖环境
```nomic-embed-text
   node18
   ollama run qwen3.5:2b
   ollama pull nomic-embed-text
   mysql数据库database: ai-agent-demo
```

#### 构建发布：
```
 pnpm changeset # 交互式写 changeset（生成 .changeset/*.md）
 pnpm version   # 消费 changeset，更新 package.json version + CHANGELOG.md 
 
 pnpm build     # turbo 调度构建所有包
 pnpm build --filter=@pjqdyd/utils-ai-demo # 或仅构建 utils
 
 # 进入 utils 目录，检测要发布的内容
 cd packages/utils
 pnpm pack --pack-destination ../    # 执行后会生成一个.tgz文件， 将要上传到npm的那份产物
 pnpm pack --dry-run                 # 查看打包输出的产物
 
 cd packages/utils 
 # 方式 A：通过 changesets（推荐，自动跳过未变 version 的包 + 打 git tag） 
 pnpm release  # 发布有版本变化的包到 npm（需先 npm login）
 
 # 方式 B：手动发布
 npm publish --access restricted --registry=https://registry.npmjs.org/
 ```

#### 总结
 
 TS AI Agent 相关技术、AI全栈工程化

