import express from 'express';
import { RepositoryManager, SavedRepositoryConfig, GitHubRepoConfig } from '../core/repositoryManager';
import { LocalGitAdapter } from '../adapters/localGitAdapter';
import { GitHubAdapter } from '../adapters/githubAdapter';
import { FileSystemToolImpl } from '../core/fileSystemToolImpl';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

/**
 * Set up repository API routes
 * @param app Express application
 * @param repositoryManager Repository manager instance
 */
export function setupRepositoryRoutes(app: express.Application, repositoryManager: RepositoryManager): void {
  /**
   * GET /api/repositories - List all repositories
   */
  app.get('/api/repositories', async (req, res) => {
    try {
      const repositories = repositoryManager.listRepositories();
      res.json(repositories);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/repositories/:id - Get repository by ID
   */
  app.get('/api/repositories/:id', async (req, res) => {
    try {
      // Get the repository info
      const repoInfo = repositoryManager.getRepositoryInfo(req.params.id);
      if (!repoInfo) {
        return res.status(404).json({ error: 'Repository not found' });
      }
      
      // Verify that the repository exists
      try {
        repositoryManager.getRepository(req.params.id);
      } catch (error) {
        return res.status(404).json({ error: 'Repository not found' });
      }
      
      res.json(repoInfo);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/repositories - Register a new repository
   */
  app.post('/api/repositories', async (req, res) => {
    try {
      // Validate the request body
      const baseRepoSchema = z.object({
        name: z.string().min(1),
        id: z.string().uuid().optional(), // Allow client to suggest ID, or generate later
      });

      const localRepoSchema = baseRepoSchema.extend({
        type: z.literal('local'),
        path: z.string().min(1),
      });

      const githubRepoSchema = baseRepoSchema.extend({
        type: z.literal('github'),
        owner: z.string().min(1),
        repo: z.string().min(1),
        branch: z.string().optional(),
        pat_alias: z.string().min(1),
      });

      const repoSchema = z.discriminatedUnion("type", [
        localRepoSchema,
        githubRepoSchema,
      ]);
      
      const validation = repoSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.format() });
      }
      
      const repoData = validation.data;
      let id: string;
      let finalRepoInfo;
      
      if (repoData.type === 'local') {
        const adapter = new LocalGitAdapter();
        const repository = await adapter.initialize(repoData.path);
        
        const actualId = repoData.id || uuidv4();
        const savedConfig = { ...repoData, id: actualId }; 
        id = await repositoryManager.registerRepository(repoData.name, repository, repoData.type, savedConfig);
        finalRepoInfo = repositoryManager.getRepositoryInfo(id);

      } else if (repoData.type === 'github') {
        const pat = repositoryManager.getPATByAlias(repoData.pat_alias);
        if (!pat) {
          return res.status(400).json({ error: `PAT not found for alias: ${repoData.pat_alias}` });
        }

        const adapter = new GitHubAdapter();
        const actualId = repoData.id || uuidv4();
        // Ensure the object passed to initialize and registerRepository has a non-optional id
        // and a default branch if not provided.
        const githubRepoConfigForAdapter: GitHubRepoConfig = { 
          ...repoData, 
          id: actualId,
          branch: repoData.branch || 'main', // Default to 'main' if branch is not provided
          // Ensure all other required fields for GitHubRepoConfig are present from repoData
          // (owner, repo, pat_alias, type must be 'github')
          // We assume repoData is validated to have these for type: 'github'
        } as GitHubRepoConfig; // Explicit cast after ensuring properties

        // Type assertion might be needed if repoData is not strictly typed enough initially
        // For example, if repoData.type is not already confirmed to be 'github'
        if (githubRepoConfigForAdapter.type !== 'github') {
          return res.status(400).json({ error: 'Invalid repoData: type must be github.'});
        }

        const repository = await adapter.initialize(githubRepoConfigForAdapter, pat);
        
        // registerRepository expects SavedRepositoryConfig, which githubRepoConfigForAdapter matches now
        id = await repositoryManager.registerRepository(repoData.name, repository, repoData.type, githubRepoConfigForAdapter);
        finalRepoInfo = repositoryManager.getRepositoryInfo(id);
        
      } else {
        // Should not happen due to discriminated union, but as a safeguard:
        return res.status(400).json({ error: `Unsupported repository type: ${(repoData as any).type}` });
      }
      
      // Save the configuration to persist the repository
      await repositoryManager.saveConfiguration();
        
      res.status(201).json(finalRepoInfo);

    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/repositories/:id - Unregister a repository
   */
  app.delete('/api/repositories/:id', async (req, res) => {
    try {
      repositoryManager.unregisterRepository(req.params.id);
      res.status(204).end();
    } catch (error: any) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Repository not found' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/repositories/:id/files - List files in a repository
   */
  app.get('/api/repositories/:id/files', async (req, res) => {
    try {
      const repository = repositoryManager.getRepository(req.params.id);
      const fileSystemTool = new FileSystemToolImpl(repository);
      // Get file tree from the repository root
      const result = await fileSystemTool.getFileTree('.'); 
      
      if (result.success && result.tree) {
        // result.tree is the FileNode for the root itself.
        // Its children are the files/folders directly inside the root.
        res.json(result.tree.children || []); 
      } else if (result.success && !result.tree) {
        // This case can happen if the root directory itself is somehow problematic (e.g. not accessible, though unlikely for root)
        res.json([]); // Send empty array
      } else {
        res.status(500).json({ error: result.error || 'Failed to get file tree for repository root' });
      }
    } catch (error: any) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Repository not found' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/repositories/:id/readme - Read the README.md file from the repository root
   */
  app.get('/api/repositories/:id/readme', async (req, res) => {
    try {
      const repository = repositoryManager.getRepository(req.params.id);
      const readmePath = 'README.md';

      if (!await repository.fileExists(readmePath)) {
        return res.status(404).json({ error: 'README.md not found in repository root' });
      }
      
      const content = await repository.readFile(readmePath);
      res.setHeader('Content-Type', 'text/markdown');
      res.send(content);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        // This check is more specific if getRepository itself fails
        return res.status(404).json({ error: 'Repository not found' }); 
      }
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/repositories/:id/files/:path(*) - Read a file from a repository
   */
  app.get('/api/repositories/:id/files/:path(*)', async (req, res) => {
    try {
      const requestedPath = req.params.path;

      // Security check: Prevent access to .lspace directory
      if (requestedPath.startsWith('.lspace/') || requestedPath === '.lspace') {
        return res.status(403).json({ error: 'Access to the .lspace directory is forbidden.' });
      }

      const repository = repositoryManager.getRepository(req.params.id);
      
      // Check if the file exists
      const fileExists = await repository.fileExists(requestedPath);
      if (!fileExists) {
        return res.status(404).json({ error: 'File not found' });
      }
      
      // Read the file
      const content = await repository.readFile(requestedPath);
      
      // Determine content type based on file extension
      // This is a simple implementation - in a real app, you would use a more comprehensive approach
      const extension = requestedPath.split('.').pop()?.toLowerCase();
      
      // Set appropriate content type
      if (extension === 'json') {
        res.setHeader('Content-Type', 'application/json');
      } else if (extension === 'md') {
        res.setHeader('Content-Type', 'text/markdown');
      } else if (extension === 'html' || extension === 'htm') {
        res.setHeader('Content-Type', 'text/html');
      } else if (extension === 'css') {
        res.setHeader('Content-Type', 'text/css');
      } else if (extension === 'js') {
        res.setHeader('Content-Type', 'application/javascript');
      } else {
        res.setHeader('Content-Type', 'text/plain');
      }
      
      res.send(content);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        if (error.message.includes('Repository')) {
          return res.status(404).json({ error: 'Repository not found' });
        } else {
          return res.status(404).json({ error: 'File not found' });
        }
      }
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/repositories/:id/kb-regenerate - Trigger knowledge base regeneration (Placeholder)
   */
  app.post('/api/repositories/:id/kb-regenerate', async (req, res) => {
    try {
      const repositoryId = req.params.id;
      // Ensure repository exists
      repositoryManager.getRepository(repositoryId); 

      // TODO: Implement actual call to an orchestrator service method
      // Example: await orchestratorService.regenerateKnowledgeBase(repositoryId);
      console.log(`Placeholder: Knowledge base regeneration triggered for repository ${repositoryId}`);
      
      res.status(202).json({ message: `Knowledge base regeneration initiated for repository ${repositoryId}.` });
    } catch (error: any) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Repository not found' });
      }
      res.status(500).json({ error: error.message });
    }
  });
}