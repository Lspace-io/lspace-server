import express, { Request, Response, NextFunction } from 'express';
import { RepositoryManager } from '../core/repositoryManager';
import { TimelineService } from '../core/timelineService';
import { TimelineFilterOptions } from '../core/timelineService'; // Import this if not already

export const createHistoryRoutes = (repositoryManager: RepositoryManager, timelineService: TimelineService) => {
  const router = express.Router();

  // Middleware to get repository instance
  const getRepositoryInstance = (req: Request, res: Response, next: NextFunction) => {
    const { repoId } = req.params;
    if (!repoId) {
      return res.status(400).json({ message: 'Repository ID is required' });
    }
    try {
      const repo = repositoryManager.getRepository(repoId);
      // Attach repo to request object for use in route handlers
      (req as any).repository = repo;
      next();
    } catch (error: any) {
      if (error.message.includes('Repository not found')) {
        return res.status(404).json({ message: `Repository with ID "${repoId}" not found.` });
      }
      console.error(`Error retrieving repository ${repoId}:`, error);
      return res.status(500).json({ message: 'Failed to retrieve repository information' });
    }
  };

  /**
   * GET /api/v1/history/:repoId
   * Retrieves the detailed history for a given repository ID.
   * Query parameters can be used for filtering (e.g., limit, offset, operation, etc.)
   * based on TimelineFilterOptions.
   */
  router.get('/:repoId', getRepositoryInstance, async (req: Request, res: Response) => {
    const repository = (req as any).repository;

    // Extract filter options from query parameters
    const { limit, offset, operation, user, category, tag, path, startDate, endDate } = req.query;
    const filterOptions: TimelineFilterOptions = {};

    if (limit) filterOptions.limit = parseInt(limit as string, 10);
    if (offset) filterOptions.offset = parseInt(offset as string, 10);
    if (operation) filterOptions.operation = operation as TimelineFilterOptions['operation'];
    if (user) filterOptions.user = user as string;
    if (category) filterOptions.category = category as string;
    if (tag) filterOptions.tag = tag as string;
    if (path) filterOptions.path = path as string;
    if (startDate) filterOptions.startDate = startDate as string;
    if (endDate) filterOptions.endDate = endDate as string;

    try {
      const detailedHistory = await timelineService.getDetailedHistoryEntries(repository, filterOptions);
      // The frontend expects `operation` not `operationType` or `fileOperation` directly for the badge.
      // Let's map this for compatibility. We prioritize fileOperation if available.
      const responseHistory = detailedHistory.map(entry => ({
        ...entry,
        operation: entry.fileOperation || entry.operationType, // For display consistency with old dummy data
        title: entry.title || (entry.path ? require('path').basename(entry.path) : 'Unknown File')
      }));
      res.json(responseHistory);
    } catch (error) {
      console.error('Error fetching detailed history:', error);
      res.status(500).json({ message: 'Failed to fetch detailed history' });
    }
  });

  return router;
}; 