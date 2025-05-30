import { Express, Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';
import { OrchestratorService } from '../orchestrator/orchestratorService';
import { RepositoryManager } from '../core/repositoryManager';
import { LLMService } from '../orchestrator/llmService';
import { KnowledgeBaseService } from '../knowledge-base/knowledgeBaseService';

export interface MCPToolParameters {
  type: 'object';
  properties: {
    [key: string]: {
      type: string;
      description?: string;
      enum?: string[];
      items?: MCPToolParameters | { type: string }; // For array items
    };
  };
  required?: string[];
}

export interface MCPTool {
  name: string;
  description: string;
  parameters: MCPToolParameters;
  run: (
    args: any,
    services: { // Pass necessary services to each tool
      orchestratorService: OrchestratorService;
      repositoryManager: RepositoryManager;
      llmService: LLMService;
      knowledgeBaseService: KnowledgeBaseService;
    }
  ) => Promise<any>;
}

interface MCPRequestBody {
  jsonrpc?: string;
  method?: string;
  params?: any;
  id?: string | number | null;
}

const tools: MCPTool[] = [];
let toolsLoaded = false; // Flag to ensure tools are loaded only once

// Function to dynamically load tools from the tools directory
// For now, this will be simple. Error handling and more robust loading can be added.
function loadTools(services: {
  orchestratorService: OrchestratorService;
  repositoryManager: RepositoryManager;
  llmService: LLMService;
  knowledgeBaseService: KnowledgeBaseService;
}) {
  if (toolsLoaded) return;
  // Tools should be in a 'tools' subdirectory relative to this file.
  const toolsDir = path.join(__dirname, 'tools');
  logToFileInternal(`[MCP registerTools] Attempting to load tools from: ${toolsDir}`); // Add logging

  try {
    const toolFiles = fs.readdirSync(toolsDir)
      .filter(file => file.endsWith('.js') && !file.endsWith('.d.ts') && !file.endsWith('.map')); // Only .js files
    
    logToFileInternal(`[MCP registerTools] Found potential tool files: ${toolFiles.join(', ')}`);

    for (const file of toolFiles) {
      try {
        const toolModulePath = path.join(toolsDir, file);
        logToFileInternal(`[MCP registerTools] Requiring tool module: ${toolModulePath}`);
        const toolModule = require(toolModulePath);
        
        // In CommonJS, TypeScript exports.default becomes module.default
        let toolDefinition: MCPTool;
        
        if (toolModule.default && typeof toolModule.default.run === 'function') {
          // ES module compiled to CommonJS - toolModule.default is the tool
          toolDefinition = toolModule.default;
          logToFileInternal(`[MCP registerTools] Found tool via .default: ${toolDefinition.name}`);
        } else if (toolModule.run && typeof toolModule.run === 'function') {
          // Direct CommonJS export
          toolDefinition = toolModule;
          logToFileInternal(`[MCP registerTools] Found tool via direct export: ${toolDefinition.name}`);
        } else if (toolModule.tool && typeof toolModule.tool.run === 'function') {
          // Named export 'tool'
          toolDefinition = toolModule.tool;
          logToFileInternal(`[MCP registerTools] Found tool via .tool: ${toolDefinition.name}`);
        } else {
          logToFileInternal(`[MCP registerTools] Could not load tool from ${file}: No valid run function found. Available keys: ${Object.keys(toolModule)}`);
          console.warn(`[MCP] Could not load tool from ${file}: No valid run function found.`);
          continue;
        }
        
        tools.push(toolDefinition);
        console.log(`[MCP] Loaded tool: ${toolDefinition.name}`);
        logToFileInternal(`[MCP registerTools] Successfully loaded tool: ${toolDefinition.name}`);
      } catch (err: any) {
        console.error(`[MCP] Error loading tool from ${file}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[MCP] Error reading tools directory ${toolsDir}: ${err.message}`);
  }
  toolsLoaded = true;
}

// Helper for logging within this file if the main logger isn't set up or for early diagnostics
const internalLogPath = path.join(process.cwd(), 'mcp_registerTools_debug.log');
function logToFileInternal(message: string) {
  try {
    fs.appendFileSync(internalLogPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch (e) { /* ignore */ }
}

// New function to handle the core MCP request logic
export async function handleMCPRequest(
  requestBody: MCPRequestBody,
  services: {
    orchestratorService: OrchestratorService;
    repositoryManager: RepositoryManager;
    llmService: LLMService;
    knowledgeBaseService: KnowledgeBaseService;
  }
): Promise<any> {
  const { jsonrpc, method, params, id } = requestBody;

  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }
  logToFileInternal(`[MCP handleMCPRequest] Received method: ${method}, id: ${id}, params: ${JSON.stringify(params)}`);

  try {
    if (method === 'initialize') {
      logToFileInternal(`[MCP handleMCPRequest] Handling 'initialize' method. Client capabilities: ${JSON.stringify(params?.capabilities)}, Protocol: ${params?.protocolVersion}`);
      
      // Ensure tools are loaded before responding to initialize
      if (!toolsLoaded) {
        loadTools(services); // Pass services to loadTools
      }

      // Return proper initialize response with server info and capabilities
      return { 
        jsonrpc: '2.0', 
        id, 
        result: {
          serverInfo: {
            name: "lspace",
            version: "1.0.0"
          },
          capabilities: {
            tools: {
              listChanged: true
            },
            resources: {
              subscribe: false,
              listChanged: false
            },
            prompts: false
          }
        } 
      };
    }

    if (method === 'initialized') {
      logToFileInternal(`[MCP handleMCPRequest] Received 'initialized' notification. Ready for normal operations.`);
      return undefined; // No response needed for notifications
    }

    // Handle notifications/cancelled specifically
    // According to JSON-RPC 2.0, notifications do not get a response.
    // The 'id' for a notification would be undefined or null.
    if (method === 'notifications/cancelled') {
      logToFileInternal(`[MCP handleMCPRequest] Received notification: ${method}, params: ${JSON.stringify(params)}. No response will be sent.`);
      // Return undefined to signal that no JSON-RPC response should be sent.
      // The caller (e.g., stdio handler or HTTP router) should respect this.
      return undefined;
    }

    if (method === 'list_tools' || method === 'tools/list') {
      logToFileInternal(`[MCP handleMCPRequest] Handling '${method}' method.`);
      const toolList = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      return { jsonrpc: '2.0', id, result: { tools: toolList } };
    }

    if (method === 'tools/call') {
      logToFileInternal(`[MCP handleMCPRequest] Handling 'tools/call' method for tool: ${params?.name}`);
      if (!params || typeof params.name !== 'string') {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: name is required' } };
      }
      const { name, arguments: args } = params;
      const tool = tools.find(t => t.name === name);

      if (!tool) {
        logToFileInternal(`[MCP handleMCPRequest] Tool not found: ${name}`);
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${name}` } };
      }

      const result = await tool.run(args || {}, services);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
    }

    logToFileInternal(`[MCP handleMCPRequest] Method not found: ${method}`);
    // Check if 'id' is present. If not, it might have been a notification that wasn't caught above.
    // However, for a truly unknown method that IS a request (has an ID), an error response is appropriate.
    if (id !== undefined && id !== null) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    } else {
      // If it was an unknown notification (no ID), technically no response, but we've logged it.
      // Returning undefined here too ensures consistency for unhandled notifications.
      logToFileInternal(`[MCP handleMCPRequest] Unhandled notification-style message (no id) for method: ${method}. No response sent.`);
      return undefined;
    }
  } catch (err: any) {
    logToFileInternal(`[MCP handleMCPRequest] Error processing MCP request for method ${method}: ${err.message} ${err.stack}`);
    // Only send an error response if the original request had an ID
    if (id !== undefined && id !== null) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: `Server error: ${err.message}` } };
    } else {
      // Error during processing of a notification, log but send no response.
      logToFileInternal(`[MCP handleMCPRequest] Error processing notification ${method}: ${err.message} ${err.stack}. No response sent.`);
      return undefined;
    }
  }
}

export function registerMCPServer(
  app: Express | null, // app is now optional
  orchestratorService: OrchestratorService,
  repositoryManager: RepositoryManager,
  llmService: LLMService,
  knowledgeBaseService: KnowledgeBaseService
): void {
  const services = { orchestratorService, repositoryManager, llmService, knowledgeBaseService };
  loadTools(services); // Load tools regardless of mode

  if (app) { // HTTP mode
    const router = Router();
    router.post('/', async (req: Request, res: Response) => {
      const responseBody = await handleMCPRequest(req.body, services);
      // Determine status code based on presence of error in responseBody
      if (responseBody.error) {
        // Default to 500 if no specific error code implies a different HTTP status
        let statusCode = 500;
        if (responseBody.error.code === -32600) statusCode = 400; // Invalid Request
        if (responseBody.error.code === -32601) statusCode = 404; // Method not found
        if (responseBody.error.code === -32602) statusCode = 400; // Invalid params (treat as Bad Request)
        return res.status(statusCode).json(responseBody);
      } else {
        return res.json(responseBody);
      }
    });
    app.use('/mcp', router);
    console.log('[MCP] HTTP MCP server routes registered under /mcp using JSON-RPC 2.0');
  } else { // Stdio mode (or other non-HTTP modes)
    console.log('[MCP] Server configured for non-HTTP mode. Tool loading complete.');
    // Stdio listener will call handleMCPRequest directly. Setup for that is in src/index.ts / stdioServer.ts
  }
} 