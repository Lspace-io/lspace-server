import { MCPTool } from '../registerTools';
import { SavedRepositoryConfig } from '../../core/repositoryManager';

const listManagedRepositoriesTool: MCPTool = {
  name: 'list_managed_repositories',
  description: 'Lists all repositories currently managed by Lspace.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  run: async (args: any, services) => {
    console.log(`[MCP list_managed_repositories] Called`);
    const { repositoryManager } = services;

    try {
      const configs: SavedRepositoryConfig[] = repositoryManager.getAllRepositoryConfigs();
      
      // We might want to sanitize or select specific fields for the LLM
      const llmFriendlyConfigs = configs.map(conf => ({
        id: conf.id,
        name: conf.name,
        type: conf.type,
        ...(conf.type === 'local' && conf.path && { path: conf.path }),
        ...(conf.type === 'github' && conf.owner && { owner: conf.owner }),
        ...(conf.type === 'github' && conf.repo && { repo: conf.repo }),
        ...(conf.type === 'github' && conf.branch && { branch: conf.branch }),
        ...(conf.type === 'github' && conf.pat_alias && { pat_alias: conf.pat_alias }),
        ...(conf.path_to_kb && { path_to_kb: conf.path_to_kb }), // Include if present
      }));

      return { repositories: llmFriendlyConfigs };
    } catch (error: any) {
      console.error(`[MCP list_managed_repositories] Error: ${error.message}`, error.stack);
      throw new Error(`Failed to list managed repositories: ${error.message}`);
    }
  },
};

export default listManagedRepositoriesTool; 