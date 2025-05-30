import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Repository } from './repository';
import { FileChangeInfo } from './types/commonTypes';

/**
 * Timeline entry type
 */
export type OperationType = 'add' | 'update' | 'delete' | 'move' | 'organize' | 'prune';

/**
 * Timeline entry interface
 */
export interface TimelineEntry {
  id: string;
  timestamp: string;
  operation: OperationType;
  path: string;
  title?: string;
  user?: string;
  category?: string;
  tags?: string[];
  commit?: {
    id: string;
    message: string;
  };
}

/**
 * Timeline data structure
 */
export interface Timeline {
  entries: TimelineEntry[];
}

/**
 * Options for filtering timeline entries
 */
export interface TimelineFilterOptions {
  operation?: OperationType;
  user?: string;
  category?: string;
  tag?: string;
  path?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

/**
 * Timeline pagination result
 */
export interface TimelinePage {
  total: number;
  limit: number;
  offset: number;
  entries: TimelineEntry[];
}

// Define the structure for the API response, similar to frontend's expectation
export interface ApiHistoryEntry {
  id: string; // TimelineEntry.id
  operationType: OperationType; // TimelineEntry.operation (e.g. 'add', 'organize') - this is the high-level operation
  fileOperation?: 'add' | 'modify' | 'delete'; // Git operation on the specific file
  path: string; // TimelineEntry.path
  title: string; // TimelineEntry.title or filename
  user?: string; // TimelineEntry.user
  timestamp: string; // TimelineEntry.timestamp
  commit: { // Details of the file upload commit
    id: string; // commit hash
    message: string; // commit message
  };
  content?: string | null; // Current content of TimelineEntry.path for this commit
  previousContent?: string | null; // Previous content of TimelineEntry.path (for modify/delete)
  kbCommit?: { 
    id: string; 
    message: string; 
    changedKbFiles?: FileChangeInfo[];
  } | null;
  operation: string; // for the badge, derived from fileOperation or operationType
}

/**
 * Service for managing repository timeline tracking
 */
export class TimelineService {
  private static readonly TIMELINE_PATH = '.lspace/timeline.json';
  private dataDir = path.join(process.cwd(), '.lspace');
  
  /**
   * Prepare a new entry without committing it to the timeline file.
   * This is used for the two-phase commit process to consolidate commits.
   */
  public async prepareEntry(
    repository: Repository,
    entry: Omit<TimelineEntry, 'id' | 'timestamp' | 'commit'>
  ): Promise<TimelineEntry> {
    // Only log operations for files within the 'raw/' directory
    // or if the operation itself is not path-specific but relates to raw content
    if (!entry.path || !entry.path.startsWith('raw/')) {
      console.log(`TimelineService: Note - preparing entry for path "${entry.path}" which is not in raw/`);
    }

    // Create the full entry with ID and timestamp, but without commit info yet
    const preparedEntry: TimelineEntry = {
      ...entry,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    };
    
    return preparedEntry;
  }
  
  /**
   * Finalize a prepared entry by adding commit information and saving it to the timeline.
   */
  public async finalizeEntry(
    repository: Repository,
    preparedEntry: TimelineEntry,
    commitInfo: { id: string; message: string }
  ): Promise<TimelineEntry> {
    // Add commit info to the prepared entry
    const finalEntry: TimelineEntry = {
      ...preparedEntry,
      commit: commitInfo
    };
    
    // Get the current timeline
    const timeline = await this.getTimeline(repository);
    
    // Add the new entry
    timeline.entries.push(finalEntry);
    
    // Save the updated timeline
    await this.saveTimeline(repository, timeline);
    
    return finalEntry;
  }
  
  /**
   * Add a new entry to the repository timeline if it pertains to 'raw/' files.
   * This is maintained for backward compatibility.
   */
  public async addEntry(
    repository: Repository,
    entry: Omit<TimelineEntry, 'id' | 'timestamp'>
  ): Promise<TimelineEntry | null> {
    // Only log operations for files within the '.lspace/raw_inputs/' directory
    // or if the operation itself is not path-specific but relates to raw content (future consideration)
    // For now, strictly check the path.
    if (!entry.path || !entry.path.startsWith('.lspace/raw_inputs/')) {
      // If path is not provided or doesn't start with '.lspace/raw_inputs/', do not log.
      console.log(`TimelineService: Skipping entry for path "${entry.path}" (operation "${entry.operation}") as it is not in /.lspace/raw_inputs/.`);
      return null; 
    }

    // Create the full entry with ID and timestamp
    const fullEntry: TimelineEntry = {
      ...entry,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    };
    
    // Get the current timeline
    const timeline = await this.getTimeline(repository);
    
    // Add the new entry
    timeline.entries.push(fullEntry);
    
    // Save the updated timeline
    await this.saveTimeline(repository, timeline);
    
    return fullEntry;
  }
  
  /**
   * Get a paginated list of timeline entries with optional filtering
   */
  public async getEntries(
    repository: Repository,
    options: TimelineFilterOptions = {}
  ): Promise<TimelinePage> {
    // Get the full timeline
    const timeline = await this.getTimeline(repository);
    
    // Apply filters
    let filteredEntries = timeline.entries;
    
    if (options.operation) {
      filteredEntries = filteredEntries.filter(entry => entry.operation === options.operation);
    }
    
    if (options.user) {
      filteredEntries = filteredEntries.filter(entry => entry.user === options.user);
    }
    
    if (options.category) {
      filteredEntries = filteredEntries.filter(entry => entry.category === options.category);
    }
    
    if (options.tag) {
      filteredEntries = filteredEntries.filter(entry => 
        entry.tags?.includes(options.tag as string)
      );
    }
    
    if (options.path) {
      filteredEntries = filteredEntries.filter(entry => entry.path === options.path);
    }
    
    if (options.startDate) {
      const startDate = new Date(options.startDate).getTime();
      filteredEntries = filteredEntries.filter(entry => 
        new Date(entry.timestamp).getTime() >= startDate
      );
    }
    
    if (options.endDate) {
      const endDate = new Date(options.endDate).getTime();
      filteredEntries = filteredEntries.filter(entry => 
        new Date(entry.timestamp).getTime() <= endDate
      );
    }
    
    // Sort entries by timestamp (newest first)
    filteredEntries.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    
    // Apply pagination
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    const paginatedEntries = filteredEntries.slice(offset, offset + limit);
    
    return {
      total: filteredEntries.length,
      limit,
      offset,
      entries: paginatedEntries
    };
  }
  
  /**
   * Get a specific timeline entry by ID
   */
  public async getEntry(
    repository: Repository,
    entryId: string
  ): Promise<TimelineEntry | null> {
    const timeline = await this.getTimeline(repository);
    return timeline.entries.find(entry => entry.id === entryId) || null;
  }
  
  /**
   * Get the full timeline for a repository
   */
  private async getTimeline(repository: Repository): Promise<Timeline> {
    try {
      // Check if the timeline file exists
      const timelineExists = await repository.fileExists(TimelineService.TIMELINE_PATH);
      
      if (timelineExists) {
        // Read the existing timeline
        const timelineContent = await repository.readFile(TimelineService.TIMELINE_PATH);
        return JSON.parse(timelineContent) as Timeline;
      }
      
      // If the file doesn't exist, create an empty timeline
      return { entries: [] };
    } catch (error) {
      console.error('Error reading timeline:', error);
      // Return an empty timeline on error
      return { entries: [] };
    }
  }
  
  /**
   * Save the timeline to the repository
   */
  private async saveTimeline(repository: Repository, timeline: Timeline): Promise<void> {
    try {
      // Ensure the .lspace directory exists
      const dirPath = path.dirname(TimelineService.TIMELINE_PATH);
      const dirExists = await repository.fileExists(dirPath);
      
      if (!dirExists) {
        // Create necessary directories by writing a placeholder and then removing it
        const placeholderPath = path.join(dirPath, '.placeholder');
        await repository.writeFile(placeholderPath, '');
        await repository.deleteFile(placeholderPath);
      }
      
      // Write the timeline file
      const timelineContent = JSON.stringify(timeline, null, 2);
      await repository.writeFile(TimelineService.TIMELINE_PATH, timelineContent);
      
      // Don't commit here - the commit should be handled by the calling code
      // to ensure the timeline is committed along with the main operation
    } catch (error) {
      console.error('Error saving timeline:', error);
      throw new Error('Failed to save timeline');
    }
  }

  public async getDetailedHistoryEntries(
    repository: Repository,
    options: TimelineFilterOptions = {}
  ): Promise<ApiHistoryEntry[]> {
    const timelinePage = await this.getEntries(repository, options);
    const detailedEntries: ApiHistoryEntry[] = [];

    for (const entry of timelinePage.entries) {
      if (!entry.commit || !entry.path) {
        console.warn(`Skipping timeline entry ${entry.id} due to missing commit or path.`);
        continue;
      }

      let diffInfo: { currentContent: string | null; previousContent: string | null; operation: 'add' | 'modify' | 'delete' } | null = null;
      let kbCommitData: ApiHistoryEntry['kbCommit'] = null;

      try {
        diffInfo = await repository.getFileDiffForCommit(entry.commit.id, entry.path);
        
        // Try to find related KB commit
        const sourceFilename = path.basename(entry.path);
        // Assuming KB commits are authored by 'BeeContext Orchestrator' as seen in Repository.ts default commit author
        // or specific author from llmService if that differs.
        // For now, let's try with a common author or leave it undefined if not strictly set.
        const kbCommitLogEntry = await repository.findRelatedKbCommit(sourceFilename, entry.commit.id, 'BeeContext Orchestrator');

        if (kbCommitLogEntry) {
          const changedKbFiles: FileChangeInfo[] = await repository.getChangedFilesInCommit(kbCommitLogEntry.oid);
          kbCommitData = {
            id: kbCommitLogEntry.oid,
            message: kbCommitLogEntry.commit.message,
            changedKbFiles: changedKbFiles
          };
        }
        
        detailedEntries.push({
          id: entry.id,
          operationType: entry.operation,
          fileOperation: diffInfo.operation,
          path: entry.path,
          title: entry.title || sourceFilename,
          user: entry.user,
          timestamp: entry.timestamp,
          commit: entry.commit, // Raw file commit
          content: diffInfo.currentContent,
          previousContent: diffInfo.previousContent,
          kbCommit: kbCommitData, // Populated KB commit data
          operation: diffInfo.operation || entry.operation, // For the badge
        });
      } catch (error) {
        console.error(`Failed to get full diff details for entry ${entry.id}, path ${entry.path}, commit ${entry.commit.id}:`, error);
        detailedEntries.push({
          id: entry.id,
          operationType: entry.operation,
          // fileOperation will be undefined or from partially successful diffInfo
          fileOperation: diffInfo?.operation,
          path: entry.path,
          title: entry.title || path.basename(entry.path),
          user: entry.user,
          timestamp: entry.timestamp,
          commit: entry.commit,
          content: diffInfo?.currentContent || null,
          previousContent: diffInfo?.previousContent || null,
          kbCommit: null, // Error occurred, so no KB commit data
          operation: diffInfo?.operation || entry.operation,
        });
      }
    }
    return detailedEntries;
  }

  async findFileUploadCommit(repository: Repository, sourceFilePath: string): Promise<string | null> {
    try {
      // getEntries returns a TimelinePage object
      const timelinePage = await this.getEntries(repository, { path: sourceFilePath, operation: 'add' });
      
      // Entries are loaded newest first by getEntries default sort (if any, or by push order)
      // We are looking for an 'add' operation with the specific path.
      // The filter in getEntries options should help narrow this down, but we double check.
      for (const entry of timelinePage.entries) {
        // Ensure it's the exact path and operation, though filters should handle this.
        if (entry.operation === 'add' && entry.path === sourceFilePath) {
          if (entry.commit?.id) { // commitId is nested under commit.id as per TimelineEntry
            console.log(`[TimelineService] Found file upload commit for ${sourceFilePath} in repo ${repository.path}: ${entry.commit.id}`);
            return entry.commit.id;
          }
        }
      }
      console.log(`[TimelineService] No file upload commit found for ${sourceFilePath} in repo ${repository.path}`);
      return null;
    } catch (error) {
      console.error(`[TimelineService] Error finding file upload commit for ${sourceFilePath} in repo ${repository.path}:`, error);
      return null; 
    }
  }

  public async addChatAssistantCommitEntry(
    repository: Repository,
    commitInfo: { id: string; message: string },
    summary: string, // LLM's summary of actions
    userId: string = 'Chat Assistant' // Or the actual user ID if available
  ): Promise<TimelineEntry | null> {
    // Try to infer operation and path from summary
    let operation: OperationType = 'update'; // Default operation
    let entryPath: string = 'knowledge-base/'; // Default path

    // Basic inference logic (can be improved)
    const lowerSummary = summary.toLowerCase();
    if (lowerSummary.includes('move') || lowerSummary.includes('rename') || lowerSummary.includes('organize')) {
      operation = 'organize'; 
    } else if (lowerSummary.includes('delete') || lowerSummary.includes('remove')) {
      operation = 'delete';
    } else if (lowerSummary.includes('create') || lowerSummary.includes('add') || lowerSummary.includes('write')) {
      operation = 'add';
    }
    // TODO: More sophisticated path extraction if possible, e.g. from LLM tool call args if available here

    const entry: Omit<TimelineEntry, 'id' | 'timestamp'> = {
      operation: operation,
      path: entryPath, 
      title: summary, 
      user: userId,
      commit: commitInfo,
    };

    const fullEntry: TimelineEntry = {
      ...entry,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
    };

    const timeline = await this.getTimeline(repository);
    // Add to the beginning of the array so newest entries are first before explicit sort in getEntries
    timeline.entries.unshift(fullEntry);
    await this.saveTimeline(repository, timeline);
    console.log(`[TimelineService] Added chat assistant commit entry: ${fullEntry.id} for commit ${commitInfo.id}`);
    return fullEntry;
  }
}