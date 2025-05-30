import express, { Request, Response, Router } from 'express';
import { RepositoryManager } from '../core/repositoryManager';
import { ChatAssistantService } from '../services/chatAssistantService';
import { LLMService } from '../orchestrator/llmService';
import { Repository } from '../core/repository'; // Added for type checking repository
import { TimelineService } from '../core/timelineService'; // Import TimelineService

export function createChatRoutes(repositoryManager: RepositoryManager, timelineService: TimelineService): Router {
  const router: Router = express.Router();

  // POST /api/v1/chat/:repoId
  router.post('/:repoId', async (req: Request, res: Response) => {
    const { repoId } = req.params;
    const { message: userMessage, userId = 'default-user' } = req.body;

    if (!userMessage) {
      return res.status(400).json({ error: 'User message is required in the request body.' });
    }

    try {
      const repository = repositoryManager.getRepository(repoId);

      if (!repository) {
        return res.status(404).json({ error: `Repository with ID '${repoId}' not found.` });
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.error('OPENAI_API_KEY environment variable is not set.');
        return res.status(500).json({ error: 'Server configuration error: Missing API key.' });
      }

      const llmService = new LLMService({
        apiKey: apiKey,
        repositoryPath: repository.path,
      });
      
      const chatAssistantService = new ChatAssistantService(repository, llmService, timelineService);

      console.log(`Processing chat message for repoId: ${repoId}, userId: ${userId}`);
      const assistantResponse = await chatAssistantService.processUserMessage(userId, repoId, userMessage);
      
      res.status(200).json(assistantResponse);

    } catch (error: any) {
      console.error(`Error processing chat message for repoId ${repoId}:`, error);
      if (error.message && error.message.includes('not found')) {
          return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: 'Failed to process chat message.', details: error.message });
    }
  });

  return router;
} 