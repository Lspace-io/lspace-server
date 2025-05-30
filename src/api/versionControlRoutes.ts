import express, { Request, Response, Router } from 'express';
import { RepositoryManager } from '../core/repositoryManager';
import { Repository } from '../core/repository';
import { TimelineService } from '../core/timelineService';

export function createVersionControlRoutes(repositoryManager: RepositoryManager): Router {
  const router: Router = express.Router();
  const timelineService = new TimelineService();

  // POST /api/v1/repositories/:repoId/commits/:commitSha/rollback-hard
  router.post('/:repoId/commits/:commitSha/rollback-hard', async (req: Request, res: Response) => {
    const { repoId, commitSha } = req.params;

    if (!repoId || !commitSha) {
      return res.status(400).json({ error: 'Repository ID and Commit SHA are required.' });
    }

    try {
      const repository = repositoryManager.getRepository(repoId);
      if (!repository) {
        return res.status(404).json({ error: `Repository with ID '${repoId}' not found.` });
      }

      console.log(`[API] Received request to roll back repo ${repoId} to commit ${commitSha}`);
      await repository.rollbackToCommit(commitSha);
      
      res.status(200).json({ 
        message: `Repository ${repoId} successfully rolled back to commit ${commitSha}.`,
        repoId: repoId,
        commitSha: commitSha 
      });

    } catch (error: any) {
      console.error(`[API] Error during rollback for repo ${repoId} to commit ${commitSha}:`, error);
      // Check if the error is due to repository not found from the manager itself
      if (error.message && error.message.toLowerCase().includes('not found')) {
        return res.status(404).json({ error: error.message });
      }
      // Check for specific error from repository.rollbackToCommit
      if (error.message && error.message.startsWith('Failed to rollback')) {
        return res.status(500).json({ error: error.message, details: error.cause || 'Check service logs for more details.'});
      }
      res.status(500).json({ error: 'Failed to process rollback request.', details: error.message });
    }
  });

  // POST /api/v1/repositories/:repoId/rollback/revert-file-and-kb
  router.post('/:repoId/rollback/revert-file-and-kb', async (req: Request, res: Response) => {
    const { repoId } = req.params;
    const { sourceFilePath } = req.body;

    if (!sourceFilePath) {
      return res.status(400).json({ error: 'sourceFilePath is required in the request body.' });
    }

    try {
      const repository = repositoryManager.getRepository(repoId);
      if (!repository) {
        return res.status(404).json({ error: `Repository with ID '${repoId}' not found.` });
      }

      const uploadCommitSha = await timelineService.findFileUploadCommit(repository, sourceFilePath);
      if (!uploadCommitSha) {
        return res.status(404).json({ error: `Could not find upload commit for file: ${sourceFilePath}` });
      }

      const targetSha = await repository.findCommitBeforeFileUpload(uploadCommitSha);
      if (!targetSha) {
        return res.status(404).json({ error: `Could not find commit before file upload of ${sourceFilePath} (upload commit: ${uploadCommitSha}). It might be the initial commit.` });
      }

      console.log(`[API] Rolling back repo ${repoId} to state before upload of ${sourceFilePath} (target commit: ${targetSha})`);
      await repository.rollbackToCommit(targetSha);
      res.status(200).json({ message: `Repository ${repoId} rolled back to state before upload of ${sourceFilePath}. Target commit: ${targetSha}` });

    } catch (error: any) {
      console.error(`[API] Error reverting file and KB for ${sourceFilePath} in repo ${repoId}:`, error);
      res.status(500).json({ error: 'Failed to process revert-file-and-kb request.', details: error.message });
    }
  });

  // POST /api/v1/repositories/:repoId/rollback/revert-kb-for-file
  router.post('/:repoId/rollback/revert-kb-for-file', async (req: Request, res: Response) => {
    const { repoId } = req.params;
    const { sourceFilePath } = req.body;

    if (!sourceFilePath) {
      return res.status(400).json({ error: 'sourceFilePath is required in the request body.' });
    }

    try {
      const repository = repositoryManager.getRepository(repoId);
      if (!repository) {
        return res.status(404).json({ error: `Repository with ID '${repoId}' not found.` });
      }

      const targetSha = await timelineService.findFileUploadCommit(repository, sourceFilePath);
      if (!targetSha) {
        return res.status(404).json({ error: `Could not find upload commit for file: ${sourceFilePath}` });
      }

      console.log(`[API] Rolling back repo ${repoId} to the upload commit of ${sourceFilePath} (target commit: ${targetSha})`);
      await repository.rollbackToCommit(targetSha);
      res.status(200).json({ message: `Repository ${repoId} rolled back to the upload commit of ${sourceFilePath}. Target commit: ${targetSha}` });

    } catch (error: any) {
      console.error(`[API] Error reverting KB for file ${sourceFilePath} in repo ${repoId}:`, error);
      res.status(500).json({ error: 'Failed to process revert-kb-for-file request.', details: error.message });
    }
  });

  return router;
} 