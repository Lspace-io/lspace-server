import fs from 'fs';
import path from 'path';
// import * as git from 'isomorphic-git'; // Changed to dynamic import
import { Repository, CommitResult, RepositoryStatus, FileStatus, FileInfo, CommitOptions } from '../core/repository';

const gitPromise = import('isomorphic-git');

/**
 * LocalGitAdapter handles git operations for repositories stored on the local filesystem
 */
export class LocalGitAdapter {
  /**
   * Initialize a local git repository
   * @param repoPath Path to the repository on the local filesystem
   * @returns Repository instance
   */
  async initialize(repoPath: string): Promise<Repository> {
    const git = (await gitPromise).default; // Load for this method
    // Ensure the directory exists
    if (!fs.existsSync(repoPath)) {
      fs.mkdirSync(repoPath, { recursive: true });
    }

    // Check if it's already a git repository
    const isRepo = fs.existsSync(path.join(repoPath, '.git'));
    
    if (!isRepo) {
      // Initialize a new git repository
      await git.init({ fs, dir: repoPath });
    }

    // Ensure .lspace directory exists for internal use
    const lspacePath = path.join(repoPath, '.lspace');
    if (!fs.existsSync(lspacePath)) {
      fs.mkdirSync(lspacePath, { recursive: true });
    }

    // Create and return a repository instance
    return new LocalRepository(repoPath);
  }
}

/**
 * LocalRepository implementation for repositories on the local filesystem
 */
class LocalRepository extends Repository {
  private readonly fs = fs;
  // private readonly git = git; // Replaced by static loaded module
  private static isoGit: any; // To store the resolved git module

  constructor(repoPath: string) {
    super(repoPath);
  }

  // Helper to ensure git module is loaded
  private static async ensureGitModuleLoaded() {
    if (!LocalRepository.isoGit) {
      LocalRepository.isoGit = (await gitPromise).default;
    }
  }

  /**
   * Write a file to the repository
   * @param filePath Path to the file (relative to the repository root)
   * @param content File content
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    // Ensure the directory exists
    const fullPath = path.join(this.path, filePath);
    const directory = path.dirname(fullPath);
    
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    
    // Write the file
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  /**
   * Read a file from the repository
   * @param filePath Path to the file (relative to the repository root)
   * @returns File content
   */
  async readFile(filePath: string): Promise<string> {
    const fullPath = path.join(this.path, filePath);
    
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    return fs.readFileSync(fullPath, 'utf8');
  }

  /**
   * Check if a file exists in the repository
   * @param filePath Path to the file (relative to the repository root)
   * @returns True if the file exists
   */
  async fileExists(filePath: string): Promise<boolean> {
    const fullPath = path.join(this.path, filePath);
    return fs.existsSync(fullPath);
  }

  /**
   * Delete a file from the repository
   * @param filePath Path to the file (relative to the repository root)
   */
  async deleteFile(filePath: string): Promise<void> {
    const fullPath = path.join(this.path, filePath);
    
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }

  /**
   * Move or rename a file in the repository
   * @param oldPath Original file path
   * @param newPath New file path
   */
  async moveFile(oldPath: string, newPath: string): Promise<void> {
    const oldFullPath = path.join(this.path, oldPath);
    const newFullPath = path.join(this.path, newPath);
    
    // Ensure the target directory exists
    const newDirectory = path.dirname(newFullPath);
    if (!fs.existsSync(newDirectory)) {
      fs.mkdirSync(newDirectory, { recursive: true });
    }
    
    // Move the file
    fs.renameSync(oldFullPath, newFullPath);
  }

  /**
   * Commit changes to the repository
   * @param message Commit message
   * @returns Commit result
   */
  async commit(options: CommitOptions): Promise<CommitResult> {
    await LocalRepository.ensureGitModuleLoaded(); // Ensure loaded
    // Stage all changes
    const statusMatrix = await LocalRepository.isoGit.statusMatrix({
      fs: this.fs,
      dir: this.path,
      filter: (f: string) => f !== '.git' // Exclude .git directory
    });
    
    // Stage changes
    for (const [filepath, headStatus, workdirStatus, stageStatus] of statusMatrix as [string, number, number, number][]) {
      if (headStatus !== workdirStatus || workdirStatus !== stageStatus) {
        if (workdirStatus === 0) {
          // File was deleted
          await LocalRepository.isoGit.remove({ fs: this.fs, dir: this.path, filepath });
        } else {
          // File was added or modified
          await LocalRepository.isoGit.add({ fs: this.fs, dir: this.path, filepath });
        }
      }
    }
    
    const author = options.author || {
      name: 'Lspace',
      email: 'lspace@example.com'
    };

    // Create commit
    const sha = await LocalRepository.isoGit.commit({
      fs: this.fs,
      dir: this.path,
      message: options.message, // Use message from options
      author: author // Use provided or default author
    });
    
    return {
      success: true,
      hash: sha,
      message: options.message // Return original message
    };
  }

  /**
   * Get the status of the repository
   * @returns Repository status
   */
  async getStatus(): Promise<RepositoryStatus> {
    await LocalRepository.ensureGitModuleLoaded(); // Ensure loaded
    // Get the current branch
    let branch = 'main';
    try {
      const currentBranch = await LocalRepository.isoGit.currentBranch({ fs: this.fs, dir: this.path });
      if (currentBranch) branch = currentBranch;
    } catch (error) {
      // Likely an empty repository, use default branch
    }
    
    // Get the status matrix
    const statusMatrix = await LocalRepository.isoGit.statusMatrix({
      fs: this.fs,
      dir: this.path,
      filter: (f: string) => f !== '.git' // Exclude .git directory
    });
    
    // Convert to FileStatus objects
    // After a commit, files that were modified show up differently in the status matrix
    // We need to handle both pre-commit and post-commit status
    const files: FileStatus[] = (statusMatrix as [string, number, number, number][]).map(([filepath, headStatus, workdirStatus, stageStatus]) => {
      return {
        path: filepath,
        staged: headStatus === stageStatus, // They're equal after a commit
        modified: headStatus !== workdirStatus,
        added: headStatus === 0 && workdirStatus !== 0,
        deleted: workdirStatus === 0
      };
    });
    
    return {
      branch,
      files
    };
  }

  /**
   * List all files in the repository, optionally scoped to a subdirectory.
   * @param directoryPath The path within the repository to list files from. Defaults to the repository root.
   * @returns Array of file information, with paths relative to the repository root.
   */
  async listFiles(directoryPath: string = '.'): Promise<FileInfo[]> {
    const result: FileInfo[] = [];
    // The absolute path to the directory we're starting the listing from.
    const absoluteStartDir = path.resolve(this.path, directoryPath);

    // Helper function to recursively list files
    // currentAbsoluteDir: The current directory being read (absolute path).
    // pathPrefixInRepo: The prefix to prepend to entry names to make them relative to the repo root.
    const readDirectoryRecursive = (currentAbsoluteDir: string) => {
      // Check if directory exists before trying to read
      if (!fs.existsSync(currentAbsoluteDir) || !fs.statSync(currentAbsoluteDir).isDirectory()) {
        // If the starting directoryPath itself doesn't exist or isn't a directory,
        // return empty or throw, matching base class behavior implicitly.
        // For recursive calls, this means a listed child dir was removed/changed.
        return;
      }

      const entries = fs.readdirSync(currentAbsoluteDir);
      
      for (const entry of entries) {
        if (entry === '.git') continue; // Skip .git directory
        
        const fullEntryPathAbsolute = path.join(currentAbsoluteDir, entry);
        // All FileInfo paths should be relative to the repository root (this.path)
        const entryPathInRepo = path.relative(this.path, fullEntryPathAbsolute);
        
        try {
            const stats = fs.statSync(fullEntryPathAbsolute);
            
            const fileInfo: FileInfo = {
              path: entryPathInRepo,
              type: stats.isDirectory() ? 'directory' : 'file',
              // size: stats.size, // Optional: consider adding if needed by FileNode
              // lastModified: stats.mtime // Optional
            };
            result.push(fileInfo);

            if (stats.isDirectory()) {
              // If it's a directory, recurse into it.
              // The entryPathInRepo is already correct for the directory itself.
              // For children, their paths will be built correctly by re-calculating path.relative(this.path, ...).
              readDirectoryRecursive(fullEntryPathAbsolute);
            }
        } catch (error) {
            // Log error if stat fails for an entry (e.g. broken symlink, permissions)
            // and skip this entry.
            console.error(`Error stating file ${fullEntryPathAbsolute}: ${error}`);
        }
      }
    };
    
    // Start reading from the resolved absolute path of the directoryPath argument
    readDirectoryRecursive(absoluteStartDir);
    return result;
  }
}