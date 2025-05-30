import { MCPTool } from '../registerTools';
import { RepositoryManager, SavedRepositoryConfig, LocalRepoConfig, GitHubRepoConfig } from '../../core/repositoryManager';

const getRepositoryDetailsTool: MCPTool = {
  name: 'get_repository_details',
  description: 'Retrieves detailed configuration information for a specific repository by its name.',
  parameters: {
    type: 'object',
    properties: {
      repositoryName: {
        type: 'string',
        description: 'The unique name of the repository.',
      },
    },
    required: ['repositoryName'],
  },
  run: async (args: { repositoryName: string }, services) => {
    const { repositoryManager } = services;
    const { repositoryName } = args;

    if (!repositoryName) {
      throw new Error('Missing required parameter: repositoryName');
    }

    const repoConfig = await repositoryManager.findRepositoryConfigByName(repositoryName);

    if (!repoConfig) {
      return {
        found: false,
        message: `Repository with name "${repositoryName}" not found.`
      };
    }

    // Base details common to all types (from BaseRepoConfig)
    const baseDetails = {
      id: repoConfig.id,
      name: repoConfig.name,
      type: repoConfig.type,
      path_to_kb: repoConfig.path_to_kb,
      found: true,
    };

    if (repoConfig.type === 'local') {
      // repoConfig is now narrowed to LocalRepoConfig
      return {
        ...baseDetails,
        path: repoConfig.path,
      };
    } else if (repoConfig.type === 'github') {
      // repoConfig is now narrowed to GitHubRepoConfig
      return {
        ...baseDetails,
        owner: repoConfig.owner,
        repo: repoConfig.repo,
        branch: repoConfig.branch,
        pat_alias: repoConfig.pat_alias,
      };
    } else {
      console.warn(`[MCP get_repository_details] Encountered unknown repository type for "${repositoryName}": ${(repoConfig as any).type}`);
      return { ...baseDetails, message: "Repository found, but with an unknown type." };
    }
  },
};

export default getRepositoryDetailsTool; 