import fs from 'fs'; // Import Node.js fs module
import pathLib from 'path'; // Node.js path module
import { FileChangeOperation, FileChangeInfo } from './types/commonTypes'; // Import shared type

// Dynamically import ES Modules
const gitPromise = import('isomorphic-git');
const httpPromise = import('isomorphic-git/http/node/index.cjs');

/**
 * Interface for repository operations
 */
export interface CommitResult {
  success: boolean;
  hash: string;
  message?: string;
}

export interface CommitOptions {
  message: string;
  author?: {
    name: string;
    email: string;
  };
}

export interface FileStatus {
  path: string;
  staged: boolean;
  modified: boolean;
  added: boolean;
  deleted: boolean;
}

export interface RepositoryStatus {
  branch: string;
  files: FileStatus[];
}

export interface FileInfo {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  lastModified?: Date;
}

/**
 * Repository class provides a unified interface for git operations
 * regardless of the underlying git provider
 */
export class Repository {
  path: string; // Absolute path to the repository working directory
  private gitdir: string; // Path to .git directory
  private static git: any; // To store the resolved git module
  private static http: any; // To store the resolved http module

  constructor(repoPath: string) {
    this.path = pathLib.resolve(repoPath); // Ensure absolute path
    this.gitdir = pathLib.join(this.path, '.git');
    // TODO: Consider a check here if this.path is a valid git repository
  }

  // Helper to ensure git and http modules are loaded
  private static async ensureGitModulesLoaded() {
    if (!Repository.git) {
      Repository.git = (await gitPromise).default; 
    }
    if (!Repository.http) {
      // Assuming http/node might not have a default export, or might be the module itself
      const httpModule = await httpPromise;
      Repository.http = httpModule.default || httpModule; 
    }
  }

  private getGitFs(): any {
    return { fs }; // isomorphic-git uses an fs object
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const absoluteFilePath = pathLib.resolve(this.path, filePath);
    const dir = pathLib.dirname(absoluteFilePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(absoluteFilePath, content, 'utf8');
    // No git add here by default, staging is a separate step.
  }

  async readFile(filePath: string): Promise<string> {
    const absoluteFilePath = pathLib.resolve(this.path, filePath);
    if (!await this.fileExists(filePath)) { // Check relative path for consistency
        throw new Error(`File not found: ${filePath} in repository ${this.path}`);
    }
    return fs.promises.readFile(absoluteFilePath, 'utf8');
  }

  async add(filePaths: string[]): Promise<void> {
    await Repository.ensureGitModulesLoaded();
    try {
      for (const filepath of filePaths) { // isomorphic-git add might support array directly, but loop for safety/clarity
        await Repository.git.add({
          ...this.getGitFs(),
          dir: this.path,
          filepath: filepath,
        });
      }
    } catch (e: any) {
      console.error('Git add failed:', e);
      throw new Error(`Git add failed: ${e.message}`);
    }
  }

  async commit(options: CommitOptions): Promise<CommitResult> {
    await Repository.ensureGitModulesLoaded();
    try {
      const authorDetails = options.author || {
        name: 'BeeContext Orchestrator', // Default author
        email: 'orchestrator@beecontext.dev' // Default email
      };
      
      // Ensure the message is a string, even if types should guarantee it.
      let commitMessage = options.message;
      if (typeof options.message !== 'string') {
        console.warn(`[Repository.commit] Commit message was not a string (type: ${typeof options.message}, value: ${options.message}). Defaulting to empty string.`);
        commitMessage = '';
      }

      // Ensure author name and email are strings
      let finalAuthorName = authorDetails.name;
      if (typeof authorDetails.name !== 'string') {
        console.warn(`[Repository.commit] Author name was not a string (type: ${typeof authorDetails.name}, value: ${authorDetails.name}). Defaulting to 'Default Author'.`);
        finalAuthorName = 'Default Author'; // Fallback name
      }

      let finalAuthorEmail = authorDetails.email;
      if (typeof authorDetails.email !== 'string') {
        console.warn(`[Repository.commit] Author email was not a string (type: ${typeof authorDetails.email}, value: ${authorDetails.email}). Defaulting to 'default@example.com'.`);
        finalAuthorEmail = 'default@example.com'; 
      }

      const sha = await Repository.git.commit({
        ...this.getGitFs(),
        dir: this.path,
        message: commitMessage,
        author: {
          name: finalAuthorName,
          email: finalAuthorEmail,
        },
        signingKey: '', // Keep explicitly disabling signing attempts
      });
      return { success: true, hash: sha, message: commitMessage }; 
    } catch (e: any) {
      console.error('Git commit failed:', e);
      return { success: false, hash: '', message: e.message };
    }
  }

  async getStatus(): Promise<RepositoryStatus> {
    await Repository.ensureGitModulesLoaded();
    // This is a more complex method to implement fully with isomorphic-git statusMatrix and listFiles
    // For now, a simplified placeholder or a more targeted status might be better.
    // const status = await Repository.git.statusMatrix({ ...this.getGitFs(), dir: this.path });
    // TODO: Convert statusMatrix to FileStatus[] and get current branch
    const currentBranch = await Repository.git.currentBranch({ ...this.getGitFs(), dir: this.path, fullname: false });
    return {
        branch: currentBranch || 'unknown',
        files: [] // Placeholder for file statuses
    };
    // throw new Error('Method not implemented');
  }

  async listFiles(directoryPath: string = '.'): Promise<FileInfo[]> {
    const absoluteDirPath = pathLib.resolve(this.path, directoryPath);
    const entries = await fs.promises.readdir(absoluteDirPath, { withFileTypes: true });
    const fileInfos: FileInfo[] = [];
    for (const entry of entries) {
        const entryPath = pathLib.join(directoryPath, entry.name);
        const stats = await fs.promises.stat(pathLib.join(absoluteDirPath, entry.name));
        fileInfos.push({
            path: entryPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            lastModified: stats.mtime
        });
    }
    return fileInfos;
  }

  async listAllFilesRecursive(startPath: string = '.'): Promise<FileInfo[]> {
    const allFileInfos: FileInfo[] = [];
    const queue: string[] = [startPath];

    while (queue.length > 0) {
      const currentPath = queue.shift()!;
      const absoluteCurrentPath = pathLib.resolve(this.path, currentPath);

      try {
        const entries = await fs.promises.readdir(absoluteCurrentPath, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = pathLib.join(currentPath, entry.name);
          // Skip .git and .lspace directories explicitly at any level
          if (entry.name === '.git' || entry.name === '.lspace') {
            continue;
          }

          const stats = await fs.promises.stat(pathLib.join(absoluteCurrentPath, entry.name));
          const fileInfo: FileInfo = {
            path: entryPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            lastModified: stats.mtime,
          };

          if (fileInfo.type === 'directory') {
            allFileInfos.push(fileInfo); // Add directory info itself
            queue.push(entryPath); // Add directory to queue for further processing
          } else {
            allFileInfos.push(fileInfo); // Add file info
          }
        }
      } catch (error: any) {
        // Log error but continue if a directory is not readable, etc.
        console.warn(`[Repository.listAllFilesRecursive] Error reading directory ${currentPath}: ${error.message}`);
      }
    }
    return allFileInfos;
  }

  async fileExists(filePath: string): Promise<boolean> {
    const absoluteFilePath = pathLib.resolve(this.path, filePath);
    try {
      await fs.promises.access(absoluteFilePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const absoluteFilePath = pathLib.resolve(this.path, filePath);
    
    // Check if path exists and is a file
    try {
      const stats = await fs.promises.lstat(absoluteFilePath);
      if (stats.isDirectory()) {
        throw new Error(`Path is a directory, not a file. Use a different method to delete directories: ${filePath}`);
      }
      // If it's not a directory, and lstat didn't throw, it's likely a file or symlink.
    } catch (statError: any) {
      // If lstat fails (e.g., file doesn't exist), let unlink handle it or throw specific error.
      if (statError.code === 'ENOENT') {
        console.warn(`[Repository.deleteFile] File not found for deletion: ${filePath}`);
        // We might still want to attempt `git.remove` if it was tracked and deleted from FS by other means.
      } else {
        throw new Error(`Error accessing path ${filePath} before deletion: ${statError.message}`);
      }
    }

    try {
      await fs.promises.unlink(absoluteFilePath);
      console.log(`[Repository.deleteFile] Successfully unlinked: ${filePath}`);
    } catch (unlinkError: any) {
      // If unlink fails, it might be because the file didn't exist, or other permission issues.
      // If it didn't exist, that's fine, git.remove might still be needed for tracked files.
      if (unlinkError.code !== 'ENOENT') {
        console.warn(`[Repository.deleteFile] fs.promises.unlink failed for ${filePath}: ${unlinkError.message}. Proceeding with git remove attempt.`);
      } else {
        console.log(`[Repository.deleteFile] File ${filePath} did not exist on filesystem. Proceeding with git remove attempt.`);
      }
    }
    
    await Repository.ensureGitModulesLoaded();
    try {
      await Repository.git.remove({
        ...this.getGitFs(),
        dir: this.path,
        filepath: filePath, 
      });
      console.log(`[Repository.deleteFile] Successfully performed git remove for: ${filePath}`);
    } catch (gitRemoveError:any) {
        console.warn(`[Repository.deleteFile] Git remove failed for ${filePath}. This can be normal if the file was not tracked or already removed from index. Error: ${gitRemoveError.message}`);
    }
  }

  async moveFile(fromPath: string, toPath: string): Promise<void> {
    const absoluteFromPath = pathLib.resolve(this.path, fromPath);
    const absoluteToPath = pathLib.resolve(this.path, toPath);
    await fs.promises.mkdir(pathLib.dirname(absoluteToPath), { recursive: true });
    await fs.promises.rename(absoluteFromPath, absoluteToPath);
    // TODO: git mv logic (often rm old + add new)
  }
  
  // Placeholder for getCommitDiff - to be implemented next
  async getCommitDiff(commitSha: string): Promise<string> {
    await Repository.ensureGitModulesLoaded();
    // Placeholder implementation, as full git show style diff is complex
    // This could list changed files as a starting point
    try {
      const commit = await Repository.git.readCommit({ ...this.getGitFs(), dir: this.path, oid: commitSha });
      // For a more detailed diff, you'd compare trees (commit.tree vs parentCommit.tree)
      // This is just a very basic representation.
      let diffOutput = `Commit: ${commit.oid}\nAuthor: ${commit.commit.author.name} <${commit.commit.author.email}>\nDate: ${new Date(commit.commit.author.timestamp * 1000).toISOString()}\n\n${commit.commit.message}\n\n`;
      // To get changed files, you would typically compare this commit's tree with its parent's tree.
      // For simplicity, we are not doing that here. Placeholder for changed files:
      diffOutput += `Changed files (placeholder):\n- file1.txt\n+ file2.txt\n`;
      return diffOutput;
    } catch (e: any) {
      console.error(`Failed to read commit ${commitSha} for diff:`, e);
      return `Error generating diff for commit ${commitSha}: ${e.message}`;
    }
  }

  async ensureDirectoryExists(path: string): Promise<void> {
    const absolutePath = pathLib.resolve(this.path, path);
    await fs.promises.mkdir(absolutePath, { recursive: true });
  }

  // Method to be used by ChatAssistantService for its create_directory tool
  async createDirectory(directoryPath: string): Promise<void> {
    await this.ensureDirectoryExists(directoryPath);
  }

  async deleteDirectory(directoryPath: string): Promise<void> {
    const absoluteDirPath = pathLib.resolve(this.path, directoryPath);

    // Check if the path exists and is a directory
    try {
      const stats = await fs.promises.lstat(absoluteDirPath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${directoryPath}`);
      }
    } catch (statError: any) {
      if (statError.code === 'ENOENT') {
        console.warn(`[Repository.deleteDirectory] Directory not found: ${directoryPath}`);
        return; // Not an error if it doesn't exist, treat as success
      } else {
        throw new Error(`Error accessing path ${directoryPath} before deletion: ${statError.message}`);
      }
    }

    // Check if directory is empty
    const entries = await fs.promises.readdir(absoluteDirPath);
    if (entries.length > 0) {
      throw new Error(`Directory not empty: ${directoryPath}. Cannot delete non-empty directory.`);
    }

    // If empty, remove it
    await fs.promises.rmdir(absoluteDirPath);
    console.log(`[Repository.deleteDirectory] Successfully deleted empty directory: ${directoryPath}`);
    // Note: No direct git operation here. If files within were git tracked and deleted prior,
    // the directory will become untracked and effectively removed from git status if it was empty.
    // If the directory itself was explicitly tracked while empty (unusual), this doesn't 'git rm' it.
    // This method is for cleaning up empty directories from the working tree.
  }

  // New method to encapsulate add and commit for ChatAssistantService
  async commitChanges(filePaths: string[], message: string, author: { name: string, email: string }): Promise<CommitResult> {
    if (filePaths.length > 0) {
      await this.add(filePaths);
    }
    // If no filePaths, it might be a commit for a deletion that was already `git rm`ed.
    // Or, if git.commit supports empty commits with a flag (isomorphic-git does not by default).
    // For now, proceed to commit. If nothing is staged and it's not an empty commit, it might error or be a no-op.
    // Isomorphic-git commit will throw if there are no changes staged unless `allowEmpty` is true.
    // We should check if there are staged changes before attempting to commit if filePaths is empty.

    // Let's check actual staged files to prevent error on commit if nothing changed.
    // This is a simplified status check. A full `isomorphic-git.statusMatrix` is more comprehensive.
    let hasStagedChanges = false;
    if (filePaths.length > 0) {
        // If we specifically added files, assume they are staged if add didn't throw.
        hasStagedChanges = true; 
    }
    // TODO: A more robust check for staged changes might be needed if filePaths can be empty
    // (e.g. for a commit after only deletions where `git.remove` was used).
    // For now, if filePaths is empty, we risk an error if `git.remove` didn't stage anything
    // or if we want to support empty commits (which we don't by default here).

    if (!hasStagedChanges && filePaths.length === 0) {
        // Check if there are any staged changes in the repo at all
        // This is a bit more involved with isomorphic-git, involves statusMatrix
        // For now, we will assume if filePaths is empty, it's likely due to deletions.
        // If `git.remove` stages changes, this commit will proceed.
        // If not, and there are no other staged changes, `git.commit` will throw.
        // This is an area to refine for robustness if empty commits or deletion-only commits are common.
        console.log("[Repository.commitChanges] No file paths provided for add, proceeding to commit. This relies on prior `git rm` staging changes.");
        // To be safer, one could call `Repository.git.statusMatrix` and check for staged items.
        // For this iteration, we proceed.
        hasStagedChanges = true; // Assume `git rm` handled staging or allow potential error for now.
    }

    if (hasStagedChanges) {
        return this.commit({ message, author });
    } else {
        console.log("[Repository.commitChanges] No changes to commit.");
        return { success: true, hash: 'NO_CHANGES', message: 'No changes to commit' };
    }
  }

  async getFileContentAtCommit(commitSha: string, filePath: string): Promise<string | null> {
    await Repository.ensureGitModulesLoaded();
    try {
      const result = await Repository.git.readBlob({
        ...this.getGitFs(),
        dir: this.path,
        oid: commitSha,
        filepath: filePath,
      });

      if (result && typeof result.blob !== 'undefined') {
        try {
          const contentStr = Buffer.from(result.blob as any).toString('utf8');
          return contentStr;
        } catch (bufferError: any) {
            console.warn(`[Repository.getFileContentAtCommit] Buffer.from failed for ${filePath} at ${commitSha}. Error: ${bufferError.message}. Content from result.blob was:`, result.blob);
            return null; 
        }
      } else {
        return null; 
      }

    } catch (error: any) {
      console.warn(`[Repository.getFileContentAtCommit] Error caught for ${filePath} at ${commitSha}: ${error.message}`, error.code ? `Code: ${error.code}` : '');
      if (error.code === 'NotFoundError' || 
          error.message.includes('TreeEntry.mode') || 
          error.message.includes('not a valid blob oid') ||
          error.message.includes('Could not expand')) { // Added common isomorphic-git error
         return null;
      }
      console.error(`[Repository.getFileContentAtCommit] Unexpected error reading blob for ${filePath} at ${commitSha}:`, error);
      throw error; // Re-throw unexpected errors
    }
  }

  async getChangedFilesInCommit(commitSha: string): Promise<FileChangeInfo[]> {
    await Repository.ensureGitModulesLoaded();
    const fs = this.getGitFs().fs; // Get the fs module for isomorphic-git

    try {
      const commit = await Repository.git.readCommit({ fs, dir: this.path, oid: commitSha });
      const currentTreeOid = commit.commit.tree;
      const parentOids = commit.commit.parent;

      const changes: FileChangeInfo[] = [];

      if (!parentOids || parentOids.length === 0) {
        // Initial commit, all files are 'added'
        // We need to list all files in the current tree
        const walk = Repository.git.TREE({
          fs,
          dir: this.path,
          ref: commitSha, // or currentTreeOid
        });
        let count = 0;
        for await (const entry of walk) {
          if (entry.type === 'blob') {
            changes.push({ path: entry.path, status: 'add' });
          }
          if (++count > 1000) { // Safety break for very large trees
            console.warn('Walked over 1000 entries in initial commit, breaking.');
            break;
          }
        }
        return changes;
      }

      // For simplicity, we'll compare against the first parent for non-merge commits.
      // Merge commits (parentOids.length > 1) diffing is more complex and can be enhanced later.
      const parentCommitOid = parentOids[0];
      const parentCommit = await Repository.git.readCommit({ fs, dir: this.path, oid: parentCommitOid });
      const parentTreeOid = parentCommit.commit.tree;
      
      // Use isomorphic-git.walk to compare the two trees
      // The Treewalker emits events for each entry in the tree.
      // We need to compare the entries from two walkers or use a specific diff function if available.
      // Isomorphic-git's `walk` is powerful. We use two of them and compare.

      const compareOids = (a?: string, b?: string) => a === b;

      await Repository.git.walk({
        fs,
        dir: this.path,
        trees: [Repository.git.TREE({ ref: parentTreeOid }), Repository.git.TREE({ ref: currentTreeOid })],
        map: async function(filepath: string, entries: any[]) {
          // `entries` is an array of `WalkerEntry` objects. `null` if the file doesn't exist in a tree.
          // entries[0] is from parentTree, entries[1] is from currentTree
          const [parentEntry, currentEntry] = entries;

          if (parentEntry && !currentEntry) {
            // File was in parent but not in current -> deleted
            if (parentEntry.type === 'blob') changes.push({ path: filepath, status: 'delete' });
          } else if (!parentEntry && currentEntry) {
            // File was not in parent but is in current -> added
            if (currentEntry.type === 'blob') changes.push({ path: filepath, status: 'add' });
          } else if (parentEntry && currentEntry) {
            // File exists in both, check if modified
            if (parentEntry.type === 'blob' && currentEntry.type === 'blob') {
              const parentOid = await parentEntry.oid();
              const currentOid = await currentEntry.oid();
              if (!compareOids(parentOid, currentOid)) {
                changes.push({ path: filepath, status: 'modify' });
              }
            }
            // Note: This doesn't directly handle type changes (e.g. file to symlink) but focuses on blob content changes.
          }
          return null; // Not returning anything specific from map
        }
      });

      return changes;
    } catch (error: any) {
      console.error(`Error getting changed files for commit ${commitSha}:`, error);
      // throw error; // Re-throw if you want to propagate, or return empty for graceful degradation
      return []; // Return empty array on error to prevent crashes upstream
    }
  }

  async getFileDiffForCommit(commitSha: string, filePath: string): Promise<{ currentContent: string | null; previousContent: string | null; operation: 'add' | 'modify' | 'delete' }> {
    await Repository.ensureGitModulesLoaded();
    const fs = this.getGitFs().fs;

    let currentContent: string | null = null;
    let previousContent: string | null = null;
    let operation: 'add' | 'modify' | 'delete';

    try {
      currentContent = await this.getFileContentAtCommit(commitSha, filePath);

      const commitData = await Repository.git.readCommit({ fs, dir: this.path, oid: commitSha });
      
      if (!commitData || !commitData.commit) {
        console.error(`[Repository] readCommit for ${commitSha} did not return expected commit object.`);
        previousContent = null; 
      } else {
        const parentOids = commitData.commit.parent;
        if (parentOids && parentOids.length > 0) {
          const parentSha = parentOids[0];
          previousContent = await this.getFileContentAtCommit(parentSha, filePath);
        } else {
          previousContent = null;
        }
      }

      if (currentContent !== null && previousContent === null) {
        operation = 'add';
      } else if (currentContent === null && previousContent !== null) {
        operation = 'delete';
      } else if (currentContent !== null && previousContent !== null && currentContent !== previousContent) {
        operation = 'modify';
      } else if (currentContent !== null && previousContent !== null && currentContent === previousContent) {
        // Content is the same, but it might have been part of a commit due to mode change or other reasons.
        // For the purpose of content diff, we can consider it 'modify' if it was part of changed files,
        // or perhaps a new status like 'unchanged_in_commit'.
        // For now, if contents are identical, we won't explicitly mark it as 'modify' unless other logic does.
        // This function is about the *content* diff. If it's in getChangedFilesInCommit, it's a change.
        // If both current and prev content exist and are same, the higher level service will decide.
        // For this function, let's be strict: if content is same, it's not a modify from content perspective.
        // However, the frontend expects an operation. If getChangedFilesInCommit said it's modified (e.g. mode change),
        // then 'modify' is appropriate. Let's assume for now if both exist, it's a modify.
        operation = 'modify'; // Default to modify if both exist, even if content is same (could be mode change)
      } else {
        // Both are null (file never existed or was deleted and then this commit doesn't re-add)
        // This case should ideally not happen if we call this only for files reported by getChangedFilesInCommit.
        // For safety, assign a default or throw.
        // To satisfy the type, let's assign delete if current is null, add if previous is null.
        // This situation implies the file path provided was not actually part of the changes in this commit
        // in a way that affects its content from parent to child state.
        throw new Error(`Cannot determine operation for ${filePath} in ${commitSha}: currentContent is ${currentContent}, previousContent is ${previousContent}`);
      }

    } catch (error: any) {
      console.error(`Error getting file diff for ${filePath} in commit ${commitSha}:`, error);
      // Re-throw or return a specific error object
      throw error;
    }
    
    return { currentContent, previousContent, operation };
  }

  async findRelatedKbCommit(
    sourceFilename: string,
    sourceCommitSha?: string, // Optional: can be used as a starting point or for recency
    authorName?: string,    // Optional: to filter by KB commit author
    maxCommitsToSearch: number = 20, // Search a reasonable number of recent commits
    // How far back to look in general if sourceCommitSha is not provided or useful.
    // Depth for the git log. isomorphic-git log defaults to a depth of 500 if not specified.
    logDepth: number = 50 // If sourceCommitSha is used, depth might be less relevant here.
  ): Promise<any | null> { // Return type can be more specific, like isomorphic-git's commit object type
    await Repository.ensureGitModulesLoaded();
    const fs = this.getGitFs().fs;

    // Regex to match KB commit messages related to the source filename
    // Escape special characters in sourceFilename for regex
    const escapedSourceFilename = sourceFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kbCommitMessagePattern1 = new RegExp(`Knowledge Base Update: ${escapedSourceFilename}`);
    const kbCommitMessagePattern2 = new RegExp(`feat\(kb\): Ingest .*${escapedSourceFilename}`);
    // A more generic pattern if the above are too specific, or for other KB related ops
    const genericKbPattern = new RegExp(`KB update for.*${escapedSourceFilename}`, 'i');

    try {
      const commits = await Repository.git.log({
        fs,
        dir: this.path,
        depth: maxCommitsToSearch, // Limit the number of commits to search
        // ref: 'HEAD' // Search from HEAD backwards, or specify a branch
        // If sourceCommitSha is provided, we ideally want commits *after* it,
        // but `log` typically goes backwards. For simplicity, we search recent commits from HEAD.
        // More advanced: if sourceCommitSha, get its date, then filter log for commits after that date.
      });

      for (const commit of commits) {
        const commitMessage = commit.commit.message;
        // Check author if specified
        if (authorName && commit.commit.author.name !== authorName) {
          continue;
        }

        if (kbCommitMessagePattern1.test(commitMessage) || 
            kbCommitMessagePattern2.test(commitMessage) ||
            genericKbPattern.test(commitMessage)) {
          // Potential optimization: If sourceCommitSha is known, ensure this found commit
          // is indeed *after* or very close to the sourceCommitSha chronologically if possible,
          // or that it's not an older, unrelated KB commit for the same file.
          // For now, first match by message and filename is returned.
          return commit; // commit is an isomorphic-git commit object
        }
      }
      return null; // No related KB commit found within the search depth
    } catch (error) {
      console.error(`Error finding related KB commit for ${sourceFilename}:`, error);
      return null;
    }
  }

  async findCommitBeforeFileUpload(uploadCommitSha: string): Promise<string | null> {
    await Repository.ensureGitModulesLoaded();
    const isoGitFs = this.getGitFs().fs;
    const dir = this.path;

    try {
      const commitData = await Repository.git.readCommit({ 
        fs: isoGitFs, 
        dir: dir, 
        oid: uploadCommitSha 
      });

      // --- BEGIN ADDED DEBUG LOGGING ---
      console.log(`[Repository] Raw commitData for ${uploadCommitSha}:`, JSON.stringify(commitData, null, 2));
      if (commitData && commitData.commit) {
        console.log(`[Repository] Commit object for ${uploadCommitSha}:`, JSON.stringify(commitData.commit, null, 2));
        console.log(`[Repository] Commit parents for ${uploadCommitSha}:`, JSON.stringify(commitData.commit.parent, null, 2));
        console.log(`[Repository] Number of parents for ${uploadCommitSha}:`, commitData.commit.parent ? commitData.commit.parent.length : 'undefined');
      } else {
        console.log(`[Repository] commitData or commitData.commit is null/undefined for ${uploadCommitSha}`);
      }
      // --- END ADDED DEBUG LOGGING ---

      if (commitData && commitData.commit && commitData.commit.parent && commitData.commit.parent.length > 0) {
        const parentSha = commitData.commit.parent[0];
        console.log(`[Repository] Found parent commit ${parentSha} for upload commit ${uploadCommitSha}`);
        return parentSha;
      } else {
        console.log(`[Repository] No parent commit found for ${uploadCommitSha} (it might be the initial commit).`);
        return null;
      }
    } catch (error: any) {
      console.error(`[Repository] Error reading commit ${uploadCommitSha} to find its parent:`, error);
      // Rethrow or handle as appropriate, e.g., return null if commit not found
      if (error.code === 'NotFoundError') {
        return null;
      }
      throw new Error(`Failed to find commit before file upload (for ${uploadCommitSha}): ${error.message}`);
    }
  }

  async rollbackToCommit(commitSha: string): Promise<void> {
    await Repository.ensureGitModulesLoaded(); // Ensure Repository.git is loaded
    const nodeFs = fs; // Alias for Node.js fs module for clarity in cleaning
    const isoGitFs = this.getGitFs().fs; // FS for isomorphic-git operations
    const dir = this.path;

    console.log(`[Repository] Attempting to roll back to commit: ${commitSha} in ${dir}`);

    try {
      let currentBranch: string | undefined;
      try {
        currentBranch = await Repository.git.currentBranch({ fs: isoGitFs, dir, fullname: false });
        console.log(`[Repository] Current branch: ${currentBranch}`);
      } catch (e) {
        console.log('[Repository] Not on a branch or failed to get current branch.');
      }

      console.log(`[Repository] Checking out commit ${commitSha} with force...`);
      await Repository.git.checkout({
        fs: isoGitFs,
        dir,
        ref: commitSha,
        force: true,
        noUpdateHead: false,
      });
      console.log(`[Repository] Checkout to ${commitSha} successful.`);

      if (currentBranch) {
        console.log(`[Repository] Updating branch ${currentBranch} to point to ${commitSha}...`);
        await Repository.git.branch({
          fs: isoGitFs,
          dir,
          ref: currentBranch,
          object: commitSha,
          force: true,
        });
        console.log(`[Repository] Branch ${currentBranch} updated.`);
      } else {
         console.log('[Repository] HEAD is now detached at the target commit.');
      }

      console.log('[Repository] Cleaning untracked files and directories...');
      const matrix = await Repository.git.statusMatrix({ fs: isoGitFs, dir });
      const untrackedFilePaths: string[] = [];

      for (const [filepath, head, workdir, stage] of matrix) {
        const isUntracked = head === 0 && stage === 0;
        if (isUntracked) {
          untrackedFilePaths.push(filepath);
        }
      }

      for (const relativePath of untrackedFilePaths) {
        const absolutePath = pathLib.join(dir, relativePath);
        try {
          const stats = await nodeFs.promises.lstat(absolutePath);
          if (stats.isDirectory()) {
            console.log(`[Repository] Removing untracked directory: ${relativePath}`);
            await nodeFs.promises.rm(absolutePath, { recursive: true, force: true });
          } else {
            console.log(`[Repository] Removing untracked file: ${relativePath}`);
            await nodeFs.promises.unlink(absolutePath);
          }
        } catch (cleanError: any) {
          console.error(`[Repository] Error cleaning path ${relativePath}: ${cleanError.message}`);
        }
      }
      console.log('[Repository] Untracked files and directories cleaned.');
      console.log(`[Repository] Rollback to commit ${commitSha} completed successfully.`);

    } catch (error: any) {
      console.error(`[Repository] Error during rollback to commit ${commitSha}:`, error);
      throw new Error(`Failed to rollback to commit ${commitSha}: ${error.message}`);
    }
  }

  /**
   * Get a list of unstaged files (new, modified, deleted in working tree).
   * This helps determine what to stage before a commit.
   * Status codes from isomorphic-git.statusMatrix:
   * Head (index 0): 0 = absent, 1 = normal
   * Workdir (index 1): 0 = absent, 1 = identical to head, 2 = modified, 3 = new
   * Stage (index 2): 0 = absent, 1 = normal (same as HEAD), 2 = new/modified from HEAD, 3 = deleted from HEAD
   */
  async getUnstagedFiles(): Promise<string[]> {
    await Repository.ensureGitModulesLoaded();
    const unstagedFiles: string[] = [];
    try {
      const matrix = await Repository.git.statusMatrix({ ...this.getGitFs(), dir: this.path });
      // console.log("[Repository.getUnstagedFiles] Status Matrix:", matrix);
      for (const [filepath, head, workdir, stage] of matrix) {
        // Workdir status: 2 = modified, 3 = new (untracked)
        // We also consider files that are deleted in workdir but still in index (head=1, workdir=0, stage can be 1 or 3)
        // or files deleted in workdir that were modified in index (head=1, workdir=0, stage=2)
        const isNewInWorkdir = workdir === 3; // New, untracked
        const isModifiedInWorkdir = workdir === 2; // Modified, not staged
        const isDeletedInWorkdir = head === 1 && workdir === 0; // Deleted from workdir, was tracked

        // We are interested in files that have changes in the working directory that are not yet staged for commit.
        // This includes new files, modified files, and files deleted from the working directory.
        if (isNewInWorkdir || isModifiedInWorkdir || isDeletedInWorkdir) {
          // For files deleted from workdir, git.add will effectively stage the deletion.
          unstagedFiles.push(filepath);
        }
      }
      // console.log("[Repository.getUnstagedFiles] Found unstaged files:", unstagedFiles);
      return unstagedFiles;
    } catch (e: any) {
      console.error('[Repository.getUnstagedFiles] Error getting status matrix:', e);
      throw new Error(`Failed to get unstaged files: ${e.message}`);
    }
  }

  /**
   * Revert a specific commit using git revert (creates a new commit that undoes the changes)
   */
  async revertCommit(commitSha: string, options: CommitOptions): Promise<CommitResult> {
    await Repository.ensureGitModulesLoaded();
    const { fs } = this.getGitFs();
    
    try {
      console.log(`[Repository] Reverting commit ${commitSha.slice(0, 8)}...`);
      
      // Get the commit details
      const commit = await Repository.git.readCommit({ fs, dir: this.path, oid: commitSha });
      const parentSha = commit.commit.parent[0];
      
      if (!parentSha) {
        throw new Error('Cannot revert the initial commit (no parent)');
      }
      
      // Get the changes introduced by this commit
      const changes = await this.getChangedFilesInCommit(commitSha);
      
      // For each file that was changed, revert it to the parent state
      for (const change of changes) {
        if (change.status === 'add') {
          // File was added - delete it
          if (await this.fileExists(change.path)) {
            await this.deleteFile(change.path);
            console.log(`[Repository] Deleted file ${change.path} (was added in commit)`);
          }
        } else if (change.status === 'delete') {
          // File was deleted - restore it from parent
          try {
            const parentContent = await this.getFileContentAtCommit(parentSha, change.path);
            if (parentContent !== null) {
              await this.writeFile(change.path, parentContent);
              console.log(`[Repository] Restored file ${change.path} (was deleted in commit)`);
            }
          } catch (error) {
            console.warn(`[Repository] Could not restore deleted file ${change.path}: ${error}`);
          }
        } else if (change.status === 'modify') {
          // File was modified - restore parent version
          try {
            const parentContent = await this.getFileContentAtCommit(parentSha, change.path);
            if (parentContent !== null) {
              await this.writeFile(change.path, parentContent);
              console.log(`[Repository] Reverted file ${change.path} to parent state`);
            }
          } catch (error) {
            console.warn(`[Repository] Could not revert modified file ${change.path}: ${error}`);
          }
        }
      }
      
      // Stage all changes
      const modifiedFiles = await this.getUnstagedFiles();
      if (modifiedFiles.length > 0) {
        await this.add(modifiedFiles);
      }
      
      // Create the revert commit
      const revertMessage = options.message || `Revert "${commit.commit.message.split('\n')[0]}"`;
      const commitResult = await this.commit({
        message: revertMessage,
        author: options.author || {
          name: 'Lspace Revert Service',
          email: 'revert@lspace.local'
        }
      });
      
      console.log(`[Repository] Successfully reverted commit ${commitSha.slice(0, 8)}`);
      return commitResult;
      
    } catch (error: any) {
      console.error(`[Repository] Error reverting commit ${commitSha}: ${error.message}`);
      return {
        success: false,
        hash: '',
        message: `Failed to revert commit: ${error.message}`
      };
    }
  }
}