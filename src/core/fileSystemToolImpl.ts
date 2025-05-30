import { Repository, FileInfo } from './repository';
import pathLib from 'path';
import fs from 'fs';

// Interface defined in llmService.ts - ensure it matches or import if possible
// For now, duplicating for clarity if not directly importable due to module structure
interface FileSystemToolService { 
  readFile(path: string): Promise<{ success: boolean; content?: string; error?: string }>;
  writeFile(path: string, content: string): Promise<{ success: boolean; error?: string }>;
  editFile(path: string, edits: any): Promise<{ success: boolean; error?: string }>;
  createDirectory(path: string): Promise<{ success: boolean; error?: string }>;
  listDirectory(path: string): Promise<{ success: boolean; content?: string[]; error?: string }>;
  getFileTree(path: string): Promise<{ success: boolean; tree?: FileNode; error?: string }>;
}

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

const LSPACE_DIR = '.lspace';
const LSPACE_DIR_SLASH = '.lspace/';
const FORBIDDEN_ACCESS_ERROR = 'Access to the .lspace directory is forbidden.';

export class FileSystemToolImpl implements FileSystemToolService {
  private repository: Repository;

  constructor(repository: Repository) {
    this.repository = repository;
  }

  private isPathForbidden(relativePath: string): boolean {
    return relativePath === LSPACE_DIR || relativePath.startsWith(LSPACE_DIR_SLASH);
  }

  async readFile(path: string): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const relativePath = this.getRelativePath(path);
      if (this.isPathForbidden(relativePath)) {
        return { success: false, error: FORBIDDEN_ACCESS_ERROR };
      }
      if (!await this.repository.fileExists(relativePath)) {
        return { success: false, error: `File not found: ${path}` };
      }
      const content = await this.repository.readFile(relativePath);
      return { success: true, content };
    } catch (e: any) { 
      console.error(`[FileSystemToolImpl] Error reading file ${path}:`, e);
      return { success: false, error: e.message };
    }
  }

  async writeFile(path: string, content: string): Promise<{ success: boolean; error?: string }> {
    try {
      const relativePath = this.getRelativePath(path);
      if (this.isPathForbidden(relativePath)) {
        return { success: false, error: FORBIDDEN_ACCESS_ERROR };
      }
      await this.repository.writeFile(relativePath, content);
      return { success: true };
    } catch (e: any) {
      console.error(`[FileSystemToolImpl] Error writing file ${path}:`, e);
      return { success: false, error: e.message };
    }
  }

  // Basic implementation for editFile. Assumes \'edits\' is the new full content for simplicity for now.
  // A more advanced version would parse specific edit instructions.
  async editFile(path: string, edits: string): Promise<{ success: boolean; error?: string }> {
    try {
      const relativePath = this.getRelativePath(path);
      if (this.isPathForbidden(relativePath)) {
        return { success: false, error: FORBIDDEN_ACCESS_ERROR };
      }
      if (!await this.repository.fileExists(relativePath)) {
        return { success: false, error: `File not found for editing: ${path}` };
      }
      // Simple overwrite for now, effectively same as writeFile if full content is passed
      await this.repository.writeFile(relativePath, edits);
      return { success: true };
    } catch (e: any) {
      console.error(`[FileSystemToolImpl] Error editing file ${path}:`, e);
      return { success: false, error: e.message };
    }
  }

  async createDirectory(path: string): Promise<{ success: boolean; error?: string }> {
    try {
      const relativePath = this.getRelativePath(path);
      if (this.isPathForbidden(relativePath)) {
        return { success: false, error: FORBIDDEN_ACCESS_ERROR };
      }
      await this.repository.ensureDirectoryExists(relativePath);
      return { success: true };
    } catch (e: any) {
      console.error(`[FileSystemToolImpl] Error creating directory ${path}:`, e);
      return { success: false, error: e.message };
    }
  }

  async listDirectory(path: string): Promise<{ success: boolean; content?: string[]; error?: string }> {
    try {
      const relativePath = this.getRelativePath(path);
      if (this.isPathForbidden(relativePath)) {
        // For listDirectory, if they try to list .lspace itself, return empty or error.
        // If they list a subdirectory of .lspace, that's also forbidden.
        return { success: false, error: FORBIDDEN_ACCESS_ERROR }; 
      }
      const filesInfo: FileInfo[] = await this.repository.listFiles(relativePath);
      const directoryContent = filesInfo.map(f => pathLib.basename(f.path) + (f.type === 'directory' ? '/' : ''));
      return { success: true, content: directoryContent };
    } catch (e: any) {
      console.error(`[FileSystemToolImpl] Error listing directory ${path}:`, e);
      return { success: false, error: e.message };
    }
  }

  async getFileTree(rootPath: string): Promise<{ success: boolean; tree?: FileNode; error?: string }> {
    try {
      const relativeRootPath = this.getRelativePath(rootPath);
      // getFileTree itself can be called on subdirectories. The .lspace exclusion is handled in buildTreeRecursive for the root.
      // If rootPath itself is .lspace or inside .lspace, that should be an error here.
      if (this.isPathForbidden(relativeRootPath)){
          return { success: false, error: FORBIDDEN_ACCESS_ERROR };
      }

      const fullRootPath = pathLib.resolve(this.repository.path, relativeRootPath);

      try {
        const stats = await fs.promises.stat(fullRootPath);
        if (!stats.isDirectory()) {
          return { success: false, error: `Path is not a directory: ${rootPath}` };
        }
      } catch (statError) {
        return { success: false, error: `Path does not exist, is not a directory, or is not accessible: ${rootPath}` };
      }

      const tree = await this.buildTreeRecursive(relativeRootPath);
      return { success: true, tree };
    } catch (e: any) {
      console.error(`[FileSystemToolImpl] Error getting file tree for ${rootPath}:`, e);
      return { success: false, error: e.message };
    }
  }

  private async buildTreeRecursive(currentPathInRepo: string): Promise<FileNode> {
    const fullAbsolutePath = pathLib.resolve(this.repository.path, currentPathInRepo);
    const name = pathLib.basename(fullAbsolutePath);
    const stats = await fs.promises.stat(fullAbsolutePath);

    const node: FileNode = {
      name: name,
      path: currentPathInRepo, 
      type: stats.isDirectory() ? 'directory' : 'file'
    };

    if (stats.isDirectory()) {
      node.children = [];
      const childrenFilesInfo: FileInfo[] = await this.repository.listFiles(currentPathInRepo);
      
      for (const childInfo of childrenFilesInfo) {
        // Skip .lspace directory explicitly if currentPathInRepo is the root ('.')
        // and the child is named '.lspace'.
        if (currentPathInRepo === '.' && childInfo.path === LSPACE_DIR) {
          continue;
        }
        // Ensure we only process direct children for this node
        const relativeToCurrent = pathLib.relative(currentPathInRepo, childInfo.path);
        if (relativeToCurrent && !relativeToCurrent.includes(pathLib.sep) && relativeToCurrent !== '..') {
            const childNode = await this.buildTreeRecursive(childInfo.path);
            node.children.push(childNode);
        }
      }
    }
    return node;
  }

  // Helper to ensure paths passed to repository methods are relative to its root
  // and not accidentally absolute paths from somewhere else.
  private getRelativePath(filePath: string): string {
    if (pathLib.isAbsolute(filePath)) {
        if (!filePath.startsWith(this.repository.path)) {
            throw new Error(`Absolute path ${filePath} is outside the repository directory ${this.repository.path}`);
        }
        return pathLib.relative(this.repository.path, filePath);
    }
    return filePath;
  }
} 