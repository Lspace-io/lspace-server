import express from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { OrchestratorService } from '../orchestrator/orchestratorService';
import { RepositoryManager } from '../core/repositoryManager';
import { validateRequest } from './middleware/validation';
import { LLMService } from '../orchestrator/llmService';
import { KnowledgeBaseService } from '../knowledge-base/knowledgeBaseService';
import { 
  type FileUploadInput, 
  type TextSnippetInput, 
  type WebUrlInput, 
  type ChatMessageInput,
  type ProcessableInput
} from '../orchestrator/orchestratorService';

/**
 * API for orchestrating document processing and repository management
 */
export function createOrchestratorApi(
  repositoryManager: RepositoryManager,
  llmService: LLMService,
  knowledgeBaseService: KnowledgeBaseService
): Router {
  const router = Router();
  const orchestratorService = new OrchestratorService(repositoryManager, llmService, knowledgeBaseService);
  
  // --- START: Schemas for Unified Input Processing ---

  const baseProcessableInputSchema = z.object({
    repositoryId: z.string().uuid(),
    user: z.string().optional(),
    metadata: z.record(z.any()).optional(), // General metadata object
  });

  const fileUploadSchema = baseProcessableInputSchema.extend({
    type: z.literal('file_upload'),
    fileName: z.string().min(1),
    content: z.string(), // Assuming content is passed as a string (e.g., base64 encoded or direct text)
  });

  const textSnippetSchema = baseProcessableInputSchema.extend({
    type: z.literal('text_snippet'),
    title: z.string().optional(),
    content: z.string().min(1),
  });

  const webUrlSchema = baseProcessableInputSchema.extend({
    type: z.literal('web_url'),
    url: z.string().url(),
  });

  const chatMessageSchema = baseProcessableInputSchema.extend({
    type: z.literal('chat_message'),
    chatId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string().min(1),
    timestamp: z.string().datetime(), // ISO 8601 timestamp
  });

  const processableInputSchema = z.discriminatedUnion("type", [
    fileUploadSchema,
    textSnippetSchema,
    webUrlSchema,
    chatMessageSchema,
  ]);

  // --- END: Schemas for Unified Input Processing ---
  
  // Schema for processing a document
  const processDocumentSchema = z.object({
    repositoryId: z.string().uuid(),
    content: z.string(),
    title: z.string().optional(),
    tags: z.array(z.string()).optional(),
    user: z.string().optional()
  });
  
  // Process a document
  router.post(
    '/process-document',
    validateRequest({ body: processDocumentSchema }),
    async (req, res, next) => {
      try {
        const { repositoryId, content, user, title } = req.body;
        
        const result = await orchestratorService.processDocument(
          repositoryId,
          content,
          user,
          title
        );
        
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );
  
  // Schema for repository ID
  const repositoryIdSchema = z.object({
    repositoryId: z.string().uuid()
  });
  
  // Organize a repository
  router.post(
    '/organize-repository/:repositoryId',
    validateRequest({ params: repositoryIdSchema }),
    async (req, res, next) => {
      try {
        const { repositoryId } = req.params;
        
        const result = await orchestratorService.organizeRepository(repositoryId);
        
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );
  
  // Generate a repository summary
  router.get(
    '/repository-summary/:repositoryId',
    validateRequest({ params: repositoryIdSchema }),
    async (req, res, next) => {
      try {
        const { repositoryId } = req.params;
        
        const summary = await orchestratorService.generateRepositorySummary(repositoryId);
        
        res.status(200).json(summary);
      } catch (error) {
        next(error);
      }
    }
  );
  
  // Prune a repository
  router.post(
    '/prune-repository/:repositoryId',
    validateRequest({ params: repositoryIdSchema }),
    async (req, res, next) => {
      try {
        const { repositoryId } = req.params;
        
        const result = await orchestratorService.pruneRepository(repositoryId);
        
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );

  // New Unified Input Endpoint
  router.post(
    '/input', // Effectively /api/orchestrator/input
    validateRequest({ body: processableInputSchema }),
    async (req, res, next) => {
      try {
        // req.body is already validated to be one of ProcessableInput types
        const inputData = req.body as ProcessableInput; 
        const result = await orchestratorService.processInput(inputData);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    }
  );
  
  return router;
}

