#!/usr/bin/env node

// Load environment variables first
const path = require('path');
const fs = require('fs');

// Ensure we load .env from the correct directory
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  // Fallback to default dotenv behavior
  require('dotenv').config();
}

// Lspace MCP server implementation
const readline = require('readline');

// Store original console methods for selective use
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error
};

// Silence all console output immediately for clean JSON-RPC
console.log = () => {};
console.warn = () => {};
console.error = () => {};

// Import the compiled TypeScript services
const { RepositoryManager } = require('./dist/core/repositoryManager');
const { OrchestratorService } = require('./dist/orchestrator/orchestratorService');
const { LLMService } = require('./dist/orchestrator/llmService');
const { KnowledgeBaseService } = require('./dist/knowledge-base/knowledgeBaseService');
const { TimelineService } = require('./dist/core/timelineService');
const { SearchService } = require('./dist/search/searchService');
const { KnowledgeBaseHistoryService } = require('./dist/services/knowledgeBaseHistoryService');

class LspaceMCPServer {
  constructor() {
    // Don't initialize services yet - we need to set CWD first
    this.repositoryManager = null;
    this.orchestratorService = null;
    this.isInitialized = false;
  }
  
  async initialize() {
    if (this.isInitialized) return;
    
    try {
      // Since CWD is wrong (/), use the absolute path directly
      const fs = require('fs');
      const configPathForPrecheck = path.join(__dirname, 'config.local.json');
      
      if (fs.existsSync(configPathForPrecheck)) {
        // Read and parse config to verify it has repositories
        const configContent = fs.readFileSync(configPathForPrecheck, 'utf8');
        const config = JSON.parse(configContent);
        this.configRepoCount = config.repositories?.length || 0;
        
        // Temporarily restore console for loading to see if that's the issue
        const origLog = console.log;
        const origWarn = console.warn;
        const origError = console.error;
        
        // console.log = originalConsole.log; // Keep silenced to prevent MCP client errors
        // console.warn = originalConsole.warn; // Keep silenced
        // console.error = originalConsole.error; // Keep silenced
        
        try {
          // Change working directory permanently to the correct location
          process.chdir(__dirname);
          
          // Now create all the services with the correct CWD
          this.repositoryManager = new RepositoryManager();
          
          // Load the repository configuration (now it should find config.local.json in CWD)
          await this.repositoryManager.loadConfiguration();
          
          // Initialize other services
          const apiKey = process.env.OPENAI_API_KEY || '';
          if (!apiKey) {
            throw new Error('OPENAI_API_KEY environment variable is not set. Please check your .env file.');
          }
          
          const llmService = new LLMService({
            apiKey: apiKey,
            endpoint: process.env.OPENAI_ENDPOINT,
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            repositoryPath: process.env.REPO_BASE_PATH || './repos'
          });
          
          const timelineService = new TimelineService();
          const searchService = new SearchService(this.repositoryManager);
          const knowledgeBaseService = new KnowledgeBaseService(llmService, timelineService, searchService);
          
          // Create orchestrator service
          this.orchestratorService = new OrchestratorService(this.repositoryManager, llmService, knowledgeBaseService);
          
          // Create knowledge base history service
          this.historyService = new KnowledgeBaseHistoryService(this.repositoryManager, timelineService);
          
          this.loadSuccess = true;
        } catch (loadError) {
          this.loadError = loadError.message;
          this.loadSuccess = false;
        } finally {
          // Restore silence
          // console.log = origLog;
          // console.warn = origWarn;
          // console.error = origError;
        }
      } else {
        this.configRepoCount = -1; // File not found
      }
      
      this.isInitialized = true;
    } catch (error) {
      this.initError = error.message;
      this.isInitialized = true;
    }
  }
  
  getTools() {
    return [
      // === REPOSITORY MANAGEMENT ===
      {
        name: "lspace_list_repositories",
        description: "📋 SETUP: List all repositories currently managed by Lspace.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "lspace_get_repository_info",
        description: "ℹ️ SETUP: Get detailed configuration for a specific repository.",
        inputSchema: {
          type: "object",
          properties: {
            repositoryName: {
              type: "string",
              description: "The unique name of the repository."
            }
          },
          required: ["repositoryName"]
        }
      },

      // === CONTENT CREATION (PRIMARY WORKFLOW) ===
      {
        name: "lspace_add_content",
        description: "🚀 CREATE: Add content for automatic knowledge base generation. This is the PRIMARY tool for adding ANY content to lspace. Example: repositoryId='b3fcb584-5fd9-4098-83b8-8c5d773d86eb', inputType='text_snippet', content='My documentation text', title='New Guide'",
        inputSchema: {
          type: "object",
          properties: {
            repositoryId: {
              type: "string",
              description: "The ID of the Lspace repository. Use 'lspace_list_repositories' first to get repository IDs."
            },
            inputType: {
              type: "string",
              description: "Content type: 'text_snippet' for text, 'file_upload' for files, 'web_url' to fetch from URL.",
              enum: ["text_snippet", "file_upload", "web_url"]
            },
            content: {
              type: "string",
              description: "The actual content text (for text_snippet) or file content (for file_upload). For files, use base64 encoding for binary data."
            },
            fileName: {
              type: "string",
              description: "File name (REQUIRED for file_upload type). Example: 'my-document.md'"
            },
            url: {
              type: "string",
              description: "The URL to fetch content from (REQUIRED for web_url type). Example: 'https://example.com/doc'"
            },
            title: {
              type: "string",
              description: "Optional title for the content. Example: 'Installation Guide', 'Meeting Notes'"
            },
            user: {
              type: "string",
              description: "Optional user identifier. Example: 'john.doe'"
            },
            metadata: {
              type: "object",
              description: "Optional metadata like tags, categories, etc."
            }
          },
          required: ["repositoryId", "inputType"]
        }
      },

      // === KNOWLEDGE BASE INTERACTION ===
      {
        name: "lspace_search_knowledge_base",
        description: "🔍 SEARCH: Query the knowledge base using natural language. Automatically syncs with remote before searching to ensure latest content. Example: repositoryId='b3fcb584-5fd9-4098-83b8-8c5d773d86eb', queryText='What are the testing procedures?'",
        inputSchema: {
          type: "object",
          properties: {
            repositoryId: {
              type: "string",
              description: "The ID of the Lspace repository to query. Use 'lspace_list_repositories' first to get repository IDs."
            },
            queryText: {
              type: "string",
              description: "Natural language query about the knowledge base content. Examples: 'What are the main topics?', 'How do I configure X?', 'Tell me about testing procedures'"
            }
          },
          required: ["repositoryId", "queryText"]
        }
      },
      {
        name: "lspace_browse_knowledge_base",
        description: "📖 BROWSE: Read existing knowledge base files/directories (read-only). Automatically syncs with remote before browsing to ensure latest content. Example: To list files in 'Lspace Official Docs' root, use repositoryId='b3fcb584-5fd9-4098-83b8-8c5d773d86eb', operation='list_directory', path='.'",
        inputSchema: {
          type: "object",
          properties: {
            repositoryId: {
              type: "string",
              description: "The ID of the Lspace repository. Use 'lspace_list_repositories' first to get repository IDs."
            },
            operation: {
              type: "string", 
              description: "Operation type: 'list_directory' to see files/folders, 'read_file' to read file contents. Use 'lspace_add_content' for content creation.",
              enum: ["read_file", "list_directory"]
            },
            path: {
              type: "string",
              description: "Path relative to repository root. Use '.' for root directory, 'folder/file.txt' for specific files."
            }
          },
          required: ["repositoryId", "operation", "path"]
        }
      },

      // === KNOWLEDGE BASE HISTORY & REVERT ===
      {
        name: "lspace_list_knowledge_base_history",
        description: "📜 HISTORY: List all changes made to the knowledge base in human-friendly format. Shows both file uploads and knowledge base generations separately. Example: repositoryId='b3fcb584-5fd9-4098-83b8-8c5d773d86eb'",
        inputSchema: {
          type: "object",
          properties: {
            repositoryId: {
              type: "string",
              description: "The ID of the Lspace repository. Use 'lspace_list_repositories' first to get repository IDs."
            },
            limit: {
              type: "number",
              description: "Maximum number of changes to return (default: 20)"
            },
            changeType: {
              type: "string",
              description: "Filter by type of change: 'file_upload', 'knowledge_base_generation', or 'both'",
              enum: ["file_upload", "knowledge_base_generation", "both"]
            }
          },
          required: ["repositoryId"]
        }
      },
      {
        name: "lspace_undo_knowledge_base_changes",
        description: "🔄 UNDO: Revert knowledge base changes using human-friendly commands. Can undo file uploads, KB generations, or both. Examples: 'undo changes for test.txt', 'undo last 3 changes', 'remove test.txt completely'",
        inputSchema: {
          type: "object",
          properties: {
            repositoryId: {
              type: "string",
              description: "The ID of the Lspace repository. Use 'lspace_list_repositories' first to get repository IDs."
            },
            filename: {
              type: "string",
              description: "Target a specific file. Example: 'test.txt', 'meeting-notes.md'"
            },
            changeId: {
              type: "string",
              description: "Specific change ID from 'lspace_list_knowledge_base_history'"
            },
            lastNChanges: {
              type: "number",
              description: "Undo the last N changes. Example: 1 for last change, 3 for last 3 changes"
            },
            revertType: {
              type: "string",
              description: "What to revert: 'file_upload' (remove file), 'knowledge_base_generation' (keep file, regenerate KB), 'both' (remove everything)",
              enum: ["file_upload", "knowledge_base_generation", "both"]
            },
            regenerateAfterRevert: {
              type: "boolean",
              description: "For knowledge_base_generation reverts, trigger automatic regeneration (default: false)"
            }
          },
          required: ["repositoryId"]
        }
      }
    ];
  }

  async handleRequest(request) {
    // Validate request structure
    if (!request || typeof request !== 'object') {
      return {
        jsonrpc: "2.0",
        id: 0,
        error: {
          code: -32600,
          message: "Invalid Request"
        }
      };
    }

    const { method, params, id } = request;

    // Ensure we have required fields
    if (typeof method !== 'string') {
      return {
        jsonrpc: "2.0",
        id: id || 0,
        error: {
          code: -32600,
          message: "Invalid Request: method is required"
        }
      };
    }

    // Handle notifications (requests without id) - no response needed
    if (id === undefined || id === null) {
      return null;
    }

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: "lspace-mcp-server",
              version: "1.0.0"
            }
          }
        };

      case 'tools/list':
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: this.getTools()
          }
        };

      case 'tools/call':
        const { name, arguments: args } = params;
        return await this.callTool(name, args, id);

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        };
    }
  }

  async callTool(name, args, id) {
    switch (name) {
      case 'lspace_list_repositories':
        if (!this.isInitialized) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: 'Repository manager not initialized'
            }
          };
        }
        
        try {
          const repositories = this.repositoryManager.getAllRepositoryConfigs();
          
          if (repositories.length === 0) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: "No repositories are currently managed by Lspace."
                  }
                ]
              }
            };
          }
          
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `Found ${repositories.length} managed repositories:\n\n` +
                       repositories.map(repo => 
                         `• ${repo.name} (${repo.id})\n  Type: ${repo.type}\n` +
                         (repo.type === 'local' ? `  Path: ${repo.path}\n` : '') +
                         (repo.type === 'github' ? `  GitHub: ${repo.owner}/${repo.repo} (${repo.branch})\n` : '') +
                         (repo.path_to_kb ? `  KB Path: ${repo.path_to_kb}\n` : '')
                       ).join('\n')
                }
              ]
            }
          };
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Failed to list repositories: ${error.message}`
            }
          };
        }

      case 'lspace_get_repository_info':
        if (!args || !args.repositoryName) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: 'Missing required parameter: repositoryName'
            }
          };
        }
        
        if (!this.isInitialized || !this.repositoryManager) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: 'Repository manager not initialized'
            }
          };
        }
        
        try {
          const repoIdentifier = args.repositoryName;
          const repositories = this.repositoryManager.getAllRepositoryConfigs();
          
          // Find repository by name (case-insensitive) OR by ID
          const repo = repositories.find(r => 
            r.name.toLowerCase() === repoIdentifier.toLowerCase() ||
            r.id === repoIdentifier
          );
          
          if (!repo) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Repository "${repoIdentifier}" not found.\n\nAvailable repositories:\n${repositories.map(r => `• ${r.name} (${r.id})`).join('\n')}`
                  }
                ]
              }
            };
          }
          
          // Build detailed info
          let details = `Repository Details:\n• ID: ${repo.id}\n• Name: ${repo.name}\n• Type: ${repo.type}`;
          
          if (repo.type === 'local') {
            details += `\n• Path: ${repo.path}`;
          } else if (repo.type === 'github') {
            details += `\n• GitHub: ${repo.owner}/${repo.repo}\n• Branch: ${repo.branch}\n• PAT Alias: ${repo.pat_alias}`;
          }
          
          if (repo.path_to_kb) {
            details += `\n• Knowledge Base Path: ${repo.path_to_kb}`;
          }
          
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: details
                }
              ]
            }
          };
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Failed to get repository details: ${error.message}`
            }
          };
        }

      case 'lspace_search_knowledge_base':
        const { repositoryId, queryText } = args;
        if (!repositoryId || !queryText) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: 'Missing required parameters: repositoryId, queryText'
            }
          };
        }
        
        try {
          // Ensure services are initialized
          if (!this.isInitialized || !this.repositoryManager || !this.orchestratorService || !this.orchestratorService.llmService) {
            return {
              jsonrpc: "2.0", id, error: { code: -32000, message: 'MCP server or required services not initialized.' }
            };
          }

          // Sync with remote before searching (for GitHub repositories)
          try {
            await this.repositoryManager.syncWithRemote(repositoryId);
          } catch (syncError) {
            console.warn(`[MCP Server] Failed to sync repository ${repositoryId} before searching: ${syncError.message}. Proceeding with local version.`);
            // Continue with search even if sync fails
          }
          
          const repository = this.repositoryManager.getRepository(repositoryId);
          if (!repository) {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: `Repository with ID ${repositoryId} not found.` }
            };
          }

          // Call the LLMService's queryKnowledgeBase method
          const searchResult = await this.orchestratorService.llmService.queryKnowledgeBase(repository, queryText);
          
          // searchResult is { answer: string, sources: string[] }
          const responseText = `Search Query: "${queryText}"\n\nAnswer:\n${searchResult.answer}\n\nSources:\n${searchResult.sources.join('\n') || 'No specific sources cited by LLM.'}`;
          
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: responseText
                }
              ]
            }
          };
        } catch (error) {
          console.error(`[MCP Server] Error during knowledge base search for repo ${repositoryId}:`, error);
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Error during knowledge base search: ${error.message}`
            }
          };
        }

      case 'lspace_add_content':
        const { repositoryId: repoId, inputType, content, fileName, url, title } = args;
        if (!repoId || !inputType) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Missing required parameters for lspace_add_content:\n` +
                      `• repositoryId: Get this from 'lspace_list_repositories'\n` +
                      `• inputType: Use 'text_snippet', 'file_upload', or 'web_url'\n\n` +
                      `Example: repositoryId='b3fcb584-5fd9-4098-83b8-8c5d773d86eb', inputType='text_snippet', content='My text', title='My Title'`
            }
          };
        }
        
        try {
          let input;
          
          // Map MCP input parameters to orchestrator service input types
          switch (inputType) {
            case 'file_upload':
              if (!fileName || !content) {
                return {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: -32000,
                    message: 'Missing required parameters for file_upload: fileName, content'
                  }
                };
              }
              input = {
                type: 'file_upload',
                repositoryId: repoId,
                fileName,
                content
              };
              break;
              
            case 'text_snippet':
              if (!content) {
                return {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: -32000,
                    message: 'Missing required parameter for text_snippet: content'
                  }
                };
              }
              input = {
                type: 'text_snippet',
                repositoryId: repoId,
                content,
                title
              };
              break;
              
            case 'web_url':
              if (!url) {
                return {
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: -32000,
                    message: 'Missing required parameter for web_url: url'
                  }
                };
              }
              input = {
                type: 'web_url',
                repositoryId: repoId,
                url
              };
              break;
              
            default:
              return {
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32000,
                  message: `Unsupported input type: ${inputType}. Supported types: file_upload, text_snippet, web_url`
                }
              };
          }
          
          // Process the input using orchestrator service
          const result = await this.orchestratorService.processInput(input);
          
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: `Content Successfully Processed!\n\nType: ${inputType}\nRepository: ${repoId}\n${fileName ? `File: ${fileName}\n` : ''}${url ? `URL: ${url}\n` : ''}${title ? `Title: ${title}\n` : ''}\n\nRaw Input Path: ${result.rawInputPath || 'N/A'}\nKnowledge Base Updated: ${result.knowledgeBaseUpdated}\nKB Article Path: ${result.knowledgeBasePath || 'N/A'}\n\nMessage: ${result.message || 'Content processed successfully'}`
                }
              ]
            }
          };
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Error processing content: ${error.message}`
            }
          };
        }

      case 'lspace_browse_knowledge_base':
        const { repositoryId: repoId2, operation, path, content: itemContent } = args;
        if (!repoId2 || !operation || !path) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Missing required parameters for lspace_browse_knowledge_base:\n` +
                      `• repositoryId: Get this from 'lspace_list_repositories'\n` +
                      `• operation: Use 'list_directory' or 'read_file'\n` +
                      `• path: Use '.' for root directory or 'folder/file.txt'\n\n` +
                      `Example: repositoryId='b3fcb584-5fd9-4098-83b8-8c5d773d86eb', operation='list_directory', path='.'`
            }
          };
        }
        
        if (!this.isInitialized || !this.repositoryManager) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: 'Repository manager not initialized'
            }
          };
        }
        
        // Normalize the path - if it's root ("/") or empty, use "." for repository root
        let normalizedPath = path;
        if (!normalizedPath || normalizedPath === '/' || normalizedPath === '') {
          normalizedPath = '.';
        }
        
        // Check for prohibited paths
        if (normalizedPath.includes('.lspace') || normalizedPath.includes('.git')) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: 'Operation on /.lspace/ or /.git/ directories is strictly prohibited'
            }
          };
        }
        
        try {
          // Get the repository configuration first
          const repoInfo = this.repositoryManager.getAllRepositoryConfigs().find(r => r.id === repoId2);
          
          if (!repoInfo) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32000,
                message: `Repository with ID ${repoId2} not found`
              }
            };
          }
          
          // Debug info before trying to access repository
          const debugInfo = {
            repositoryId: repoId2,
            configPath: repoInfo.path || 'N/A',
            repositoryType: repoInfo.type,
            originalPath: path || 'undefined',
            normalizedPath: normalizedPath,
            workingDir: process.cwd()
          };
          
          // Sync with remote before browsing (for GitHub repositories)
          try {
            await this.repositoryManager.syncWithRemote(repoId2);
          } catch (syncError) {
            console.warn(`Failed to sync repository before browsing: ${syncError.message}`);
            // Continue with browsing even if sync fails - user will see local version
          }
          
          // Get the repository instance
          const repository = this.repositoryManager.getRepository(repoId2);
          
          let result;
          switch (operation) {
            case 'list_directory':
              try {
                const items = await repository.listFiles(normalizedPath);
                result = {
                  success: true,
                  operation,
                  path: normalizedPath,
                  items: items,
                  debug: debugInfo
                };
              } catch (listError) {
                // Return debug info even if listing fails
                result = {
                  success: false,
                  operation,
                  error: listError.message,
                  debug: debugInfo
                };
              }
              break;
              
            case 'read_file':
              const fileContent = await repository.readFile(path);
              result = {
                success: true,
                operation,
                path,
                content: fileContent
              };
              break;
              
            // Block all content creation/modification operations
            case 'create_file':
            case 'update_file':
            case 'delete_file':
            case 'create_directory':
            case 'delete_directory':
              return {
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32000,
                  message: `❌ OPERATION BLOCKED: '${operation}' is not allowed in lspace_browse_knowledge_base.\n\n🚀 Use 'lspace_add_content' instead to:\n  • Add new content to the knowledge base\n  • Trigger automatic LLM processing\n  • Follow proper lspace workflow\n\nThe 'lspace_browse_knowledge_base' tool is READ-ONLY for browsing existing KB structure.`
                }
              };
              
            default:
              return {
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32000,
                  message: `Unsupported operation: ${operation}`
                }
              };
          }
          
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2)
                }
              ]
            }
          };
          
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Failed to ${operation}: ${error.message}`
            }
          };
        }

      case 'lspace_list_knowledge_base_history':
        const { repositoryId: historyRepoId, limit: historyLimit, changeType } = args;
        if (!historyRepoId) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Missing required parameter: repositoryId. Use 'lspace_list_repositories' to get repository IDs.`
            }
          };
        }

        try {
          const changes = await this.historyService.listKnowledgeBaseChanges(historyRepoId, {
            limit: historyLimit || 20,
            changeType: changeType || 'both'
          });

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: this.formatHistoryResponse(changes, changeType || 'both')
                }
              ]
            }
          };
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Error retrieving history: ${error.message}`
            }
          };
        }

      case 'lspace_undo_knowledge_base_changes':
        const { 
          repositoryId: undoRepoId, 
          filename: undoFilename, 
          changeId: undoChangeId, 
          lastNChanges: undoLastN,
          revertType: undoRevertType,
          regenerateAfterRevert: undoRegenerate
        } = args;
        
        if (!undoRepoId) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Missing required parameter: repositoryId. Use 'lspace_list_repositories' to get repository IDs.`
            }
          };
        }

        try {
          const revertResult = await this.historyService.revertKnowledgeBaseChanges({
            repositoryId: undoRepoId,
            filename: undoFilename,
            changeId: undoChangeId,
            lastNChanges: undoLastN,
            revertType: undoRevertType || 'both',
            regenerateAfterRevert: undoRegenerate || false
          });

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: this.formatRevertResponse(revertResult)
                }
              ]
            }
          };
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: `Error reverting changes: ${error.message}`
            }
          };
        }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: `Unknown tool: ${name}`
          }
        };
    }
  }

  // Helper method to format history response
  formatHistoryResponse(changes, changeType) {
    if (changes.length === 0) {
      return `No ${changeType === 'both' ? '' : changeType + ' '}changes found in the knowledge base history.`;
    }

    let response = `Knowledge Base History (${changes.length} change${changes.length === 1 ? '' : 's'}):\n\n`;
    
    changes.forEach((change, index) => {
      const typeIcon = change.changeType === 'file_upload' ? '📄' : '🧠';
      const operationIcon = change.operation === 'added' ? '➕' : change.operation === 'updated' ? '✏️' : '🗑️';
      
      response += `${index + 1}. ${typeIcon} ${operationIcon} ${change.description}\n`;
      response += `   ID: ${change.id}\n`;
      response += `   When: ${change.userFriendlyDate}\n`;
      response += `   Type: ${change.changeType.replace('_', ' ')}\n`;
      if (change.details?.user) response += `   User: ${change.details.user}\n`;
      if (change.filesAffected.length > 0) response += `   Files: ${change.filesAffected.join(', ')}\n`;
      response += '\n';
    });

    response += `💡 Use 'lspace_undo_knowledge_base_changes' to revert any of these changes.\n`;
    response += `📋 Refer to changes by their ID or use human-friendly commands like:\n`;
    response += `   • "undo changes for filename.txt"\n`;
    response += `   • "undo last 3 changes"\n`;
    response += `   • revertType options: 'file_upload', 'knowledge_base_generation', 'both'`;

    return response;
  }

  // Helper method to format revert response
  formatRevertResponse(revertResult) {
    if (!revertResult.success) {
      return `❌ Revert Failed: ${revertResult.message}`;
    }

    let response = `✅ ${revertResult.message}\n\n`;
    
    if (revertResult.revertCommitIds.length > 0) {
      response += `🔗 Revert Commit IDs: ${revertResult.revertCommitIds.map(id => id.slice(0, 8)).join(', ')}\n\n`;
    }

    if (revertResult.changesReverted.length > 0) {
      response += `📋 Changes Reverted:\n`;
      revertResult.changesReverted.forEach((change, index) => {
        const typeIcon = change.changeType === 'file_upload' ? '📄' : '🧠';
        response += `${index + 1}. ${typeIcon} ${change.description}\n`;
      });
      response += '\n';
    }

    if (revertResult.regenerationTriggered) {
      response += `🔄 Knowledge base regeneration has been triggered automatically.\n`;
    }

    response += `🚀 Changes have been pushed to the remote repository.`;

    return response;
  }

  async start() {
    // Initialize repository manager first
    await this.initialize();
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async (line) => {
      try {
        const request = JSON.parse(line.trim());
        const response = await this.handleRequest(request);
        if (response) {
          // Use original console.log for JSON-RPC responses only
          originalConsole.log(JSON.stringify(response));
        }
      } catch (error) {
        // For parse errors, we can't get the id, so we use a default
        const errorResponse = {
          jsonrpc: "2.0",
          id: 0,
          error: {
            code: -32700,
            message: "Parse error",
            data: error.message
          }
        };
        originalConsole.log(JSON.stringify(errorResponse));
      }
    });

    // Keep the process alive
    process.stdin.resume();
  }
}

// Start the server
const server = new LspaceMCPServer();
server.start();