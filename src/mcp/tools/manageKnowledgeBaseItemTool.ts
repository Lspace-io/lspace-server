import { MCPTool } from '../registerTools';
import { Repository } from '../../core/repository'; // To interact with repository file system

const manageKnowledgeBaseItemTool: MCPTool = {
  name: 'manage_knowledge_base_item',
  description: 'Manages items (files/directories) in the knowledge base of a specified Lspace repository. Prohibited from operating within /.lspace/.',
  parameters: {
    type: 'object',
    properties: {
      repositoryId: {
        type: 'string',
        description: 'The ID of the Lspace repository.',
      },
      operation: {
        type: 'string',
        description: 'The operation to perform on the KB item.',
        enum: ['create_file', 'read_file', 'update_file', 'delete_file', 'create_directory', 'list_directory', 'delete_directory'],
      },
      path: {
        type: 'string',
        description: "The path to the file or directory, relative to the repository root (e.g., 'my_topic/notes.md' or 'my_topic/'). Leading/trailing slashes are normalized.",
      },
      content: {
        type: 'string',
        description: 'The content for the file (for create_file, update_file operations). Ignored for other operations.',
      },
    },
    required: ['repositoryId', 'operation', 'path'],
  },
  run: async (args: any, services) => {
    console.log(`[MCP manage_knowledge_base_item] Called with args: ${JSON.stringify(args)}`);
    const { repositoryManager } = services;
    const { repositoryId, operation, path: rawPath, content } = args;

    if (!repositoryId || typeof repositoryId !== 'string' ||
        !operation || typeof operation !== 'string' ||
        !rawPath || typeof rawPath !== 'string') {
      throw new Error('Missing or invalid required parameters: repositoryId (string), operation (string), and path (string) are required.');
    }

    let normalizedPath = rawPath.trim();
    // Remove leading ./ or /
    if (normalizedPath.startsWith('./')) {
      normalizedPath = normalizedPath.substring(2);
    } else if (normalizedPath.startsWith('/')) {
      normalizedPath = normalizedPath.substring(1);
    }

    // Remove trailing / unless it's for list_directory on the root (which becomes '.')
    if (normalizedPath.endsWith('/') && normalizedPath.length > 1) {
      if (operation !== 'list_directory' || normalizedPath !== '/') { // keep trailing slash if path is just "/" for list_directory
        normalizedPath = normalizedPath.substring(0, normalizedPath.length - 1);
      }
    }
    
    // Handle root path for list_directory or empty paths
    if (normalizedPath === '' || normalizedPath === '/' || normalizedPath === '.') {
      if (operation === 'list_directory') {
        normalizedPath = '.';
      } else if (operation !== 'list_directory' && (normalizedPath === '' || normalizedPath === '/')){
        // Path cannot be empty or just root for non-list_directory operations
        throw new Error("Path cannot be effectively empty or root for this operation. For root directory listing, use path '.', '/' or an empty string with list_directory.");
      }
    }
    
    if (normalizedPath === '' && operation !== 'list_directory') {
         throw new Error('Path parameter is effectively empty after normalization, which is not allowed for this operation.');
    }

    // CRITICAL: Path validation to prevent access to /.lspace/ or /.git/
    const pathSegments = normalizedPath.split('/');
    if (pathSegments.indexOf('.lspace') !== -1 || pathSegments.indexOf('.git') !== -1) {
      throw new Error('Operation on or through /.lspace/ or /.git/ directories is strictly prohibited.');
    }
    // Also check if the path *is* exactly .lspace or .git after normalization (e.g. user inputs "/.lspace/")
    if (normalizedPath === '.lspace' || normalizedPath === '.git') {
        throw new Error('Operation directly on /.lspace/ or /.git/ root directory is strictly prohibited.');
    }

    const repository: Repository = repositoryManager.getRepository(repositoryId);

    try {
      switch (operation) {
        case 'create_file':
        case 'update_file':
          if (content === undefined || content === null) { // Check for undefined or null explicitly
            throw new Error(`Content (string) is required and cannot be null/undefined for ${operation}.`);
          }
          await repository.writeFile(normalizedPath, String(content)); // Ensure content is string
          return { success: true, message: `File "${normalizedPath}" ${operation === 'create_file' ? 'created' : 'updated'} successfully.` };

        case 'read_file':
          const fileContent = await repository.readFile(normalizedPath);
          return { success: true, path: normalizedPath, content: fileContent };

        case 'delete_file':
          await repository.deleteFile(normalizedPath);
          return { success: true, message: `File "${normalizedPath}" deleted successfully.` };

        case 'create_directory':
          await repository.createDirectory(normalizedPath);
          return { success: true, message: `Directory "${normalizedPath}" created successfully.` };

        case 'list_directory':
          const items = await repository.listFiles(normalizedPath);
          return { success: true, path: normalizedPath, items: items };

        case 'delete_directory':
          await repository.deleteDirectory(normalizedPath);
          return { success: true, message: `Directory "${normalizedPath}" deleted successfully.` };

        default:
          throw new Error(`Unsupported operation: ${operation}.`);
      }
    } catch (error: any) {
      console.error(`[MCP manage_knowledge_base_item] Error performing ${operation} on ${normalizedPath} in repo ${repositoryId}: ${error.message}`, error.stack);
      throw new Error(`Failed to ${operation} "${normalizedPath}" in repository ${repositoryId}: ${error.message}`);
    }
  },
};

export default manageKnowledgeBaseItemTool; 