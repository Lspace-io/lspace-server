import { Router } from 'express';
import { z } from 'zod';
import { RepositoryManager } from '../core/repositoryManager';
import { TimelineService, OperationType } from '../core/timelineService';
import { validateRequest } from './middleware/validation';

/**
 * Creates and configures the timeline API router
 */
export function createTimelineApi(repositoryManager: RepositoryManager): Router {
  const router = Router();
  const timelineService = new TimelineService();
  
  // Schema for repository ID parameter
  const repoIdParamSchema = z.object({
    id: z.string().uuid()
  });
  
  // Schema for timeline entry ID parameter
  const entryIdParamSchema = z.object({
    id: z.string().uuid(),
    entryId: z.string().uuid()
  });
  
  // Schema for timeline query parameters
  const timelineQuerySchema = z.object({
    operation: z.enum(['add', 'update', 'delete', 'move', 'organize', 'prune'] as [OperationType, ...OperationType[]]).optional(),
    user: z.string().optional(),
    category: z.string().optional(),
    tag: z.string().optional(),
    path: z.string().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    limit: z.coerce.number().min(1).max(100).default(20).optional(),
    offset: z.coerce.number().min(0).default(0).optional()
  });
  
  /**
   * Get timeline entries for a repository
   * GET /api/repositories/:id/timeline
   */
  router.get(
    '/repositories/:id/timeline',
    validateRequest({
      params: repoIdParamSchema,
      query: timelineQuerySchema
    }),
    async (req, res, next) => {
      try {
        const { id } = req.params;
        
        // Get the repository
        const repoInfo = repositoryManager.getRepository(id);
        if (!repoInfo) {
          return res.status(404).json({ error: 'Repository not found' });
        }
        
        // Get timeline entries
        const timelinePage = await timelineService.getEntries(
          repoInfo,
          req.query as any
        );
        
        // Add URLs to each entry
        const entriesWithUrls = timelinePage.entries.map(entry => ({
          ...entry,
          url: `/api/repositories/${id}/files/${entry.path}`
        }));
        
        res.json({
          ...timelinePage,
          entries: entriesWithUrls
        });
      } catch (error) {
        next(error);
      }
    }
  );
  
  /**
   * Get a specific timeline entry
   * GET /api/repositories/:id/timeline/:entryId
   */
  router.get(
    '/repositories/:id/timeline/:entryId',
    validateRequest({
      params: entryIdParamSchema
    }),
    async (req, res, next) => {
      try {
        const { id, entryId } = req.params;
        
        // Get the repository
        const repoInfo = repositoryManager.getRepository(id);
        if (!repoInfo) {
          return res.status(404).json({ error: 'Repository not found' });
        }
        
        // Get the timeline entry
        const entry = await timelineService.getEntry(repoInfo, entryId);
        if (!entry) {
          return res.status(404).json({ error: 'Timeline entry not found' });
        }
        
        // Add URL to the entry
        const entryWithUrl = {
          ...entry,
          url: `/api/repositories/${id}/files/${entry.path}`
        };
        
        res.json(entryWithUrl);
      } catch (error) {
        next(error);
      }
    }
  );
  
  return router;
}

/**
 * Set up timeline routes
 */
export function setupTimelineRoutes(app: any, repositoryManager: RepositoryManager): void {
  const timelineRouter = createTimelineApi(repositoryManager);
  app.use('/api', timelineRouter);
}