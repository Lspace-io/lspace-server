import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { handleMCPRequest } from './registerTools'; // Restore full handler
import { OrchestratorService } from '../orchestrator/orchestratorService';
import { RepositoryManager } from '../core/repositoryManager';
import { LLMService } from '../orchestrator/llmService';
import { KnowledgeBaseService } from '../knowledge-base/knowledgeBaseService';

const mcpLogFilePath = path.join(process.cwd(), 'mcp_stdio_debug.log');
const logToFile = (message: string) => {
  try {
    fs.appendFileSync(mcpLogFilePath, `[${new Date().toISOString()}] ${message}\n`);
  } catch (err) {
    // console.error might interfere with stdio
  }
};

interface MCPServices {
  orchestratorService: OrchestratorService;
  repositoryManager: RepositoryManager;
  llmService: LLMService;
  knowledgeBaseService: KnowledgeBaseService;
}

export function startStdioListener(services: MCPServices): void {
  logToFile('[MCP-Stdio] Initializing stdio listener (FULL HANDLER MODE)...');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  let requestCounter = 0;

  rl.on('line', async (line) => {
    requestCounter++;
    logToFile(`[MCP-Stdio] Received line #${requestCounter}: ${line.substring(0, 150)}`);
    try {
      const requestBody = JSON.parse(line);
      
      // Ensure we're not sending any extra output to stdout
      if (process.stdout.write.length > 0) {
        process.stdout.write = function() {
          return true;
        };
      }
      
      // Use the full handleMCPRequest again
      const responseBody = await handleMCPRequest(requestBody, services);
      
      // If responseBody is undefined (e.g. for a notification), do not send a response.
      if (responseBody !== undefined) {
        const responseString = JSON.stringify(responseBody);
        // Write response to stdout with explicit flush
        try {
          process.stdout.write(responseString + '\n');
          // Force flush immediately
          process.stdout.cork();
          process.stdout.uncork();
          logToFile(`[MCP-Stdio] Sent response #${requestCounter}: ${responseString.substring(0,150)}`);
        } catch (err: any) {
          logToFile(`[MCP-Stdio] Error writing response: ${err.message}`);
        }
      } else {
        // Log that no response is sent for this request (e.g. it was a notification)
        logToFile(`[MCP-Stdio] No response sent for request #${requestCounter} as it was a notification or did not require a response.`);
      }
    } catch (error: any) {
      logToFile(`[MCP-Stdio] Error processing line #${requestCounter}: ${error.message} ${error.stack}`);
      let id = null;
      try { id = JSON.parse(line).id || null; } catch (_) {}
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error or handler error' }}) + '\n', 'utf8');
    }
  });

  rl.on('close', () => {
    logToFile('[MCP-Stdio] Stdin stream closed.');
    // Don't exit immediately - let the process stay alive
    // Cursor will terminate it when needed
  });
  rl.on('error', (err) => {
    logToFile(`[MCP-Stdio] Error on readline interface: ${err.message}`);
  });

  process.on('uncaughtException', (err) => {
    logToFile(`[MCP-Stdio] UNCAUGHT EXCEPTION: ${err.message} ${err.stack}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const reasonMsg = reason instanceof Error ? reason.message : String(reason);
    const reasonStack = reason instanceof Error ? reason.stack : '';
    logToFile(`[MCP-Stdio] UNHANDLED REJECTION: ${reasonMsg} ${reasonStack}`);
    process.exit(1);
  });

  logToFile('[MCP-Stdio] Stdio listener started (FULL HANDLER MODE). Waiting for requests...');
} 