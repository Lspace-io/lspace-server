import path from 'path';
import { Repository } from '../core/repository';
import { RepositoryManager } from '../core/repositoryManager';
import { TimelineService, OperationType as TimelineServiceOperationType, TimelineEntry } from '../core/timelineService';
import { 
  LLMService, 
  ClassificationResult, 
  StructuredDocument, 
  DuplicateDetectionResult,
  ContentOrganizationResult,
  RepositorySummary,
  PruningRecommendations
} from './llmService';
import { KnowledgeBaseService } from '../knowledge-base/knowledgeBaseService';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';

// Input Type Interfaces
export interface BaseInput {
  repositoryId: string;
  user?: string; 
  metadata?: Record<string, any>; 
}

export interface FileUploadInput extends BaseInput {
  type: 'file_upload';
  fileName: string;
  content: string; // Can be direct content or base64 string
}

export interface TextSnippetInput extends BaseInput {
  type: 'text_snippet';
  title?: string; 
  content: string;
}

export interface WebUrlInput extends BaseInput {
  type: 'web_url';
  url: string;
}

export interface ChatMessageInput extends BaseInput {
  type: 'chat_message';
  chatId: string; 
  messageId: string; 
  text: string;
  timestamp: string; // ISO 8601
}

export type ProcessableInput = FileUploadInput | TextSnippetInput | WebUrlInput | ChatMessageInput;

export interface DocumentProcessingResult {
  rawInputPath?: string; 
  knowledgeBaseUpdated: boolean;
  message?: string;
  knowledgeBasePath?: string; // Added to return path to KB article
  [key: string]: any; 
}

// Existing OrchestratorServiceRequestBody and OrchestratorServiceResponse 
// might need to be reviewed or updated based on these new types, or new ones created for the API layer.

export interface OrchestratorServiceRequestBody {
  repositoryId: string;
  content?: string;      // For direct content processing (e.g. initial file upload/text snippet)
  filePath?: string;     // For processing an existing file already in the repo (e.g. from /.lspace/raw_inputs/)
  fileName?: string;     // Original name for uploaded file
  url?: string;          // For URL input type
  inputType?: 'file' | 'text' | 'url' | 'chat'; // To guide processing logic
  user?: string;
  metadata?: Record<string, any>; // For any other input-specific data like chat IDs, titles etc.
}

export interface OrchestratorServiceResponse {
  rawInputPath?: string; 
  knowledgeBasePath?: string; // Path to the main KB article created/updated in the root
  readmeUpdated?: boolean;
  category?: string;
  subcategory?: string;
  title?: string;
  tags?: string[];
  timelineEntry?: TimelineEntry | null;
  message?: string;
}

// Document processing result
export interface RepositoryOrganizationResult {
  moved: number;
  updated: number;
  created: number;
  unchanged: number;
}

// Repository pruning result
export interface RepositoryPruningResult {
  deleted: number;
  merged: number;
  unchanged: number;
}

/**
 * Orchestrator service for coordinating document processing and repository organization
 */
export class OrchestratorService {
  private repositoryManager: RepositoryManager;
  private llmService: LLMService;
  private timelineService: TimelineService;
  private knowledgeBaseService: KnowledgeBaseService;
  
  constructor(
    repositoryManager: RepositoryManager,
    llmService: LLMService,
    knowledgeBaseService: KnowledgeBaseService
  ) {
    this.repositoryManager = repositoryManager;
    this.timelineService = new TimelineService();
    this.llmService = llmService;
    this.knowledgeBaseService = knowledgeBaseService;
  }
  
  /**
   * Process a new document - classify, structure, and add to repository
   */
  async processDocument(
    repositoryId: string, 
    content: string,
    user?: string,
    title?: string
  ): Promise<DocumentProcessingResult> {
    const repository = await this.getRepository(repositoryId);
    
    // IMPORTANT: Update the LLM service repository path to match the current repository
    // This ensures tool operations happen in the correct repository
    this.llmService.updateRepositoryPath(repository.path);
    
    // Use the provided title/filename or generate a default one
    const baseFilename = title || `document-${Date.now()}.md`;
    // Store in /.lspace/raw_inputs/
    const rawInputsDir = path.join('.lspace', 'raw_inputs'); 
    const finalPath = path.join(rawInputsDir, baseFilename);

    // Ensure the directory exists for the finalPath (within .lspace/raw_inputs)
    const absoluteRawInputsDir = path.resolve(repository.path, rawInputsDir);
    if (!fs.existsSync(absoluteRawInputsDir)) {
      fs.mkdirSync(absoluteRawInputsDir, { recursive: true });
    }
    
    // Write the raw document to the repository
    await repository.writeFile(finalPath, content);
    
    // First prepare timeline entry without committing
    const pendingTimelineEntry = {
      operation: 'add' as TimelineServiceOperationType,
      path: finalPath, // Path within .lspace/raw_inputs
      title: baseFilename,
      user: user
    };
    
    // Create timeline entry but don't commit yet
    const preparedTimelineEntry = await this.timelineService.prepareEntry(repository, pendingTimelineEntry);
    
    // Now commit both the raw document and timeline update together
    const combinedCommitMessage = `Add raw document to .lspace/raw_inputs: ${baseFilename}`;
    const commitResult = await repository.commit({ message: combinedCommitMessage });
    
    // Finalize the timeline entry with the commit info
    let timelineEntry = null;
    if (commitResult.success && commitResult.hash) {
      // Update the timeline entry with commit info
      timelineEntry = await this.timelineService.finalizeEntry(repository, preparedTimelineEntry, {
        id: commitResult.hash,
        message: combinedCommitMessage
      });
    }

    // Use LLM directly to process the document and generate KB content
    try {
      console.log(`[OrchestratorService] Using LLM to generate knowledge base from ${finalPath}`);
      
      // The KB root is the repository root. LLM will create /README.md and other files/dirs there.
      // No specific "knowledge-base" directory is enforced by the orchestrator anymore.
      // The LLM's prompt guides it to manage files/folders in the root.

      const currentKbState = await this.llmService.getCurrentKnowledgeBaseStructure(); // This should reflect root
      
      // Format the knowledge base state in a more readable way to help the LLM identify contradictions
      let kbStateDescription = "";
      
      // If we have document contents, provide them in a structured format
      if (currentKbState.documentContents && Object.keys(currentKbState.documentContents).length > 0) {
        kbStateDescription += "EXISTING KNOWLEDGE BASE CONTENT:\n\n";
        
        // Add each file with its content
        for (const [filePath, content] of Object.entries(currentKbState.documentContents)) {
          kbStateDescription += `FILE: ${filePath}\n`;
          kbStateDescription += "```\n";
          kbStateDescription += content;
          kbStateDescription += "\n```\n\n";
        }
        
        kbStateDescription += "KNOWLEDGE BASE STRUCTURE:\n";
      }
      
      // Add the structure information
      kbStateDescription += JSON.stringify(currentKbState.structure || currentKbState, null, 2);
      
      console.log(`[OrchestratorService] Enhanced KB context prepared with ${Object.keys(currentKbState.documentContents || {}).length} file contents`);
      console.log(`[OrchestratorService] KB context preview: ${kbStateDescription.substring(0, 100)}...`);
      
      // Process the document using the conversational LLM approach
      const result = await this.llmService.processDocumentConversational(
        finalPath,  // Pass the full relative path from repo root, e.g. .lspace/raw_inputs/doc.md
        content,       // File content
        currentKbState, // Pass the object for analysis logic
        kbStateDescription, // Pass the string for the prompt
        1,             // Total files (just this one)
        1              // Current file number
      );
      
      console.log(`[OrchestratorService] LLM processing result: ${result.status}`);
      
      // Check if the LLM processing was successful
      console.log(`[OrchestratorService] LLM processing completed with status: ${result.status}`);
      
      // Log the KB files created by the LLM - these would be in the root or subdirs of root
      const kbFiles = await repository.listFiles('.'); // List from root
      console.log(`[OrchestratorService] Found ${kbFiles.length} files in repository root after LLM:`, 
                 kbFiles.map(f => f.path).join(', '));
      
      // Generate a detailed commit message from the LLM's processing history
      try {
        console.log(`[OrchestratorService] Generating detailed commit message`);
        const commitSummary = await this.llmService.generateKnowledgeBaseSummary(result.history);
        
        // Create a formatted commit message with the filename and LLM's summary
        const detailedCommitMessage = `Knowledge Base Update: ${baseFilename}\n\n${commitSummary}`;
        
        console.log(`[OrchestratorService] Committing KB changes with detailed message`);
        await repository.commit({ message: detailedCommitMessage });
      } catch (commitError) {
        console.error(`[OrchestratorService] Error committing KB changes: ${commitError}`);
        // Fallback to generic commit message if summary generation fails
        await repository.commit({ message: `Update knowledge base with content from ${baseFilename}` });
      }
    } catch (llmError) {
      console.error(`[OrchestratorService] Error using LLM to process document: ${llmError}`);
    }

    return {
      rawInputPath: finalPath, // Corrected from just `path`
      knowledgeBaseUpdated: true, // Assuming it was, or based on LLM result
      knowledgeBasePath: 'README.md', // Example, should come from LLM result ideally
      timelineEntry: timelineEntry ? {
        id: timelineEntry.id,
        timestamp: timelineEntry.timestamp,
        operation: timelineEntry.operation,
        user: timelineEntry.user
      } : undefined
    };
  }
  
  /**
   * Organize and structure repository content
   */
  async organizeRepository(repositoryId: string): Promise<RepositoryOrganizationResult> {
    // Get the repository
    const repository = await this.getRepository(repositoryId);
    
    // Get all files in the repository
    const files = await this.getRepositoryFiles(repository);
    
    // Skip if there are no files to organize
    if (files.length === 0) {
      return {
        moved: 0,
        updated: 0,
        created: 0,
        unchanged: 0
      };
    }
    
    // Get organization recommendations from the LLM
    const organization = await this.llmService.organizeContent(files);
    
    // Track the original file list to calculate unchanged count
    const originalFilePaths = new Set(files.map(f => f.path));
    let filesToCommit: string[] = []; // Initialize array to hold paths of files to commit
    
    // Process moves
    let movedCount = 0;
    for (const move of organization.moves) {
      if (await repository.fileExists(move.from)) {
        const content = await repository.readFile(move.from);
        
        // Ensure the target directory exists
        const targetDir = path.dirname(move.to);
        if (targetDir !== '.') {
          const dirExists = await repository.fileExists(targetDir);
          if (!dirExists) {
            await repository.writeFile(path.join(targetDir, '.placeholder'), '');
            await repository.deleteFile(path.join(targetDir, '.placeholder'));
          }
        }
        
        // Write to new location and delete from old
        await repository.writeFile(move.to, content);
        await repository.deleteFile(move.from);
        movedCount++;
      }
    }
    
    // Process updates
    let updatedCount = 0;
    for (const update of organization.updates) {
      await repository.writeFile(update.path, update.content);
      updatedCount++;
    }
    
    // Process new files
    let createdCount = 0;
    for (const newFile of organization.newFiles) {
      // Ensure the directory exists
      const fileDir = path.dirname(newFile.path);
      if (fileDir !== '.') {
        const dirExists = await repository.fileExists(fileDir);
        if (!dirExists) {
          await repository.writeFile(path.join(fileDir, '.placeholder'), '');
          await repository.deleteFile(path.join(fileDir, '.placeholder'));
        }
      }
      
      await repository.writeFile(newFile.path, newFile.content);
      // Commit each new file
      await repository.commit({ message: `Organize: Create ${newFile.path}` });
      createdCount++;
    }
    
    // Create a list of affected files for commit
    if (movedCount > 0 || updatedCount > 0 || createdCount > 0) {
      const affectedFilesToCommit = [
        ...organization.moves.map((m: any) => m.to),
        ...organization.updates.map((u: any) => u.path),
        ...organization.newFiles.map((nf: any) => nf.path)
      ];
      await repository.add(affectedFilesToCommit);
      await repository.commit({ message: 'Organize repository content' });
    }
    
    // Calculate how many files were left unchanged
    const affectedOriginalFiles = new Set([
      ...organization.moves.map((m: any) => m.from),
      ...organization.updates.map((u: any) => u.path),
    ]);
    
    const unchangedCount = files.length - affectedOriginalFiles.size;
    
    return {
      moved: movedCount,
      updated: updatedCount,
      created: createdCount,
      unchanged: unchangedCount
    };
  }
  
  /**
   * Generate a summary of the repository content
   */
  async generateRepositorySummary(repositoryId: string): Promise<RepositorySummary> {
    // Get the repository
    const repository = await this.getRepository(repositoryId);
    
    // Get all files in the repository
    const files = await this.getRepositoryFiles(repository);
    
    // Skip if there are no files
    if (files.length === 0) {
      return {
        title: 'Empty Repository',
        description: 'This repository does not contain any files yet.',
        topics: [],
        fileCount: 0,
        mainCategories: [],
        lastUpdated: new Date().toISOString()
      };
    }
    
    // Generate summary using the LLM
    // return await this.llmService.generateSummary(files); // This is a stub

    // TEMP: Return a default summary if LLMService.generateSummary is a stub
    console.warn('[OrchestratorService.generateRepositorySummary] Actual summary generation SKIPPED due to stubbed LLMService.generateSummary.');
    return {
        title: 'Repository Summary (Placeholder)',
        description: `Repository contains ${files.length} file(s). Actual summary generation is currently stubbed.`,
        topics: ['general'],
        fileCount: files.length,
        mainCategories: ['uncategorized'],
        lastUpdated: new Date().toISOString()
    };
  }
  
  /**
   * Prune the repository by removing obsolete or redundant information
   */
  async pruneRepository(repositoryId: string): Promise<RepositoryPruningResult> {
    // Get the repository
    const repository = await this.getRepository(repositoryId);
    
    // Get all files in the repository
    const files = await this.getRepositoryFiles(repository);
    
    // Skip if there are no files
    if (files.length === 0) {
      return {
        deleted: 0,
        merged: 0,
        unchanged: 0
      };
    }
    
    // Get pruning recommendations from the LLM
    const pruningRecommendations = await this.llmService.detectObsoleteContent(files);
    
    let deletedCount = 0;
    let mergedCount = 0;
    
    // Process the recommendations
    for (const recommendation of pruningRecommendations.recommendations) {
      if (recommendation.action === 'delete') {
        // Delete the obsolete file
        if (await repository.fileExists(recommendation.path)) {
          await repository.deleteFile(recommendation.path);
          deletedCount++;
        }
      } else if (recommendation.action === 'merge') {
        // Merge duplicate files
        if (await repository.fileExists(recommendation.source) && 
            await repository.fileExists(recommendation.target)) {
          
          // Get the content of both files
          const sourceContent = await repository.readFile(recommendation.source);
          const targetContent = await repository.readFile(recommendation.target);
          
          // Use the LLM to merge the content
          const mergeResult = await this.llmService.detectDuplicates(
            sourceContent, 
            [{ path: recommendation.target, content: targetContent }]
          );
          
          if (mergeResult.mergedContent) {
            // Write the merged content to the target file
            await repository.writeFile(recommendation.target, mergeResult.mergedContent);
            // Delete the source file
            await repository.deleteFile(recommendation.source);
            mergedCount++;
          }
        }
      }
    }
    
    // Commit the changes if any were made
    let commitMessage = `Prune repository: Deleted ${deletedCount} files`;
    if (mergedCount > 0) {
      commitMessage += `, Merged ${mergedCount} files`;
    }
    await repository.commit({ message: commitMessage });
    
    // Calculate how many files were left unchanged
    const unchangedCount = files.length - (deletedCount + mergedCount);
    
    return {
      deleted: deletedCount,
      merged: mergedCount,
      unchanged: unchangedCount
    };
  }
  
  /**
   * Helper method to get a repository by ID
   */
  private async getRepository(repositoryId: string): Promise<Repository> {
    const repositoryInfo = this.repositoryManager.getRepositoryInfo(repositoryId);
    if (!repositoryInfo) {
      throw new Error(`Repository with ID ${repositoryId} not found`);
    }
    
    try {
      // Get the actual repository using the manager's method
      return this.repositoryManager.getRepository(repositoryId);
    } catch (error) {
      console.error(`Error getting repository ${repositoryId}:`, error);
      throw new Error(`Repository with ID ${repositoryId} not found or is invalid`);
    }
  }
  
  /**
   * Helper method to get all files from a repository
   */
  private async getRepositoryFiles(repository: Repository): Promise<{ path: string; content: string }[]> {
    try {
      const fileList = await repository.listFiles();
      
      // Filter out non-text files
      const textFiles = fileList.filter(file => {
        // Ensure file is a proper FileInfo object with a path property
        if (typeof file === 'string') {
          const ext = path.extname(file).toLowerCase();
          return ['.md', '.txt', '.json', '.yaml', '.yml', '.html', '.xml'].includes(ext);
        } else if (file && typeof file === 'object' && 'path' in file) {
          const ext = path.extname(file.path).toLowerCase();
          return ['.md', '.txt', '.json', '.yaml', '.yml', '.html', '.xml'].includes(ext);
        }
        return false;
      });
      
      // Read the content of each file
      const files = await Promise.all(textFiles.map(async (fileInfo) => {
        // Handle both string and FileInfo object
        const filePath = typeof fileInfo === 'string' ? fileInfo : fileInfo.path;
        const content = await repository.readFile(filePath);
        return { path: filePath, content };
      }));
      
      return files;
    } catch (error) {
      console.error('Error getting repository files:', error);
      // Return an empty array if there's an error
      return [];
    }
  }

  /**
   * Processes a new file upload, stores it, updates timeline, and commits.
   * KB update logic will be added here later.
   * 
   * @param repository The repository instance where the file is uploaded.
   * @param uploadedFilePath Temporary path of the uploaded file (e.g., from multer).
   * @param originalFilename Original name of the uploaded file.
   * @returns The created TimelineEntry.
   */
  async processNewUpload(
    repository: Repository,
    uploadedFilePath: string,
    originalFilename: string
  ): Promise<TimelineEntry> {
    const targetRawDir = 'raw'; // All user uploads go into 'raw' at the root of the repo
    const targetRawPath = path.join(targetRawDir, originalFilename);
    // Construct the absolute path in the repository for the new file
    const absoluteTargetPathInRepo = path.resolve(repository.path, targetRawPath);
    const absoluteTargetDirInRepo = path.dirname(absoluteTargetPathInRepo);

    try {
      // Ensure the target directory exists in the repository's working tree
      await fs.promises.mkdir(absoluteTargetDirInRepo, { recursive: true });
      

      // Move the uploaded file from its temporary location to the repository
      await fs.promises.rename(uploadedFilePath, absoluteTargetPathInRepo);
      console.log(`Moved file to ${absoluteTargetPathInRepo}`);

      // 1. Add and commit the new raw file
      await repository.add([targetRawPath]); // Use relative path for staging
      console.log(`Staged file ${targetRawPath}`);
      
      const rawFileCommitResult = await repository.commit({
        message: `feat: Add raw file ${originalFilename}`,
        // Author will use defaults from Repository.commit if not specified
      });

      if (!rawFileCommitResult.success || !rawFileCommitResult.hash) {
        throw new Error(`Failed to commit raw file ${originalFilename}: ${rawFileCommitResult.message}`);
      }
      const rawFileCommitSha = rawFileCommitResult.hash;
      console.log(`Committed raw file ${originalFilename} with SHA: ${rawFileCommitSha}`);

      // 2. Generate Knowledge Base articles from the new raw file
      let kbProcessingResult: { affectedKBPaths: string[]; kbCommitSha: string | null } = 
        { affectedKBPaths: [], kbCommitSha: null };
      try {
        kbProcessingResult = await this.knowledgeBaseService.processDocumentForKnowledgeBase(
          repository,
          targetRawPath, // path to the newly committed raw file
          rawFileCommitSha // commit SHA of the raw file
        );
        console.log(`KB processing result for ${originalFilename}:`, kbProcessingResult);
      } catch (kbError) {
        console.error(`Error during KB generation for ${originalFilename}. Proceeding with raw file info only.`, kbError);
        // KB generation is not critical path for timeline entry of raw file upload itself, log and continue
        // The TimelineEntry.commit will default to rawFileCommitSha and affectedKB will be empty.
      }

      // 3. Create TimelineEntry (was step 2)
      const finalCommitShaForEntry = kbProcessingResult.kbCommitSha || rawFileCommitSha;
      const finalAffectedKBPaths = kbProcessingResult.affectedKBPaths;

      const timelineEntry: TimelineEntry = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        operation: 'add',
        path: targetRawPath,
        commit: {
          id: finalCommitShaForEntry,
          message: `Update for ${originalFilename}`
        }
      };

      // 4. Read, update, and write timeline.json (was step 3)
      let timeline: TimelineEntry[] = [];
      const timelineJsonPath = 'timeline.json';
      try {
        const timelineContent = await repository.readFile(timelineJsonPath);
        timeline = JSON.parse(timelineContent);
      } catch (error) {
        if ((error as Error).message.includes('File not found')) {
          console.log('timeline.json not found, initializing a new one.');
          // Initialize with an empty array, the new entry will be the first one
        } else {
          console.error('Error reading timeline.json:', error);
          throw error; // Rethrow other errors
        }
      }

      timeline.push(timelineEntry);
      await repository.writeFile(timelineJsonPath, JSON.stringify(timeline, null, 2));
      console.log(`Updated ${timelineJsonPath} with new entry for ${originalFilename}`);

      // 5. Add and commit timeline.json (was step 4)
      await repository.add([timelineJsonPath]);
      console.log(`Staged ${timelineJsonPath}`);

      const timelineCommitResult = await repository.commit({
        message: `chore: Update timeline for FILE_UPLOAD of ${originalFilename}`,
      });

      if (!timelineCommitResult.success) {
        // If this commit fails, we might be in an inconsistent state.
        // For now, log and throw. Consider rollback or recovery strategies later.
        throw new Error(`Failed to commit ${timelineJsonPath} update: ${timelineCommitResult.message}`);
      }
      console.log(`Committed ${timelineJsonPath} update with SHA: ${timelineCommitResult.hash}`);

      return timelineEntry;

    } catch (error) {
      console.error(`Error in processNewUpload for ${originalFilename}:`, error);
      // Potentially clean up moved file if error occurs after move but before first commit?
      // For now, just rethrow.
      throw error;
    }
  }

  // New central input processing method
  async processInput(input: ProcessableInput): Promise<DocumentProcessingResult> {
    let rawFilePath: string | undefined;
    let rawFileOriginalName: string | undefined; // To store the original name for commit messages
    let processingMessage: string = 'Input processed.';
    let kbUpdateSuccess = false;
    let kbPath: string | undefined;
    let contentForLLM: string | undefined; // Variable to hold content for LLM

    try {
      const repository = this.repositoryManager.getRepository(input.repositoryId);
      // Set LLM Service context
      this.llmService.updateRepositoryPath(repository.path);

      const rawInputsDirRootPath = path.join(repository.path, '.lspace', 'raw_inputs');
      if (!fs.existsSync(rawInputsDirRootPath)) {
        fs.mkdirSync(rawInputsDirRootPath, { recursive: true });
      }
      
      let relativeRawFilePathForRepoWrite: string;

      switch (input.type) {
        case 'file_upload':
          const uniqueFileName = `${uuidv4()}-${input.fileName.replace(/[^a-zA-Z0-9_.-]/g, '')}`;
          relativeRawFilePathForRepoWrite = path.join('.lspace', 'raw_inputs', uniqueFileName);
          rawFileOriginalName = input.fileName; // Store original name
          await repository.writeFile(relativeRawFilePathForRepoWrite, input.content);
          rawFilePath = relativeRawFilePathForRepoWrite;
          contentForLLM = input.content; // Store content for LLM
          processingMessage = `File uploaded and saved to ${rawFilePath}`;
          break;

        case 'text_snippet':
          const snippetTitle = input.title ? input.title.replace(/[^a-zA-Z0-9_.-]/g, '') : 'snippet';
          const snippetFileName = `${uuidv4()}-${snippetTitle}.txt`;
          relativeRawFilePathForRepoWrite = path.join('.lspace', 'raw_inputs', snippetFileName);
          rawFileOriginalName = input.title || snippetFileName; // Store original name
          await repository.writeFile(relativeRawFilePathForRepoWrite, input.content);
          rawFilePath = relativeRawFilePathForRepoWrite;
          contentForLLM = input.content; // Store content for LLM
          processingMessage = `Text snippet saved to ${rawFilePath}`;
          break;

        case 'web_url':
          try {
            const response = await axios.get(input.url, { timeout: 10000 });
            let fetchedContent = response.data;
            if (typeof fetchedContent === 'object') {
              fetchedContent = JSON.stringify(fetchedContent, null, 2);
            }
            contentForLLM = String(fetchedContent); // Store content for LLM
            const safeHostname = new URL(input.url).hostname.replace(/[^a-zA-Z0-9_.-]/g, '');
            const urlFileName = `${uuidv4()}-url-${safeHostname}.txt`;
            relativeRawFilePathForRepoWrite = path.join('.lspace', 'raw_inputs', urlFileName);
            rawFileOriginalName = input.url; // Store original URL as name
            await repository.writeFile(relativeRawFilePathForRepoWrite, contentForLLM);
            rawFilePath = relativeRawFilePathForRepoWrite;
            processingMessage = `Content from ${input.url} fetched and saved to ${rawFilePath}`;
          } catch (error: any) {
            console.error(`Error fetching URL ${input.url}:`, error.message);
            return { knowledgeBaseUpdated: false, message: `Failed to fetch content from URL: ${error.message}` };
          }
          break;

        case 'chat_message':
          const chatLogsDirAbsPath = path.join(rawInputsDirRootPath, 'chat_logs');
          if (!fs.existsSync(chatLogsDirAbsPath)) {
            fs.mkdirSync(chatLogsDirAbsPath, { recursive: true });
          }
          const chatDirRelative = path.join('.lspace', 'raw_inputs', 'chat_logs', input.chatId.replace(/[^a-zA-Z0-9_.-]/g, ''));
          const absoluteChatDirForSpecificChat = path.join(repository.path, chatDirRelative);
          if (!fs.existsSync(absoluteChatDirForSpecificChat)) {
             fs.mkdirSync(absoluteChatDirForSpecificChat, { recursive: true });
          }
          const chatFileName = `${input.messageId.replace(/[^a-zA-Z0-9_.-]/g, '')}.json`;
          relativeRawFilePathForRepoWrite = path.join(chatDirRelative, chatFileName);
          const chatDataToSave = {
            messageId: input.messageId,
            text: input.text,
            timestamp: input.timestamp,
            user: input.user,
            metadata: input.metadata
          };
          contentForLLM = JSON.stringify(chatDataToSave, null, 2); // Store JSON string for LLM
          rawFileOriginalName = `chat-${input.chatId}-${input.messageId}`; // Store identifier
          await repository.writeFile(relativeRawFilePathForRepoWrite, contentForLLM);
          rawFilePath = relativeRawFilePathForRepoWrite;
          processingMessage = `Chat message ${input.messageId} saved to ${rawFilePath}`;
          break;

        default:
          console.warn('Unknown input type received by processInput');
          return { knowledgeBaseUpdated: false, message: 'Unknown input type' };
      }

      if (rawFilePath && contentForLLM) {
        // 1. Commit the raw input file
        const rawFileCommitMessage = `feat: Add raw input ${rawFileOriginalName || path.basename(rawFilePath)}`;
        console.log(`[OrchestratorService] Staging raw input file: ${rawFilePath}`);
        await repository.add([rawFilePath]); // Stage only the raw input file
        console.log(`[OrchestratorService] Committing raw input file: ${rawFilePath} with message: "${rawFileCommitMessage}"`);
        const rawFileCommitResult = await repository.commit({ message: rawFileCommitMessage }); // Commit staged file

        if (!rawFileCommitResult.success || !rawFileCommitResult.hash) {
          console.warn(`[OrchestratorService] Failed to commit raw input file ${rawFilePath}: ${rawFileCommitResult.message}`);
          // Decide if we should proceed or return an error - for now, log and continue, timeline won't have commit hash
        }

        // 2. Create and finalize timeline entry
        const timelineEntryDetails: Omit<TimelineEntry, 'id' | 'timestamp' | 'commit'> & { commit?: { id: string; message: string } } = {
          operation: 'add' as TimelineServiceOperationType,
          path: rawFilePath,
          title: rawFileOriginalName || path.basename(rawFilePath),
          user: input.user || 'system',
          category: input.metadata?.category || 'raw_input',
          tags: input.metadata?.tags || [],
        };
        if (rawFileCommitResult.success && rawFileCommitResult.hash) {
          timelineEntryDetails.commit = { id: rawFileCommitResult.hash, message: rawFileCommitMessage };
        }

        try {
            await this.timelineService.addEntry(repository, timelineEntryDetails); // addEntry now handles the commit details
            processingMessage += ' Timeline entry created.';
        } catch (timelineError: any) {
            console.warn(`Failed to add timeline entry for ${rawFilePath}: ${timelineError.message}`);
            processingMessage += ` Failed to create timeline entry: ${timelineError.message}.`;
        }
        
        console.log(`OrchestratorService: KB processing to be triggered for ${rawFilePath}`);
        let llmHistory: any[] = []; // To store LLM conversation history

        try {
          if (!contentForLLM) {
            throw new Error('Content for LLM processing is missing.');
          }
          // In synthesizeToKnowledgeBase, the LLMService's processDocumentConversational is called
          // which returns a history. We need to capture that.
          const kbProcessingResult = await this.llmService.synthesizeToKnowledgeBase(repository, rawFilePath, contentForLLM);
          
          // Assuming synthesizeToKnowledgeBase is modified or its caller (processDocumentConversational's result)
          // makes history available. Let's assume kbResult.history exists.
          // This is a temporary assumption based on how generateKnowledgeBaseSummary works.
          // Ideally, synthesizeToKnowledgeBase itself would return the history needed for the commit summary.
          // For now, we'll rely on the structure of LLMService.processDocumentConversational's return.
          // This might require an adjustment in LLMService or how its results are propagated up.
          
          // A more robust way would be for synthesizeToKnowledgeBase to return the history directly.
          // Let's assume for now it's { success: boolean, message?: string, kbPath?: string, history?: ConversationTurn[] }
          // This change is NOT YET MADE in llmService.ts for synthesizeToKnowledgeBase but is needed for the commit summary

          // TEMPORARY: Accessing history through a hypothetical direct call if synthesizeToKnowledgeBase doesn't return it
          // This is a placeholder for where you'd get the history. The actual implementation details might differ.
          // if (kbProcessingResult.success && this.llmService.getLastProcessingHistory) { 
          //   llmHistory = this.llmService.getLastProcessingHistory(); 
          // } 
          // For now, we assume kbResult.message contains the summary which is not ideal for a separate commit message.
          // The LLMService.generateKnowledgeBaseSummary expects the actual history.
          // This points to a needed refactor in how history is passed or retrieved after synthesizeToKnowledgeBase.

          // For the purpose of this edit, we will assume synthesizeToKnowledgeBase is updated to return history:
          // kbResult = { success: boolean, message?: string, kbPath?: string, history: ConversationTurn[] }
          // We'll use the message from kbResult for the commit for now, as history isn't directly returned from synthesizeToKnowledgeBase call above.

          if (kbProcessingResult.success) {
            kbUpdateSuccess = true;
            kbPath = kbProcessingResult.kbPath || 'README.md'; 
            processingMessage += ` Knowledge base updated. Main article: ${kbPath}.`;
            
            // 3. Commit KB Changes
            let kbCommitSummary = `KB update for ${rawFileOriginalName || path.basename(rawFilePath)}.`;
            if (kbProcessingResult.message && kbProcessingResult.message.includes("```markdown")) {
                // If the message contains the markdown summary, use that.
                kbCommitSummary = kbProcessingResult.message;
            } else if (kbProcessingResult.message) {
                kbCommitSummary += ` Details: ${kbProcessingResult.message}`;
            }
            
            // Get unstaged files (new or modified by LLM tools in the root)
            const unstagedKbFiles = await repository.getUnstagedFiles();
            if (unstagedKbFiles.length > 0) {
              console.log(`[OrchestratorService] Staging KB changes for files: ${unstagedKbFiles.join(', ')}`);
              await repository.add(unstagedKbFiles); 
              
              console.log(`[OrchestratorService] Committing KB changes with summary: ${kbCommitSummary.substring(0,100)}...`);
              const kbCommitResult = await repository.commit({ message: kbCommitSummary }); 
              if (!kbCommitResult.success) {
                  console.warn(`[OrchestratorService] Failed to commit KB changes for ${rawFilePath}: ${kbCommitResult.message}`);
                  processingMessage += ` Failed to commit KB changes: ${kbCommitResult.message}.`;
              } else {
                // Auto-push to remote if this is a GitHub repository
                try {
                  await this.repositoryManager.pushToRemote(input.repositoryId);
                  console.log(`[OrchestratorService] Successfully pushed changes to remote repository`);
                  processingMessage += ' Changes pushed to remote repository.';
                } catch (pushError: any) {
                  console.warn(`[OrchestratorService] Failed to push to remote: ${pushError.message}`);
                  processingMessage += ` Warning: Changes committed locally but failed to push to remote: ${pushError.message}`;
                }
              }
            } else {
              console.log(`[OrchestratorService] No unstaged KB files found to commit for ${rawFilePath}.`);
              processingMessage += ' No new KB changes detected to commit.';
            }

          } else {
            processingMessage += ` Knowledge base update failed or not applicable.`;
            if(kbProcessingResult.message) processingMessage += ` Details: ${kbProcessingResult.message}`;
          }
        } catch (kbError: any) {
            console.error(`Error during KB synthesis for ${rawFilePath}: ${kbError.message}`);
            processingMessage += ` Error during KB synthesis: ${kbError.message}`;
        }
        
        return { 
          knowledgeBaseUpdated: kbUpdateSuccess, 
          rawInputPath: rawFilePath, 
          message: processingMessage,
          knowledgeBasePath: kbPath 
        };
      } else {
        return { knowledgeBaseUpdated: false, message: processingMessage };
      }

    } catch (error: any) {
      console.error(`Error in OrchestratorService.processInput:`, error);
      return { knowledgeBaseUpdated: false, message: `Error processing input: ${error.message}` };
    }
  }

  // Remove the duplicate processDocument function that takes OrchestratorServiceRequestBody
  // and replace with a new method for processing raw files
  async processRawFile(requestBody: OrchestratorServiceRequestBody): Promise<OrchestratorServiceResponse> {
    const { repositoryId, content, filePath, fileName, user, inputType, url, metadata } = requestBody;
    const repository = this.repositoryManager.getRepository(repositoryId);
    // Set LLM Service context
    this.llmService.updateRepositoryPath(repository.path);

    let rawDocumentPathInRepo: string;
    let sourceDescription: string;
    let contentForLLMProcessing: string | undefined = content; // Initialize with provided content

    const rawInputsDir = path.join(repository.path, '.lspace', 'raw_inputs');
    if (!fs.existsSync(rawInputsDir)) {
      fs.mkdirSync(rawInputsDir, { recursive: true });
    }

    // This initial block for saving various inputs is now largely handled by the new `processInput` method.
    // If `processDocument` is called directly, it will still use this logic.
    // Eventually, this block should be removed, and processDocument should expect `filePath` to be a path in `/.lspace/raw_inputs/`.
    if (inputType === 'file' && content && fileName) {
      rawDocumentPathInRepo = path.join('.lspace', 'raw_inputs', `${uuidv4()}-${fileName.replace(/[^a-zA-Z0-9_.-]/g, '')}`);
      await repository.writeFile(rawDocumentPathInRepo, content);
      sourceDescription = fileName;
      contentForLLMProcessing = content;
    } else if (inputType === 'text' && content) {
      const title = metadata?.title ? metadata.title.replace(/[^a-zA-Z0-9_.-]/g, '') : 'text_snippet';
      rawDocumentPathInRepo = path.join('.lspace', 'raw_inputs', `${uuidv4()}-${title}.txt`);
      await repository.writeFile(rawDocumentPathInRepo, content);
      sourceDescription = title;
      contentForLLMProcessing = content;
    } else if (inputType === 'url' && url) {
      try {
        const response = await axios.get(url, { timeout: 10000 });
        let fetchedContent = response.data;
        if (typeof fetchedContent === 'object') fetchedContent = JSON.stringify(fetchedContent, null, 2);
        contentForLLMProcessing = String(fetchedContent);
        const safeHostname = new URL(url).hostname.replace(/[^a-zA-Z0-9_.-]/g, '');
        rawDocumentPathInRepo = path.join('.lspace', 'raw_inputs', `${uuidv4()}-url-${safeHostname}.txt`);
        await repository.writeFile(rawDocumentPathInRepo, contentForLLMProcessing);
        sourceDescription = url;
      } catch (error:any) {
        throw new Error(`Failed to fetch content from URL: ${error.message}`);
      }
    } else if (filePath) {
      rawDocumentPathInRepo = filePath;
      if (!rawDocumentPathInRepo.startsWith('.lspace/raw_inputs/')) {
        throw new Error('filePath for processing must be within /.lspace/raw_inputs/');
      }
      // IMPORTANT: If only filePath is provided, we MUST read the content for the LLM
      // This is a potential deviation from the new model where Orchestrator always provides content
      // However, processRawFile is being phased out, so this is a temporary measure.
      if (!contentForLLMProcessing) {
        console.warn(`[OrchestratorService.processRawFile] Content not provided for filePath ${rawDocumentPathInRepo}, reading it now. This flow should be avoided.`);
        contentForLLMProcessing = await repository.readFile(rawDocumentPathInRepo);
      }
      sourceDescription = path.basename(filePath);
    } else {
      throw new Error('Invalid input for processDocument.');
    }

    const timelineEntryDetails: Omit<TimelineEntry, 'id' | 'timestamp' | 'commit'> = {
      operation: 'add' as TimelineServiceOperationType, // Assuming 'add' for this flow
      path: rawDocumentPathInRepo,
      title: sourceDescription,
      user: user || 'system',
      category: metadata?.category || 'general_processing',
      tags: metadata?.tags || [],
      // `commit` is not added here as `timelineService.addEntry` doesn't handle it.
    };
    const timelineEntry = await this.timelineService.addEntry(repository, timelineEntryDetails);

    console.log(`OrchestratorService: LLM processing to be triggered for ${rawDocumentPathInRepo}`);
    let kbUpdateResult: { success: boolean; message?: string; kbPath?: string | undefined } = { success: false, message: "KB update not run.", kbPath: undefined };
    try {
      if (!contentForLLMProcessing) {
        throw new Error('Content for LLM processing is missing in processRawFile.');
      }
      // Assuming synthesizeToKnowledgeBase is the correct method.
      kbUpdateResult = await this.llmService.synthesizeToKnowledgeBase(repository, rawDocumentPathInRepo, contentForLLMProcessing);
    } catch (e: any) {
      console.error(`Error processing ${rawDocumentPathInRepo} with LLMService: ${e.message}`);
      kbUpdateResult.message = `Error during KB synthesis: ${e.message}`;
    }

    return {
      rawInputPath: rawDocumentPathInRepo,
      knowledgeBasePath: kbUpdateResult.kbPath || (kbUpdateResult.success ? 'README.md' : undefined), // Default to README.md if success but no path
      readmeUpdated: kbUpdateResult.success && (kbUpdateResult.kbPath === 'README.md' || !kbUpdateResult.kbPath), // Approximation
      title: sourceDescription,
      category: metadata?.category || 'general',
      tags: metadata?.tags || [],
      timelineEntry: timelineEntry, 
      message: kbUpdateResult.message || (kbUpdateResult.success ? 'Document processed and KB updated.' : 'Document processed, KB not updated.')
    };
  }

  // Future methods for incremental KB updates, full regen orchestration, etc.
}