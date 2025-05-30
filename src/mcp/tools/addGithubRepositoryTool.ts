import { MCPTool } from '../registerTools';
import { GitHubRepoConfig } from '../../core/repositoryManager';
import { v4 as uuidv4 } from 'uuid';

const addGithubRepositoryTool: MCPTool = {
  name: 'add_github_repository',
  description: 'Adds a new GitHub repository to Lspace for management. Requires a pre-configured PAT alias.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'A human-readable name for this repository (e.g., \"My Project Docs\"). Must be unique.',
      },
      owner: {
        type: 'string',
        description: 'The owner of the GitHub repository (username or organization).',
      },
      repo: {
        type: 'string',
        description: 'The name of the GitHub repository.',
      },
      branch: {
        type: 'string',
        description: 'The default branch to use (e.g., \"main\", \"master\").',
      },
      pat_alias: {
        type: 'string',
        description: 'The alias of the pre-configured GitHub Personal Access Token (PAT) to use for this repository. The PAT must have repo access rights.',
      },
      path_to_kb: {
        type: 'string',
        description: "Optional. A relative path within the repository to treat as the root of the knowledge base (e.g., \"docs/kb\"). Defaults to the repository root ('.').",
      },
    },
    required: ['name', 'owner', 'repo', 'branch', 'pat_alias'],
  },
  run: async (args: any, services) => {
    console.log(`[MCP add_github_repository] Called with args: ${JSON.stringify(args)}`);
    const { repositoryManager } = services;
    const { name, owner, repo, branch, pat_alias, path_to_kb } = args;

    if (!name || !owner || !repo || !branch || !pat_alias) {
      throw new Error('Missing required parameters: name, owner, repo, branch, pat_alias.');
    }

    const repoConfig: Omit<GitHubRepoConfig, 'id'> = {
      name,
      type: 'github',
      owner,
      repo,
      branch,
      pat_alias,
      path_to_kb: path_to_kb || '.', // Default to root if not provided
    };

    try {
      const newRepoId = await repositoryManager.addNewRepositoryConfig(repoConfig);
      return { 
        success: true, 
        message: `GitHub repository "${name}" added successfully with ID ${newRepoId}.`,
        repositoryId: newRepoId,
        details: repoConfig 
      };
    } catch (error: any) {
      console.error(`[MCP add_github_repository] Error: ${error.message}`, error.stack);
      // Check for specific error messages we want to relay more clearly
      if (error.message.includes('already exists') || error.message.includes('not found in credentials')) {
        throw new Error(error.message); // Rethrow specific, user-friendly errors
      }
      throw new Error(`Failed to add GitHub repository "${name}": ${error.message}`);
    }
  },
};

export default addGithubRepositoryTool; 