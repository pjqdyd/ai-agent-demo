import { Provide, Scope, ScopeEnum, Config } from '@midwayjs/core';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { OllamaEmbeddings } from '@langchain/ollama';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { Document } from '@langchain/core/documents';
import type { OllamaConfig } from '../../interface';
import { SAMPLE_DOCUMENTS } from './sampleDocuments';

/**
 * RAG 服务：文档分割、向量化（OllamaEmbeddings）与相似度检索
 * 使用 MemoryVectorStore 内存向量库，服务重启后需重新入库
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class RagService {
  @Config('ollama')
  ollamaConfig: OllamaConfig;

  /** 向量库惰性初始化 Promise：应用启动时不强依赖 Ollama 服务在线 */
  private vectorStorePromise: Promise<MemoryVectorStore> | null = null;

  /** 示例文档种子 Promise：避免并发触发时重复入库 */
  private seedPromise: Promise<void> | null = null;

  /**
   * 惰性初始化内存向量库
   */
  private async getVectorStore(): Promise<MemoryVectorStore> {
    if (!this.vectorStorePromise) {
      const embeddings = new OllamaEmbeddings({
        model: this.ollamaConfig.embeddingModel,
        baseUrl: this.ollamaConfig.baseUrl,
      });
      this.vectorStorePromise = Promise.resolve(
        new MemoryVectorStore(embeddings)
      );
    }
    return this.vectorStorePromise;
  }

  /**
   * 首次检索前自动写入示例知识文档，保证 demo 开箱可用
   * 若 Ollama 服务不可用，seedPromise 会被置为失败状态，重启服务后才会重试
   */
  async ensureSeeded(): Promise<void> {
    if (!this.seedPromise) {
      this.seedPromise = (async () => {
        for (const document of SAMPLE_DOCUMENTS) {
          await this.ingest(document.title, document.content);
        }
      })();
    }
    await this.seedPromise;
  }

  /**
   * 文档入库：分割为片段，向量化后存入内存向量库，返回片段数量
   */
  async ingest(title: string, content: string): Promise<number> {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 500,
      chunkOverlap: 50,
    });
    const documents = await splitter.createDocuments([content], [{ title }]);
    const vectorStore = await this.getVectorStore();
    await vectorStore.addDocuments(documents);
    return documents.length;
  }

  /**
   * 相似度检索：返回与 query 最相关的 topK 个文档片段
   */
  async search(query: string, topK = 3): Promise<Document[]> {
    await this.ensureSeeded();
    const vectorStore = await this.getVectorStore();
    return vectorStore.similaritySearch(query, topK);
  }
}
