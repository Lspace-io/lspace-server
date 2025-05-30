import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import { RepositoryManager } from '../core/repositoryManager';
import { LLMService } from '../orchestrator/llmService';
import { validateRequest } from './middleware/validation';
import { KnowledgeBaseService } from '../knowledge-base/knowledgeBaseService';
import { TimelineService } from '../core/timelineService';
import { SearchService } from '../search/searchService';

/**
 * Creates and configures the knowledge base API router
 */
export function createKnowledgeBaseApi(
  repositoryManager: RepositoryManager,
  llmService: LLMService
): Router {
  const router = Router();
  // Create timeline service and knowledge base service
  const timelineService = new TimelineService();
  const searchService = new SearchService(repositoryManager);
  const knowledgeBaseService = new KnowledgeBaseService(llmService, timelineService, searchService);

  // Schema for repository ID parameter
  const repoIdParamSchema = z.object({
    repositoryId: z.string().uuid()
  });

  // Schema for topic path parameter
  const topicPathParamSchema = z.object({
    repositoryId: z.string().uuid(),
    topicPath: z.string()
  });

  // Schema for generate knowledge base request
  const generateKnowledgeBaseSchema = z.object({
    forceRegenerate: z.boolean().optional()
  });

  /**
   * Generate or update the knowledge base for a repository
   * POST /api/knowledge-base/:repositoryId/generate
   */
  router.post(
    '/:repositoryId/generate',
    validateRequest({
      params: repoIdParamSchema,
      body: generateKnowledgeBaseSchema
    }),
    async (req, res, next) => {
      try {
        const { repositoryId } = req.params;
        const { forceRegenerate } = req.body;

        const repository = repositoryManager.getRepository(repositoryId);
        
        // Check if repository implements listFiles
        if (typeof repository.listFiles !== 'function' || 
            repository.listFiles.toString().includes('throw new Error(\'Method not implemented\')')) {
          return res.status(500).json({ 
            error: 'Repository implementation error', 
            message: 'The repository does not properly implement the listFiles method' 
          });
        }
        
        const fileInfos = await repository.listFiles();

        // Filter out non-text files and ensure we only process files from the 'raw/' directory
        const rawTextFiles = fileInfos.filter(file => {
          const filePath = typeof file.path === 'string' ? file.path : '';
          const ext = path.extname(filePath).toLowerCase();
          
          return filePath.startsWith('raw/') &&
                 !filePath.endsWith('/') && // Exclude directories
                 !filePath.includes('.lspace/') && // Exclude metadata files
                 filePath !== 'raw/.gitkeep' && // Exclude .gitkeep files
                 ['.md', '.txt', '.json', '.yaml', '.yml', '.html', '.xml'].includes(ext);
        });
        
        if (rawTextFiles.length === 0) {
          return res.status(400).json({
            error: 'No suitable documents',
            message: 'No text documents found in the raw/ directory matching the allowed extensions.'
          });
        }

        // Use the KnowledgeBaseService to generate the knowledge base
        try {
          console.log(`Generating knowledge base for repository ${repositoryId} with ${rawTextFiles.length} files`);
          // Call the KnowledgeBaseService with appropriate options
          await knowledgeBaseService.OLD_generateKnowledgeBase(repository);
          
          // Create a marker file to indicate generation completed
          const markerFilePath = path.join('.lspace', 'kb_generated.marker');
          await repository.writeFile(markerFilePath, `KB generated at ${new Date().toISOString()} for ${rawTextFiles.length} files.`);
          await repository.add([markerFilePath]);
          await repository.commit({ message: 'Generate/Update knowledge base' });
          
          res.status(200).json({ 
            message: 'Knowledge base generation triggered successfully.', 
            processedFiles: rawTextFiles.length 
          });
        } catch (kbError: any) {
          console.error('Error generating knowledge base:', kbError);
          return res.status(500).json({
            error: 'Knowledge base generation failed',
            message: kbError.message || 'An error occurred during knowledge base generation'
          });
        }
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * Get the entry page for a repository's knowledge base
   * GET /api/knowledge-base/:repositoryId/entry
   */
  router.get(
    '/:repositoryId/entry',
    validateRequest({
      params: repoIdParamSchema
    }),
    async (req, res, next) => {
      try {
        const { repositoryId } = req.params;

        // Get the repository
        const repository = repositoryManager.getRepository(repositoryId);

        // Check if the entry page exists
        const entryPageExists = await repository.fileExists('knowledge-base/index.md');
        if (!entryPageExists) {
          return res.status(404).json({ error: 'Knowledge base not found' });
        }

        // Read the entry page
        const content = await repository.readFile('knowledge-base/index.md');

        res.setHeader('Content-Type', 'text/markdown');
        res.send(content);
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * Get a specific topic page from the knowledge base
   * GET /api/knowledge-base/:repositoryId/topics/:topicPath
   */
  router.get(
    '/:repositoryId/topics/:topicPath',
    validateRequest({
      params: topicPathParamSchema
    }),
    async (req, res, next) => {
      try {
        const { repositoryId, topicPath } = req.params;

        // Get the repository
        const repository = repositoryManager.getRepository(repositoryId);

        // Check if the topic page exists
        const topicPageExists = await repository.fileExists(`knowledge-base/${topicPath}.md`);
        if (!topicPageExists) {
          return res.status(404).json({ error: 'Topic not found' });
        }

        // Read the topic page
        const content = await repository.readFile(`knowledge-base/${topicPath}.md`);

        res.setHeader('Content-Type', 'text/markdown');
        res.send(content);
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * List all topics in the knowledge base
   * GET /api/knowledge-base/:repositoryId/topics
   */
  router.get(
    '/:repositoryId/topics',
    validateRequest({
      params: repoIdParamSchema
    }),
    async (req, res, next) => {
      try {
        const { repositoryId } = req.params;

        // Get the repository
        const repository = repositoryManager.getRepository(repositoryId);

        // Check if the knowledge base exists
        const knowledgeBaseExists = await repository.fileExists('knowledge-base/index.md');
        if (!knowledgeBaseExists) {
          return res.status(404).json({ error: 'Knowledge base not found' });
        }

        // List all topic files
        const files = await repository.listFiles();
        const topicFiles = files.filter(file => 
          file.path.startsWith('knowledge-base/') && 
          file.path !== 'knowledge-base/index.md' &&
          file.path.endsWith('.md')
        );

        // Extract topic information
        const topics = topicFiles.map(file => ({
          path: file.path.replace('knowledge-base/', '').replace('.md', ''),
          title: file.path.split('/').pop()?.replace('.md', '') || ''
        }));

        res.json(topics);
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
} 