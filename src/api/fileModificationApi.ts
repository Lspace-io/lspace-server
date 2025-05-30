import express from 'express';
import { RepositoryManager } from '../core/repositoryManager';
import { z } from 'zod';
import path from 'path';
import { KnowledgeBaseService } from '../knowledge-base/knowledgeBaseService';
import { OrchestratorService } from '../orchestrator/orchestratorService';
import { LLMService } from '../orchestrator/llmService';

/**
 * Set up file modification API routes
 * @param app Express application
 * @param repositoryManager Repository manager instance
 * @param knowledgeBaseService KnowledgeBaseService instance
 * @param llmService LLMService instance
 */
export function setupFileModificationRoutes(
  app: express.Application,
  repositoryManager: RepositoryManager,
  knowledgeBaseService: KnowledgeBaseService,
  llmService: LLMService
): void {
  const orchestratorService = new OrchestratorService(repositoryManager, llmService, knowledgeBaseService);

  /**
   * POST /api/repositories/:id/files - Create a new file using the full processing pipeline.
   * The 'path' field in the request body will be ignored as the pipeline determines the path.
   */
  app.post('/api/repositories/:id/files', async (req, res, next) => {
    try {
      // Validate the request body - only 'content' is strictly needed now for OrchestratorService
      // 'path' is ignored. 'user' could be extracted from auth middleware in a real app.
      const schema = z.object({
        path: z.string().min(1).optional(), // Path is now optional and ignored
        content: z.string(),
        user: z.string().optional() // Added user, though it's optional
      });
      
      const validation = schema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.format() });
      }
      
      // Content is essential. User is optional. Path from request is ignored.
      const { content, user } = validation.data;
      const repositoryId = req.params.id;
      
      // Call OrchestratorService to process the document
      const result = await orchestratorService.processDocument(
        repositoryId,
        content,
        user 
      );
      
      // The result from processDocument already includes path, timelineEntry, etc.
      // Status 200 for successful processing, or could be 201/202 if treating as async.
      // Let's align with how orchestratorApi returns it (200).
      res.status(200).json(result);

    } catch (error: any) {
      // Consistent error handling
      // if (error.message.includes('not found')) { // OrchestratorService throws its own errors
      //   return res.status(404).json({ error: 'Repository not found' });
      // }
      // res.status(500).json({ error: error.message });
      next(error); // Delegate to Express error handling
    }
  });

  /**
   * PUT /api/repositories/:id/files/:path(*) - Update an existing file
   */
  app.put('/api/repositories/:id/files/:path(*)', async (req, res) => {
    try {
      // Validate the request body
      const schema = z.object({
        content: z.string()
      });
      
      const validation = schema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.format() });
      }
      
      const { content } = validation.data;
      const filePath = req.params.path;
      
      // Get the repository
      const repository = repositoryManager.getRepository(req.params.id);
      
      // Check if the file exists
      const fileExists = await repository.fileExists(filePath);
      if (!fileExists) {
        return res.status(404).json({ error: 'File not found' });
      }
      
      // Write the file content
      await repository.writeFile(filePath, content);

      // Add and commit the changes
      await repository.add([filePath]);
      const commitResult = await repository.commit({ message: `Update ${filePath}` });
      
      // Trigger knowledge base generation (non-blocking)
      knowledgeBaseService.OLD_generateKnowledgeBase(repository)
        .then(() => console.log(`Knowledge base update successfully triggered for repository ${req.params.id}`))
        .catch((kbError: any) => console.error(`Error triggering knowledge base update for repository ${req.params.id}:`, kbError));
      
      res.json({
        success: true,
        path: filePath,
        commit: commitResult.hash
      });
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
   * DELETE /api/repositories/:id/files/:path(*) - Delete a file
   */
  app.delete('/api/repositories/:id/files/:path(*)', async (req, res) => {
    try {
      const filePath = req.params.path;
      
      // Get the repository
      const repository = repositoryManager.getRepository(req.params.id);
      
      // Check if the file exists
      const fileExists = await repository.fileExists(filePath);
      if (!fileExists) {
        return res.status(404).json({ error: 'File not found' });
      }
      
      // Delete the file
      await repository.deleteFile(filePath);
      
      // Commit the changes
      const commitResult = await repository.commit({ message: `Delete ${filePath}` });
      
      // Trigger knowledge base generation (non-blocking)
      knowledgeBaseService.OLD_generateKnowledgeBase(repository)
        .then(() => console.log(`Knowledge base update successfully triggered for repository ${req.params.id}`))
        .catch((kbError: any) => console.error(`Error triggering knowledge base update for repository ${req.params.id}:`, kbError));
      
      res.json({
        success: true,
        path: filePath,
        commit: commitResult.hash
      });
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
   * POST /api/repositories/:id/files/move - Move/rename a file
   */
  app.post('/api/repositories/:id/files/move', async (req, res) => {
    try {
      // Validate the request body
      const schema = z.object({
        oldPath: z.string().min(1),
        newPath: z.string().min(1)
      });
      
      const validation = schema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.format() });
      }
      
      const { oldPath, newPath } = validation.data;
      
      // Get the repository
      const repository = repositoryManager.getRepository(req.params.id);
      
      // Check if the old file exists
      const oldFileExists = await repository.fileExists(oldPath);
      if (!oldFileExists) {
        return res.status(404).json({ error: 'Source file not found' });
      }
      
      // Check if the new file already exists
      const newFileExists = await repository.fileExists(newPath);
      if (newFileExists) {
        return res.status(409).json({ error: 'Destination file already exists' });
      }
      
      // Move the file
      await repository.moveFile(oldPath, newPath);
      
      // Commit the changes
      const commitResult = await repository.commit({ message: `Move ${oldPath} to ${newPath}` });
      
      // Trigger knowledge base generation (non-blocking)
      knowledgeBaseService.OLD_generateKnowledgeBase(repository)
        .then(() => console.log(`Knowledge base update successfully triggered for repository ${req.params.id}`))
        .catch((kbError: any) => console.error(`Error triggering knowledge base update for repository ${req.params.id}:`, kbError));
      
      res.json({
        success: true,
        oldPath,
        newPath,
        commit: commitResult.hash
      });
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
   * POST /api/repositories/:id/files/batch - Create multiple files in a single commit
   */
  app.post('/api/repositories/:id/files/batch', async (req, res) => {
    try {
      // Validate the request body
      const schema = z.object({
        files: z.array(
          z.object({
            path: z.string().min(1),
            content: z.string()
          })
        ),
        commitMessage: z.string().default('Add multiple files')
      });
      
      const validation = schema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.format() });
      }
      
      const { files, commitMessage } = validation.data;
      
      // Get the repository
      const repository = repositoryManager.getRepository(req.params.id);
      
      // Write all files
      for (const file of files) {
        // Prepend 'raw/' to the path
        const rawFilePath = path.join('raw', file.path);
        // Ensure the directory exists (optional, depends on writeFile implementation)
        // await repository.ensureDirectoryExists(path.dirname(rawFilePath)); 
        await repository.writeFile(rawFilePath, file.content);
      }
      
      // Commit the changes
      const filesToCommit = files.map(file => file.path);
      await repository.add(filesToCommit);
      const commitResult = await repository.commit({ message: commitMessage });
      
      // Trigger knowledge base generation (non-blocking)
      knowledgeBaseService.OLD_generateKnowledgeBase(repository)
        .then(() => console.log(`Knowledge base update successfully triggered for repository ${req.params.id}`))
        .catch((kbError: any) => console.error(`Error triggering knowledge base update for repository ${req.params.id}:`, kbError));
      
      res.status(201).json({
        success: true,
        fileCount: files.length,
        commit: commitResult.hash
      });
    } catch (error: any) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ error: 'Repository not found' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * PATCH /api/repositories/:id/files/:path(*) - Apply a JSON Patch to a file
   */
  app.patch('/api/repositories/:id/files/:path(*)', async (req, res) => {
    try {
      // Validate the request body
      const schema = z.object({
        patches: z.array(
          z.object({
            operation: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
            path: z.string(),
            value: z.any().optional(),
            from: z.string().optional()
          })
        )
      });
      
      const validation = schema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ error: validation.error.format() });
      }
      
      const { patches } = validation.data;
      const filePath = req.params.path;
      
      // Get the repository
      const repository = repositoryManager.getRepository(req.params.id);
      
      // Check if the file exists
      const fileExists = await repository.fileExists(filePath);
      if (!fileExists) {
        return res.status(404).json({ error: 'File not found' });
      }
      
      // Read the current content
      const currentContent = await repository.readFile(filePath);
      
      // In a real implementation, we would apply the JSON Patch to the file
      // This is just a placeholder that overwrites the file
      // For a proper implementation, you would need to parse the markdown,
      // apply the patches, and then stringify it again
      
      // For now, we'll just modify the content with a simple text replacement
      // This is NOT a proper JSON Patch implementation
      let newContent = currentContent;
      
      // Simple patch simulation - in a real implementation, use a JSON Patch library
      for (const patch of patches) {
        if (patch.operation === 'replace' && patch.path === '/title' && typeof patch.value === 'string') {
          // Replace title by looking for the first heading
          newContent = newContent.replace(/^#\s.*$/m, `# ${patch.value}`);
        } else if (patch.operation === 'add' && patch.path === '/sections/-' && typeof patch.value === 'string') {
          // Add a new section at the end
          newContent = `${newContent}\n\n${patch.value}`;
        }
      }
      
      // Write the updated content
      await repository.writeFile(filePath, newContent);
      
      // Commit the changes
      const commitResult = await repository.commit({ message: `Update ${filePath}` });
      
      // Trigger knowledge base generation (non-blocking)
      knowledgeBaseService.OLD_generateKnowledgeBase(repository)
        .then(() => console.log(`Knowledge base update successfully triggered for repository ${req.params.id}`))
        .catch((kbError: any) => console.error(`Error triggering knowledge base update for repository ${req.params.id}:`, kbError));
      
      res.json({
        success: true,
        path: filePath,
        commit: commitResult.hash
      });
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
}