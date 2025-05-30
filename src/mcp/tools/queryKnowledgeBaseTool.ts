import { MCPTool } from '../registerTools';

const queryKnowledgeBaseTool: MCPTool = {
  name: 'query_lspace_knowledge_base',
  description: 'Queries the knowledge base of a specified Lspace repository using an LLM.',
  parameters: {
    type: 'object',
    properties: {
      repositoryId: {
        type: 'string',
        description: 'The ID of the Lspace repository to query.',
      },
      queryText: {
        type: 'string',
        description: 'The natural language query to ask the knowledge base.',
      },
    },
    required: ['repositoryId', 'queryText'],
  },
  run: async (args: { repositoryId: string; queryText: string }, services) => {
    console.log(`[MCP query_lspace_knowledge_base] Called with args: ${JSON.stringify(args)}`);
    const { repositoryManager, llmService } = services;
    const { repositoryId, queryText } = args;

    if (!repositoryId || !queryText) {
      throw new Error('Missing required parameters: repositoryId and queryText.');
    }

    try {
      const repository = repositoryManager.getRepository(repositoryId);
      // The LLMService.queryKnowledgeBase method is expected to handle context gathering and LLM call.
      const result = await llmService.queryKnowledgeBase(repository, queryText);
      return result; // Expected to be { answer: string, sources: string[] }
    } catch (error: any) {
      console.error(`[MCP query_lspace_knowledge_base] Error: ${error.message}`, error.stack);
      throw new Error(`Failed to query Lspace knowledge base: ${error.message}`);
    }
  },
};

export default queryKnowledgeBaseTool; 