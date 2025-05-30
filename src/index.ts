import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs'; // Import fs for file logging
import { RepositoryManager } from './core/repositoryManager';
import { setupRepositoryRoutes } from './api/repositoryApi';
import { setupFileModificationRoutes } from './api/fileModificationApi';
import { createOrchestratorApi } from './api/orchestratorApi';
import { setupTimelineRoutes } from './api/timelineApi';
import { createKnowledgeBaseApi } from './api/knowledgeBaseApi';
import { LLMService } from './orchestrator/llmService';
import { TimelineService } from './core/timelineService';
import { KnowledgeBaseService } from './knowledge-base/knowledgeBaseService';
import { OrchestratorService } from './orchestrator/orchestratorService';
import { SearchService } from './search/searchService';
import { setupTimelineV2Routes } from './api/routes/timelineV2Routes';
import { createHistoryRoutes } from './api/historyRoutes';
import { createChatRoutes } from './api/chatRoutes';
import { createVersionControlRoutes } from './api/versionControlRoutes';

// Import for MCP Server
import { registerMCPServer } from './mcp/registerTools';
import { startStdioListener } from './mcp/stdioServer';

// Load environment variables
dotenv.config();

// Redirect console output to stderr in stdio mode EARLY to avoid polluting stdout
if (process.env.MCP_TRANSPORT === 'stdio') {
  // Completely silence all console output in stdio mode
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

// Create Express application
const app = express();
app.use(express.json());

// Add middleware for CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  next();
});

// Create repository manager
const repositoryManager = new RepositoryManager();

// Load configuration if it exists (skip in stdio mode for faster startup)
try {
  if (process.env.NODE_ENV !== 'test' && process.env.MCP_TRANSPORT !== 'stdio') {
    // Skip in test environment and stdio mode
    console.log(`[Index] Attempting to load configuration using RepositoryManager default path...`);
    repositoryManager.loadConfiguration()
      .then(() => {
        console.log("[Index] RepositoryManager.loadConfiguration() completed successfully.");
      })
      .catch(error => {
        console.warn(`[Index] Failed to load configuration via RepositoryManager: ${error.message}`);
        console.warn('[Index] Starting with empty configuration, or RepositoryManager will handle default creation if applicable.');
      });
  }
} catch (error) {
  console.warn(`[Index] Error during configuration loading attempt: ${error instanceof Error ? error.message : 'Unknown error'}`);
  console.warn('[Index] Starting with empty configuration.');
}

// Set up API routes
setupRepositoryRoutes(app, repositoryManager);

// Create LLM service
const llmService = new LLMService({
  apiKey: process.env.OPENAI_API_KEY || '',
  endpoint: process.env.OPENAI_ENDPOINT,
  model: process.env.OPENAI_MODEL || 'gpt-4o',
  // Don't set a default repository path - it will be set properly for each repository instance
  repositoryPath: process.env.REPO_BASE_PATH || './repos'
});

// Create TimelineService instance
const timelineService = new TimelineService();

// Create SearchService instance
const searchService = new SearchService(repositoryManager);

// Create KnowledgeBaseService instance
const knowledgeBaseService = new KnowledgeBaseService(llmService, timelineService, searchService);

// Create OrchestratorService instance
const orchestratorService = new OrchestratorService(repositoryManager, llmService, knowledgeBaseService);

// Pass KnowledgeBaseService and LLMService to setupFileModificationRoutes
setupFileModificationRoutes(app, repositoryManager, knowledgeBaseService, llmService);
setupTimelineRoutes(app, repositoryManager);

// Set up orchestrator API
app.use('/api/orchestrator', createOrchestratorApi(repositoryManager, llmService, knowledgeBaseService));

// Set up knowledge base API
app.use('/api/knowledge-base', createKnowledgeBaseApi(repositoryManager, llmService));

// Setup the new Timeline v2 routes
setupTimelineV2Routes(app, repositoryManager, orchestratorService);

// Setup history routes
app.use('/api/v1/history', createHistoryRoutes(repositoryManager, timelineService));

// Ensure repositoryManager is available to the app
if (repositoryManager) {
  app.set('repositoryManager', repositoryManager);
  console.log('[App Index] RepositoryManager instance set on app.');
} else {
  console.error('[App Index] CRITICAL ERROR: repositoryManager instance is not defined. Chat routes will fail.');
  // Potentially throw an error or exit if this is a critical piece of setup
}

// Mount chat routes
const chatRouter = createChatRoutes(repositoryManager, timelineService);
app.use('/api/v1/chat', chatRouter);

// Mount version control routes
const versionControlRouter = createVersionControlRoutes(repositoryManager);
app.use('/api/v1/repositories', versionControlRouter);

// Services needed for MCP
const mcpServices = {
  orchestratorService,
  repositoryManager,
  llmService,
  knowledgeBaseService
};

const mcpLogFilePath = path.join(process.cwd(), 'mcp_stdio_debug.log');
const logToFile = (message: string) => {
  try {
    fs.appendFileSync(mcpLogFilePath, `[${new Date().toISOString()}] ${message}\n`);
  } catch (err) {
    console.error('Failed to write to mcp_stdio_debug.log', err);
  }
};

if (process.env.MCP_TRANSPORT === 'stdio') {
  logToFile('[MCP Index] Starting in stdio transport mode.');
  
  // For stdio mode, start listener immediately without heavy initialization
  try {
    // Start stdio listener first
    startStdioListener(mcpServices);
    logToFile('[MCP Index] startStdioListener called successfully.');
    
    // Register MCP server after stdio is ready
    registerMCPServer(null, mcpServices.orchestratorService, mcpServices.repositoryManager, mcpServices.llmService, mcpServices.knowledgeBaseService);
    logToFile('[MCP Index] registerMCPServer called successfully for stdio.');
  } catch (err: any) {
    logToFile(`[MCP Index] CRITICAL ERROR during stdio setup: ${err.message} ${err.stack}`);
    // Optionally rethrow or process.exit(1) if this setup is critical and fails
  }
} else {
  logToFile('[MCP Index] Starting in HTTP transport mode.');
  // Register MCP Server for HTTP Express app
  registerMCPServer(app, mcpServices.orchestratorService, mcpServices.repositoryManager, mcpServices.llmService, mcpServices.knowledgeBaseService);

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Root endpoint
  app.get('/', (req, res) => {
    res.json({
      name: 'Bee Context API',
      version: '0.1.0',
      status: 'ok'
    });
  });

  // Handle 404 errors
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handling
  app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Start server
  const port = process.env.PORT || 3000;
  if (process.env.NODE_ENV !== 'test') {
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  }
}

export default app;