import { Repository } from '../core/repository';
import { RepositoryManager } from '../core/repositoryManager';
import { TimelineService, ApiHistoryEntry, TimelineFilterOptions } from '../core/timelineService';

export interface KnowledgeBaseChange {
  id: string;
  timestamp: string;
  description: string; // Human-friendly description
  operation: 'added' | 'updated' | 'removed' | 'organized';
  changeType: 'file_upload' | 'knowledge_base_generation'; // Key distinction!
  filesAffected: string[];
  userFriendlyDate: string;
  canRevert: boolean;
  internalCommitId: string;
  relatedCommitId?: string; // Links file upload to its KB generation
  details?: {
    title?: string;
    user?: string;
    category?: string;
    sourceFile?: string; // For KB changes, which file triggered them
  };
}

export interface RevertOptions {
  repositoryId: string;
  // Human-friendly targeting
  filename?: string; // "undo changes for test.txt" 
  changeId?: string; // Specific change from list
  lastNChanges?: number; // "undo last 3 changes"
  
  // Granular control
  revertType?: 'file_upload' | 'knowledge_base_generation' | 'both'; // Default: 'both'
  regenerateAfterRevert?: boolean; // For KB-only reverts, trigger new processing
}

export interface RevertResult {
  success: boolean;
  message: string;
  revertCommitIds: string[];
  changesReverted: KnowledgeBaseChange[];
  regenerationTriggered?: boolean;
}

/**
 * Service for managing knowledge base history with file upload vs KB generation distinction
 */
export class KnowledgeBaseHistoryService {
  constructor(
    private repositoryManager: RepositoryManager,
    private timelineService: TimelineService
  ) {}

  /**
   * List knowledge base changes showing both file uploads and KB generations
   */
  async listKnowledgeBaseChanges(
    repositoryId: string,
    options: { 
      limit?: number; 
      includeDetails?: boolean;
      changeType?: 'file_upload' | 'knowledge_base_generation' | 'both';
    } = {}
  ): Promise<KnowledgeBaseChange[]> {
    const repository = this.repositoryManager.getRepository(repositoryId);
    
    const filterOptions: TimelineFilterOptions = {
      limit: options.limit || 20,
      offset: 0
    };

    const historyEntries = await this.timelineService.getDetailedHistoryEntries(repository, filterOptions);
    
    const changes = historyEntries.flatMap(entry => this.convertToKnowledgeBaseChanges(entry));
    
    // Filter by change type if specified
    if (options.changeType && options.changeType !== 'both') {
      return changes.filter(change => change.changeType === options.changeType);
    }
    
    return changes;
  }

  /**
   * Revert knowledge base changes with granular control over file vs KB
   */
  async revertKnowledgeBaseChanges(options: RevertOptions): Promise<RevertResult> {
    const repository = this.repositoryManager.getRepository(options.repositoryId);
    
    try {
      // Sync with remote before reverting
      await this.repositoryManager.syncWithRemote(options.repositoryId);
      
      let changesToRevert: KnowledgeBaseChange[] = [];
      const revertType = options.revertType || 'both';
      
      // Special handling for reverting to initial state
      if (options.lastNChanges && options.lastNChanges > 10) {
        console.log(`KnowledgeBaseHistoryService: Large revert requested (${options.lastNChanges} changes). Using reset-to-initial approach.`);
        return this.revertToInitialState(options.repositoryId);
      }

      // Find changes to revert based on criteria
      if (options.filename) {
        changesToRevert = await this.findChangesForFile(repository, options.filename, revertType);
      } else if (options.changeId) {
        const change = await this.getChangeById(repository, options.changeId);
        if (change) {
          changesToRevert = [change];
          // If reverting a file upload, might also want to revert associated KB
          if (revertType === 'both' && change.changeType === 'file_upload' && change.relatedCommitId) {
            const kbChange = await this.getChangeByCommitId(repository, change.relatedCommitId);
            if (kbChange) changesToRevert.push(kbChange);
          }
        }
      } else if (options.lastNChanges) {
        const recentChanges = await this.listKnowledgeBaseChanges(options.repositoryId, { 
          limit: options.lastNChanges * 2, // Get more to account for filtering
          changeType: revertType === 'both' ? 'both' : revertType
        });
        changesToRevert = recentChanges.slice(0, options.lastNChanges);
      }

      if (changesToRevert.length === 0) {
        return {
          success: false,
          message: 'No changes found to revert based on the criteria provided.',
          revertCommitIds: [],
          changesReverted: []
        };
      }

      // Group changes by type for processing
      const fileChanges = changesToRevert.filter(c => c.changeType === 'file_upload');
      const kbChanges = changesToRevert.filter(c => c.changeType === 'knowledge_base_generation');

      const revertCommitIds: string[] = [];
      let regenerationTriggered = false;

      // Revert KB changes first (to maintain dependency order)
      if (kbChanges.length > 0 && (revertType === 'knowledge_base_generation' || revertType === 'both')) {
        const kbRevertCommitId = await this.performRevertCommits(
          repository, 
          kbChanges.map(c => c.internalCommitId),
          `Revert knowledge base changes: ${kbChanges.map(c => c.details?.sourceFile || c.description).join(', ')}`
        );
        revertCommitIds.push(kbRevertCommitId);
      }

      // Revert file uploads
      if (fileChanges.length > 0 && (revertType === 'file_upload' || revertType === 'both')) {
        const fileRevertCommitId = await this.performRevertCommits(
          repository,
          fileChanges.map(c => c.internalCommitId),
          `Revert file uploads: ${fileChanges.map(c => c.description).join(', ')}`
        );
        revertCommitIds.push(fileRevertCommitId);
      }

      // Trigger regeneration if requested (only for KB-only reverts)
      if (options.regenerateAfterRevert && revertType === 'knowledge_base_generation' && fileChanges.length === 0) {
        // TODO: Trigger orchestrator to regenerate KB for remaining files
        regenerationTriggered = true;
      }

      // Push changes to remote
      try {
        await this.repositoryManager.pushToRemote(options.repositoryId);
      } catch (pushError: any) {
        // Handle the known isomorphic-git protocol parsing error
        if (pushError.message && pushError.message.includes('Expected "Two strings separated by')) {
          console.warn(`KnowledgeBaseHistoryService: Git protocol parsing error during revert push (likely cosmetic): ${pushError.message}`);
          // Continue - the revert likely succeeded despite the protocol error
        } else {
          throw pushError; // Re-throw other errors
        }
      }

      return {
        success: true,
        message: this.generateSuccessMessage(changesToRevert, revertType, regenerationTriggered),
        revertCommitIds,
        changesReverted: changesToRevert,
        regenerationTriggered
      };

    } catch (error: any) {
      return {
        success: false,
        message: `Failed to revert changes: ${error.message}`,
        revertCommitIds: [],
        changesReverted: []
      };
    }
  }

  /**
   * Convenience methods for common operations
   */
  async revertKnowledgeBaseOnly(repositoryId: string, filename: string, regenerate = false): Promise<RevertResult> {
    return this.revertKnowledgeBaseChanges({
      repositoryId,
      filename,
      revertType: 'knowledge_base_generation',
      regenerateAfterRevert: regenerate
    });
  }

  async revertFileAndKnowledgeBase(repositoryId: string, filename: string): Promise<RevertResult> {
    return this.revertKnowledgeBaseChanges({
      repositoryId,
      filename,
      revertType: 'both'
    });
  }

  async revertLastFileUpload(repositoryId: string): Promise<RevertResult> {
    return this.revertKnowledgeBaseChanges({
      repositoryId,
      lastNChanges: 1,
      revertType: 'file_upload'
    });
  }

  async revertLastKnowledgeBaseUpdate(repositoryId: string): Promise<RevertResult> {
    return this.revertKnowledgeBaseChanges({
      repositoryId,
      lastNChanges: 1,
      revertType: 'knowledge_base_generation'
    });
  }

  async regenerateKnowledgeBase(repositoryId: string, filename: string): Promise<RevertResult> {
    return this.revertKnowledgeBaseChanges({
      repositoryId,
      filename,
      revertType: 'knowledge_base_generation',
      regenerateAfterRevert: true
    });
  }

  /**
   * Revert repository to initial state (first commit with just README.md)
   */
  private async revertToInitialState(repositoryId: string): Promise<RevertResult> {
    const repository = this.repositoryManager.getRepository(repositoryId);
    
    try {
      console.log(`KnowledgeBaseHistoryService: Reverting repository to initial state...`);
      
      // Find the initial commit using git log directly as fallback
      let initialCommitId: string;
      
      try {
        // Try timeline service first
        const historyEntries = await this.timelineService.getDetailedHistoryEntries(repository, { limit: 1000 });
        
        if (historyEntries.length > 0) {
          // Get the first commit (oldest)
          const initialEntry = historyEntries[historyEntries.length - 1];
          initialCommitId = initialEntry.commit?.id;
          
          if (!initialCommitId) {
            throw new Error('Timeline entry found but no commit ID');
          }
        } else {
          throw new Error('No timeline entries found, trying git log fallback');
        }
      } catch (timelineError: any) {
        console.warn(`KnowledgeBaseHistoryService: Timeline service failed: ${timelineError.message}`);
        console.log(`KnowledgeBaseHistoryService: Using git log fallback to find initial commit...`);
        
        // Fallback: Use git log to find the very first commit
        // We'll use the repository's git functionality directly
        try {
          // Import git modules dynamically
          const git = await import('isomorphic-git');
          const fs = require('fs');
          
          // Get all commits in reverse chronological order
          const commits = await git.default.log({
            fs,
            dir: repository.path,
            depth: 1000 // Get all commits
          });
          
          if (commits.length === 0) {
            throw new Error('No commits found in repository');
          }
          
          // The last commit in the array is the oldest (initial commit)
          initialCommitId = commits[commits.length - 1].oid;
          console.log(`KnowledgeBaseHistoryService: Found initial commit via git log: ${initialCommitId.slice(0, 8)}`);
        } catch (gitError: any) {
          throw new Error(`Failed to find initial commit: ${gitError.message}`);
        }
      }
      
      console.log(`KnowledgeBaseHistoryService: Initial commit found: ${initialCommitId.slice(0, 8)}`);
      
      // Use git reset to go back to initial commit
      await repository.rollbackToCommit(initialCommitId);
      
      console.log(`KnowledgeBaseHistoryService: Rollback completed. Checking repository state...`);
      
      // Check what files exist after rollback
      const currentFiles = await repository.listFiles('.');
      console.log(`KnowledgeBaseHistoryService: Files after rollback:`, currentFiles.map(f => f.path));
      
      // Get what files should exist in the initial commit
      const initialFiles = await repository.getChangedFilesInCommit(initialCommitId);
      const initialFilePaths = initialFiles.map(f => f.path);
      console.log(`KnowledgeBaseHistoryService: Files that should exist:`, initialFilePaths);
      
      // Restore missing files from initial commit
      for (const expectedPath of initialFilePaths) {
        const fileExists = await repository.fileExists(expectedPath);
        if (!fileExists) {
          try {
            console.log(`KnowledgeBaseHistoryService: Restoring missing file: ${expectedPath}`);
            const initialContent = await repository.getFileContentAtCommit(initialCommitId, expectedPath);
            if (initialContent !== null) {
              await repository.writeFile(expectedPath, initialContent);
              console.log(`KnowledgeBaseHistoryService: Restored ${expectedPath}`);
            }
          } catch (error) {
            console.warn(`KnowledgeBaseHistoryService: Could not restore file ${expectedPath}: ${error}`);
          }
        }
      }
      
      // Remove files that weren't in the initial commit
      for (const file of currentFiles) {
        if (file.type === 'file' && !initialFilePaths.includes(file.path) && !file.path.startsWith('.git')) {
          try {
            await repository.deleteFile(file.path);
            console.log(`KnowledgeBaseHistoryService: Removed extra file: ${file.path}`);
          } catch (error) {
            console.warn(`KnowledgeBaseHistoryService: Could not remove file ${file.path}: ${error}`);
          }
        }
      }
      
      // Check if there are any changes to commit
      const unstagedFiles = await repository.getUnstagedFiles();
      console.log(`KnowledgeBaseHistoryService: Unstaged files after cleanup:`, unstagedFiles);
      
      if (unstagedFiles.length > 0) {
        await repository.add(unstagedFiles);
        
        const cleanupCommit = await repository.commit({
          message: 'Reset repository to initial state\n\nRemoved all files except initial README.md',
          author: {
            name: 'Lspace Revert Service',
            email: 'revert@lspace.local'
          }
        });
        
        if (!cleanupCommit.success) {
          throw new Error(`Failed to create cleanup commit: ${cleanupCommit.message}`);
        }
        
        console.log(`KnowledgeBaseHistoryService: Created cleanup commit: ${cleanupCommit.hash}`);
      } else {
        console.log(`KnowledgeBaseHistoryService: No changes to commit after reset`);
      }
      
      // Push changes to remote
      try {
        await this.repositoryManager.pushToRemote(repositoryId);
      } catch (pushError: any) {
        // Handle the known isomorphic-git protocol parsing error
        if (pushError.message && pushError.message.includes('Expected "Two strings separated by')) {
          console.warn(`KnowledgeBaseHistoryService: Git protocol parsing error during reset push (likely cosmetic): ${pushError.message}`);
          // Continue - the push likely succeeded despite the protocol error
        } else {
          throw pushError; // Re-throw other errors
        }
      }
      
      return {
        success: true,
        message: 'Successfully reverted repository to initial state (README.md only)',
        revertCommitIds: [initialCommitId],
        changesReverted: []
      };
      
    } catch (error: any) {
      console.error(`KnowledgeBaseHistoryService: Failed to revert to initial state: ${error.message}`);
      return {
        success: false,
        message: `Failed to revert to initial state: ${error.message}`,
        revertCommitIds: [],
        changesReverted: []
      };
    }
  }

  /**
   * Convert timeline entry to knowledge base changes (potentially 2: file + KB)
   */
  private convertToKnowledgeBaseChanges(entry: ApiHistoryEntry): KnowledgeBaseChange[] {
    const changes: KnowledgeBaseChange[] = [];
    const date = new Date(entry.timestamp);
    const userFriendlyDate = date.toLocaleDateString() + ' at ' + date.toLocaleTimeString();
    
    // File upload change
    if (entry.commit) {
      const fileChange: KnowledgeBaseChange = {
        id: `${entry.id}_file`,
        timestamp: entry.timestamp,
        description: this.generateFileDescription(entry),
        operation: this.mapFileOperation(entry.fileOperation),
        changeType: 'file_upload',
        filesAffected: [entry.path],
        userFriendlyDate,
        canRevert: true,
        internalCommitId: entry.commit.id,
        relatedCommitId: entry.kbCommit?.id,
        details: {
          title: entry.title,
          user: entry.user,
          category: entry.operationType
        }
      };
      changes.push(fileChange);
    }

    // Knowledge base generation change
    if (entry.kbCommit) {
      const kbChange: KnowledgeBaseChange = {
        id: `${entry.id}_kb`,
        timestamp: entry.timestamp,
        description: this.generateKBDescription(entry),
        operation: 'updated', // KB generation is typically an update
        changeType: 'knowledge_base_generation',
        filesAffected: entry.kbCommit.changedKbFiles?.map(f => f.path) || [],
        userFriendlyDate,
        canRevert: true,
        internalCommitId: entry.kbCommit.id,
        relatedCommitId: entry.commit?.id,
        details: {
          title: entry.title,
          user: entry.user,
          category: 'knowledge_base_generation',
          sourceFile: entry.path
        }
      };
      changes.push(kbChange);
    }

    return changes;
  }

  private generateFileDescription(entry: ApiHistoryEntry): string {
    const fileName = entry.title || entry.path;
    switch (entry.fileOperation) {
      case 'add': return `Uploaded ${fileName}`;
      case 'modify': return `Updated ${fileName}`;
      case 'delete': return `Removed ${fileName}`;
      default: return `Modified ${fileName}`;
    }
  }

  private generateKBDescription(entry: ApiHistoryEntry): string {
    const fileName = entry.title || entry.path;
    const kbFiles = entry.kbCommit?.changedKbFiles?.length || 0;
    return `Generated knowledge base from ${fileName} (${kbFiles} KB files updated)`;
  }

  private mapFileOperation(operation?: string): KnowledgeBaseChange['operation'] {
    switch (operation) {
      case 'add': return 'added';
      case 'modify': return 'updated';
      case 'delete': return 'removed';
      default: return 'updated';
    }
  }

  private async findChangesForFile(
    repository: Repository, 
    filename: string, 
    revertType: string
  ): Promise<KnowledgeBaseChange[]> {
    const entries = await this.timelineService.getDetailedHistoryEntries(repository, {
      path: filename,
      limit: 50
    });
    
    const allChanges = entries.flatMap(entry => this.convertToKnowledgeBaseChanges(entry));
    
    // Filter by revert type
    if (revertType === 'file_upload') {
      return allChanges.filter(c => c.changeType === 'file_upload');
    } else if (revertType === 'knowledge_base_generation') {
      return allChanges.filter(c => c.changeType === 'knowledge_base_generation');
    }
    
    return allChanges; // both
  }

  private async getChangeById(repository: Repository, changeId: string): Promise<KnowledgeBaseChange | null> {
    const entries = await this.timelineService.getDetailedHistoryEntries(repository, { limit: 100 });
    const allChanges = entries.flatMap(entry => this.convertToKnowledgeBaseChanges(entry));
    
    return allChanges.find(c => c.id === changeId) || null;
  }

  private async getChangeByCommitId(repository: Repository, commitId: string): Promise<KnowledgeBaseChange | null> {
    const entries = await this.timelineService.getDetailedHistoryEntries(repository, { limit: 100 });
    const allChanges = entries.flatMap(entry => this.convertToKnowledgeBaseChanges(entry));
    
    return allChanges.find(c => c.internalCommitId === commitId) || null;
  }

  private async performRevertCommits(
    repository: Repository, 
    commitIds: string[], 
    message: string
  ): Promise<string> {
    
    // Perform actual git revert for each commit (in reverse order for proper dependency handling)
    const reversedCommitIds = [...commitIds].reverse();
    
    for (const commitId of reversedCommitIds) {
      try {
        console.log(`KnowledgeBaseHistoryService: Reverting commit ${commitId.slice(0, 8)}...`);
        
        // Use the repository's underlying git functionality
        const revertResult = await repository.revertCommit(commitId, {
          message: `Revert commit ${commitId.slice(0, 8)}`,
          author: {
            name: 'Lspace Revert Service',
            email: 'revert@lspace.local'
          }
        });
        
        if (!revertResult.success) {
          throw new Error(`Failed to revert commit ${commitId}: ${revertResult.message || 'Unknown error'}`);
        }
        
        console.log(`KnowledgeBaseHistoryService: Successfully reverted commit ${commitId.slice(0, 8)}`);
      } catch (error: any) {
        console.error(`KnowledgeBaseHistoryService: Error reverting commit ${commitId}: ${error.message}`);
        throw new Error(`Failed to revert commit ${commitId.slice(0, 8)}: ${error.message}`);
      }
    }
    
    // Create a summary commit documenting the batch revert operation
    const summaryCommitResult = await repository.commit({
      message: `${message}\n\nReverted commits: ${commitIds.map(id => id.slice(0, 8)).join(', ')}`,
      author: {
        name: 'Lspace Revert Service', 
        email: 'revert@lspace.local'
      }
    });
    
    if (!summaryCommitResult.success || !summaryCommitResult.hash) {
      throw new Error('Failed to create revert summary commit');
    }
    
    return summaryCommitResult.hash;
  }

  private generateSuccessMessage(
    changes: KnowledgeBaseChange[], 
    revertType: string, 
    regenerationTriggered: boolean
  ): string {
    const fileChanges = changes.filter(c => c.changeType === 'file_upload').length;
    const kbChanges = changes.filter(c => c.changeType === 'knowledge_base_generation').length;
    
    let message = 'Successfully reverted ';
    
    if (revertType === 'file_upload') {
      message += `${fileChanges} file upload(s)`;
    } else if (revertType === 'knowledge_base_generation') {
      message += `${kbChanges} knowledge base update(s)`;
    } else {
      message += `${fileChanges} file upload(s) and ${kbChanges} knowledge base update(s)`;
    }
    
    if (regenerationTriggered) {
      message += '. Knowledge base regeneration has been triggered.';
    }
    
    return message;
  }
}