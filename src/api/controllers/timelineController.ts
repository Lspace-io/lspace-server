import { Request, Response, NextFunction } from 'express';
import { TimelineEntry } from '../../core/types/timeline'; // Import the v2 interface
import { v4 as uuidv4 } from 'uuid'; // For generating IDs
import { RepositoryManager } from '../../core/repositoryManager';
import { Repository } from '../../core/repository'; // Assuming Repository class is exported
import fs from 'fs'; // For Multer temporary file deletion
import path from 'path'; // For path.resolve with __dirname for hardcoded path
import { OrchestratorService, DocumentProcessingResult } from '../../orchestrator/orchestratorService'; // Import actual OrchestratorService
import fsPromises from 'fs/promises'; // For async file operations

// Remove the local orchestratorService stub
// const orchestratorService = { ... };

async function readTimelineJson(repository: Repository): Promise<TimelineEntry[]> {
  try {
    const timelineContent = await repository.readFile('.lspace/timeline.json');
    const timelineData = JSON.parse(timelineContent);
    return (timelineData && Array.isArray(timelineData.entries)) ? timelineData.entries as TimelineEntry[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`Timeline file not found for repository ${repository.path}. Returning empty array.`);
      return [];
    }
    console.error(`Error reading/parsing timeline.json for ${repository.path}:`, error);
    throw error;
  }
}

export const uploadFile = (repositoryManager: RepositoryManager, orchestratorService: OrchestratorService) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      return res.status(400).send({ message: 'No file uploaded.' });
    }
    const repositoryId = req.params.repositoryId;
    if (!repositoryId) {
        return res.status(400).send({ message: 'Repository ID is required.'});
    }
    
    console.log(`TimelineController: File uploaded: ${req.file.originalname}, path: ${req.file.path}, size: ${req.file.size}`);
    
    // Read the content of the uploaded file
    const fileContent = await fsPromises.readFile(req.file.path, 'utf8');
    
    // Determine user (example, adjust as needed based on your auth setup if req.user is available)
    const user = (req as any).user?.id || 'ui-upload-user'; 

    // Call orchestratorService.processDocument to use the desired logic
    // This method handles saving the file to the 'raw/' directory, committing, 
    // creating timeline entries, and KB generation via LLMService.processDocumentConversational.
    const processingResult: DocumentProcessingResult = await orchestratorService.processDocument(
      repositoryId,
      fileContent,
      user,
      req.file.originalname // Use original filename as title
    );

    // Delete the temporary file uploaded by multer
    try {
      await fsPromises.unlink(req.file.path);
      console.log(`TimelineController: Deleted temp file ${req.file.path}`);
    } catch (unlinkError) {
      console.error(`TimelineController: Error deleting temp file ${req.file.path}:`, unlinkError);
      // Log error but don't fail the request, as processing was successful
    }

    // Respond with the result from processDocument.
    // Note: processingResult.timelineEntry is a subset of the full TimelineEntry.
    // The client (frontend) might need adjustment if it expects the old full TimelineEntry structure.
    res.status(201).json(processingResult);

  } catch (error) {
    console.error('Error during file upload processing (TimelineController):', error);
    
    // Attempt to clean up temp file on error path if it still exists
    if (req.file && fs.existsSync(req.file.path)) { 
        fsPromises.unlink(req.file.path).catch(err => {
          // Supress error here as we are already in an error path
          console.error("TimelineController: Error deleting multer temp file on error path:", err);
        });
    }
    next(error);
  }
};

export const getTimeline = (repositoryManager: RepositoryManager) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const repositoryId = req.params.repositoryId || 'default-repo';
    const repo = await repositoryManager.getRepository(repositoryId);
    if (!repo) return res.status(404).send({ message: `Repository ${repositoryId} not found.`});

    const allEntries = await readTimelineJson(repo);
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt(req.query.limit as string) || 10;
    let startIndex = 0;
    if (cursor) {
      const foundIndex = allEntries.findIndex(entry => entry.id === cursor);
      if (foundIndex !== -1) startIndex = foundIndex + 1;
    }
    const paginatedEntries = allEntries.slice(startIndex, startIndex + limit);
    const nextCursor = (allEntries.length > startIndex + limit && paginatedEntries.length > 0) ? paginatedEntries[paginatedEntries.length - 1].id : null;
    res.status(200).json({ entries: paginatedEntries, cursor: nextCursor });
  } catch (error) {
    console.error('Error fetching timeline:', error);
    next(error);
  }
};

export const getTimelineEntryById = (repositoryManager: RepositoryManager) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const repositoryId = req.params.repositoryId || 'default-repo';
    const entryId = req.params.id;
    if (!entryId) {
      return res.status(400).json({ message: 'Timeline entry ID is required.' });
    }
    const repo = await repositoryManager.getRepository(repositoryId);
    if (!repo) return res.status(404).send({ message: `Repository ${repositoryId} not found.`});

    const allEntries = await readTimelineJson(repo);
    const entry = allEntries.find(e => e.id === entryId);
    if (entry) {
      res.status(200).json(entry);
    } else {
      res.status(404).json({ message: `Timeline entry with ID ${entryId} not found in repository ${repositoryId}.` });
    }
  } catch (error) {
    console.error(`Error fetching timeline entry by ID ${req.params.id}:`, error);
    next(error);
  }
};

// Placeholder for GitService - to be replaced by Repository methods
const gitService = {
  getCommitDiff: async (repository: Repository, commitSha: string): Promise<string> => {
    console.log(`GitService: Getting diff for commit ${commitSha} in repo ${repository.path}`);
    if (typeof repository.getCommitDiff === 'function') {
      return repository.getCommitDiff(commitSha);
    }
    return `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old for ${commitSha}\n+new for ${commitSha}\n`;
  }
};

// Placeholder for OrchestratorService's regeneration capability
const orchestratorServiceForRegen = {
  triggerFullRegeneration: async (repository: Repository, reason?: string): Promise<{ commitSha: string, affectedKBPaths: string[] }> => {
    console.log(`Orchestrator: Regen for repo ${repository.path}. Reason: ${reason || 'N/A'}`);
    return { commitSha: 'regen_commit_placeholder', affectedKBPaths: ['kb/all.md'] };
  }
};

export const getTimelineEntryDiff = (repositoryManager: RepositoryManager) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const repositoryId = req.params.repositoryId || 'default-repo';
    const entryId = req.params.id;
    if (!entryId) {
      return res.status(400).json({ message: 'Timeline entry ID is required.' });
    }
    const repo = await repositoryManager.getRepository(repositoryId);
    if (!repo) return res.status(404).send({ message: `Repository ${repositoryId} not found.`});

    const allEntries = await readTimelineJson(repo);
    const entry = allEntries.find(e => e.id === entryId);
    if (!entry) {
      return res.status(404).json({ message: `Timeline entry with ID ${entryId} not found.` });
    }
    if (!entry.commit || entry.commit === 'pending_commit_placeholder') {
      return res.status(400).json({ message: `Commit SHA not available for timeline entry ${entryId}.` });
    }
    const diffText = await gitService.getCommitDiff(repo, entry.commit);
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(diffText);
  } catch (error) {
    console.error(`Error fetching diff for timeline entry ${req.params.id}:`, error);
    next(error);
  }
};

export const regenerateKnowledgeBase = (repositoryManager: RepositoryManager) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = req.body;
    const repositoryId = req.params.repositoryId || 'default-repo';
    const repo = await repositoryManager.getRepository(repositoryId);
    if (!repo) return res.status(404).send({ message: `Repository ${repositoryId} not found.`});

    const regenResult = await orchestratorServiceForRegen.triggerFullRegeneration(repo, reason);
    const timelineEntry: TimelineEntry = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      actor: 'user',
      operation: 'regen',
      sourcePath: null,
      commit: regenResult.commitSha,
      affectedKB: regenResult.affectedKBPaths,
      bulk: true,
      meta: {
        reason: reason || 'User triggered regen',
        status: "stubbed_regen_response"
      }
    };
    // TODO: Persist this timelineEntry to timeline.json for the repository (e.g., using repo.writeFile(...) after reading and updating)
    res.status(201).json(timelineEntry);
  } catch (error) {
    console.error('Error during knowledge base regeneration:', error);
    next(error);
  }
};

export const revertTimelineEntry = (repositoryManager: RepositoryManager) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entryId = req.params.id;
    const repositoryId = req.params.repositoryId || 'default-repo';
    // const repo = await repositoryManager.getRepository(repositoryId); // Needed when implemented
    // if (!repo) return res.status(404).send({ message: `Repository ${repositoryId} not found.`});
    console.log(`Revert timeline entry ${entryId} for repo ${repositoryId}. Not implemented.`);
    res.status(501).json({ message: `Reverting entry ${entryId} not implemented.` });
  } catch (error) {
    console.error(`Error during attempt to revert timeline entry ${req.params.id}:`, error);
    next(error);
  }
};

// Future controller methods for other timeline endpoints (GET /timeline, GET /timeline/:id, etc.)
// export const getTimeline = async (req: Request, res: Response, next: NextFunction) => { ... };
// export const getTimelineEntryById = async (req: Request, res: Response, next: NextFunction) => { ... };
// ... and so on 