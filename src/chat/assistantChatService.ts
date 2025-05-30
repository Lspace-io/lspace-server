import OpenAI from 'openai';
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { RepositoryManager } from '../core/repositoryManager';

// In-memory store for repoId -> assistantId mapping
const assistantStore = new Map<string, string>();
// In-memory store for repoId -> vectorStoreId mapping (for knowledge base)
const vectorStoreMap = new Map<string, string>();

// A simple delay function for polling
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Tool definition for proposing file creation
const proposeKbFileCreationTool = {
  type: 'function' as const,
  function: {
    name: 'propose_kb_file_creation',
    description: "Use this tool to propose the creation of a new file in the knowledge base. Provide the full path relative to the 'knowledge-base/' directory and the complete content for the file.",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The path for the new file, relative to the 'knowledge-base/' directory (e.g., 'new-topic/summary.md'). Do not include 'knowledge-base/' in this path; it will be added automatically.",
        },
        content: {
          type: "string",
          description: "The full text content for the new file.",
        },
      },
      required: ["filePath", "content"],
    },
  },
};

const proposeKbFileEditTool = {
  type: 'function' as const,
  function: {
    name: 'propose_kb_file_edit',
    description: "Use this tool to propose an update to an existing file in the knowledge base. Provide the full path relative to the 'knowledge-base/' directory and the complete new content for the file.",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The path of the file to edit, relative to the 'knowledge-base/' directory (e.g., 'existing-topic/summary.md'). Do not include 'knowledge-base/' in this path.",
        },
        newContent: {
          type: "string",
          description: "The full new text content for the file.",
        },
        // Optional: Add a reason later if needed
        // reason: {
        //   type: "string",
        //   description: "A brief reason for proposing this edit."
        // }
      },
      required: ["filePath", "newContent"],
    },
  },
};

const proposeKbFileDeleteTool = {
  type: 'function' as const,
  function: {
    name: 'propose_kb_file_delete',
    description: "Use this tool to propose the deletion of an existing file in the knowledge base. Provide the full path relative to the 'knowledge-base/' directory.",
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The path of the file to delete, relative to the 'knowledge-base/' directory (e.g., 'old-topic/summary.md'). Do not include 'knowledge-base/' in this path.",
        },
        // Optional: Add a reason later if needed
        // reason: {
        //   type: "string",
        //   description: "A brief reason for proposing this deletion."
        // }
      },
      required: ["filePath"],
    },
  },
};

export type AssistantResponseMessage = {
  type: 'message' | 'error' | 'action_request';
  id: string;
  content: string | { 
    toolCallId: string; 
    runId: string;
    threadId: string;
    toolName: string; 
    toolArgs: any; 
    messageForUser: string; 
  };
  timestamp: Date; 
};

export class AssistantChatService {
  private openai: OpenAI;
  private repositoryManager: RepositoryManager;

  constructor(repositoryManager: RepositoryManager) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set.');
    }
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.repositoryManager = repositoryManager;
  }

  private async listFilesInDirectory(dirPath: string): Promise<string[]> {
    const allFiles: string[] = [];
    try {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          allFiles.push(...await this.listFilesInDirectory(fullPath));
        } else if (entry.isFile()) {
          // Ignore common system/hidden files
          if (!entry.name.startsWith('.') && entry.name !== 'desktop.ini') {
            allFiles.push(fullPath);
          }
        }
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.warn(`[AssistantChatService] Directory not found for listing files: ${dirPath}`);
        return []; 
      }
      console.error(`[AssistantChatService] Error listing files in directory ${dirPath}:`, error);
      // For now, let's not re-throw, allow to proceed with empty files if specific dir fails for non-ENOENT
      // throw error; 
    }
    return allFiles;
  }

  private async getRepositoryPath(repoId: string): Promise<string | null> {
    try {
      const repository = this.repositoryManager.getRepository(repoId);
      return repository.path;
    } catch (error) {
      console.error(`[AssistantChatService] Error getting repository path for ${repoId}:`, error);
      return null;
    }
  }

  // Added private helper for path sanitization related to KB operations
  private async sanitizeKbPath(repoId: string, relativeFilePath: string): Promise<string | null> {
    const repoPath = await this.getRepositoryPath(repoId);
    if (!repoPath) {
      console.error(`[AssistantChatService] Could not get repository path for ${repoId} during path sanitization.`);
      return null;
    }
    const kbDir = path.join(repoPath, 'knowledge-base');
    
    const fullPath = path.join(kbDir, relativeFilePath);
    const normalizedFullPath = path.normalize(fullPath);
    const normalizedKbDir = path.normalize(kbDir);

    if (normalizedFullPath.startsWith(normalizedKbDir) && normalizedFullPath !== normalizedKbDir) {
      // Ensure it's strictly within kbDir and not kbDir itself.
      // Also check for '..' in the original relativeFilePath as an extra precaution,
      // though path.normalize should handle it.
      if (!relativeFilePath.includes('..')) {
        return normalizedFullPath;
      }
    }
    console.warn(`[AssistantChatService] Invalid or traversal attempt in KB path: repoId='${repoId}', relativeFilePath='${relativeFilePath}', resolved='${normalizedFullPath}'`);
    return null;
  }

  private async getOrCreateRepositoryAssistant(repoId: string): Promise<OpenAI.Beta.Assistant> {
    console.log(`[AssistantChatService] getOrCreateRepositoryAssistant called for repoId: ${repoId}`);
    let existingAssistantId = assistantStore.get(repoId);
    let existingVectorStoreId = vectorStoreMap.get(repoId);

    if (existingAssistantId) {
      try {
        const assistant = await this.openai.beta.assistants.retrieve(existingAssistantId);
        console.log(`[AssistantChatService] Retrieved existing assistant ${assistant.id} for repoId ${repoId}`);
        // For this phase, assume if assistant exists, it's configured with its VS.
        // A more robust check/update could be added later.
        // Example: Check if tool_resources and vector_store_ids are correctly set
        // if (!assistant.tool_resources?.file_search?.vector_store_ids?.includes(existingVectorStoreId!)) {
        //   console.warn(`[AssistantChatService] Existing assistant ${assistant.id} found but not configured with VS ${existingVectorStoreId}. Reconfiguring...`);
        //   // This would require an update call, which adds complexity for now.
        // }
        return assistant;
      } catch (error) {
        console.warn(`[AssistantChatService] Failed to retrieve existing assistant ${existingAssistantId}, will create new one:`, error);
        assistantStore.delete(repoId);
        // If assistant retrieval fails, its associated VS might still exist or be orphaned.
        // For simplicity, we will also remove our local mapping for the VS if assistant retrieval failed,
        // forcing a new VS creation or retrieval logic below if the assistant is recreated.
        if(existingVectorStoreId) {
            vectorStoreMap.delete(repoId); 
            existingVectorStoreId = undefined; // Ensure it's treated as not existing for the logic below
        }
        existingAssistantId = undefined;
      }
    }

    // If no existing assistantId, or retrieval failed:
    console.log(`[AssistantChatService] No valid existing assistant found for repoId ${repoId}. Proceeding with creation/setup.`);

    let vectorStoreIdToUse: string | undefined = existingVectorStoreId;

    if (vectorStoreIdToUse) {
        try {
            await this.openai.vectorStores.retrieve(vectorStoreIdToUse);
            console.log(`[AssistantChatService] Successfully retrieved existing vector store ${vectorStoreIdToUse} for repoId ${repoId}.`);
        } catch (vsError: any) {
            if (vsError.status === 404) {
                console.warn(`[AssistantChatService] Vector store ${vectorStoreIdToUse} (from map) not found on OpenAI for repoId ${repoId}. Will create a new one.`);
                vectorStoreMap.delete(repoId);
                vectorStoreIdToUse = undefined;
            } else {
                console.error(`[AssistantChatService] Error retrieving vector store ${vectorStoreIdToUse}:`, vsError);
                throw vsError; // Rethrow if it's not a 404, as it's an unexpected issue
            }
        }
    }
    
    if (!vectorStoreIdToUse) {
      console.log(`[AssistantChatService] Creating new vector store for repoId ${repoId}`);
      try {
        const vectorStore = await this.openai.vectorStores.create({
          name: `KB for ${repoId} - Lspace`,
        });
        if (typeof vectorStore.id === 'string') {
            vectorStoreIdToUse = vectorStore.id;
            vectorStoreMap.set(repoId, vectorStore.id);
            console.log(`[AssistantChatService] Created new vector store ${vectorStore.id} for repoId ${repoId}. Populating with KB & Raw files...`);

            const repoPath = await this.getRepositoryPath(repoId);
            if (repoPath) {
              const kbPath = path.join(repoPath, 'knowledge-base');
              const rawPath = path.join(repoPath, 'raw'); // Path for raw files
              let allFilePathsToUpload: string[] = [];

              console.log(`[AssistantChatService] Looking for KB files in: ${kbPath}`);
              const kbFilePaths = await this.listFilesInDirectory(kbPath);
              if (kbFilePaths.length > 0) {
                console.log(`[AssistantChatService] Found ${kbFilePaths.length} KB files.`);
                allFilePathsToUpload.push(...kbFilePaths);
              }

              console.log(`[AssistantChatService] Looking for Raw files in: ${rawPath}`);
              const rawFilePaths = await this.listFilesInDirectory(rawPath);
              if (rawFilePaths.length > 0) {
                console.log(`[AssistantChatService] Found ${rawFilePaths.length} Raw files.`);
                allFilePathsToUpload.push(...rawFilePaths);
              }

              if (allFilePathsToUpload.length > 0) {
                console.log(`[AssistantChatService] Found ${allFilePathsToUpload.length} total files to upload to vector store ${vectorStoreIdToUse}.`);
                
                 const fileStreams = allFilePathsToUpload.map(fp => fs.createReadStream(fp));

                if (fileStreams.length > 0) {
                     await this.openai.vectorStores.fileBatches.uploadAndPoll(vectorStoreIdToUse, {files: fileStreams});
                     console.log(`[AssistantChatService] Successfully uploaded ${fileStreams.length} files to vector store ${vectorStoreIdToUse}.`);
                }
              } else {
                console.log(`[AssistantChatService] No files found in knowledge-base or raw directories for repoId ${repoId}. Vector store ${vectorStoreIdToUse} will be empty initially.`);
              }
            } else {
              console.warn(`[AssistantChatService] Could not get repository path for ${repoId}. Cannot populate vector store.`);
            }
        } else {
            console.error(`[AssistantChatService] Failed to create vector store or received invalid ID for repoId ${repoId}.`);
            throw new Error('Vector store creation failed or returned an invalid ID.');
        }
      } catch (error) {
        console.error(`[AssistantChatService] Error during vector store creation or file upload for repoId ${repoId}:`, error);
        // If VS creation or population fails, we probably shouldn't create an assistant that expects it.
        throw error; 
      }
    }

    if (!vectorStoreIdToUse) {
        // This should not happen if the logic above is correct, but as a safeguard:
        console.error(`[AssistantChatService] Critical error: vectorStoreIdToUse is undefined before assistant creation for repo ${repoId}.`);
        throw new Error("Failed to obtain a valid vector store ID.");
    }

    console.log(`[AssistantChatService] Creating new assistant for repoId ${repoId} with vector store ${vectorStoreIdToUse}`);
    const assistantInstructions = "You are a helpful assistant for the Lspace project. You can search the knowledge base files and raw uploaded files associated with this repository to answer questions. When asked about information that might be in these files, use your file search tool. If you need to create a new file in the knowledge base, use the `propose_kb_file_creation` tool. If you need to update an existing file, use the `propose_kb_file_edit` tool. If you need to delete a file from the knowledge base, use the `propose_kb_file_delete` tool. For all file operation tools, provide the `filePath` relative to the 'knowledge-base/' directory (e.g., 'summary.md' or 'topic/detail.md'). When referencing files, use Markdown links like [filename.md](knowledge-base/filename.md).";
    
    const assistant = await this.openai.beta.assistants.create({
      name: `Lspace KB+Raw Assistant for ${repoId}`,
      instructions: assistantInstructions,
      model: "gpt-4o", 
      tools: [{ type: 'file_search' }, proposeKbFileCreationTool, proposeKbFileEditTool, proposeKbFileDeleteTool],
      tool_resources: { file_search: { vector_store_ids: [vectorStoreIdToUse!] } }
    });
    assistantStore.set(repoId, assistant.id);
    console.log(`[AssistantChatService] Created new assistant ${assistant.id} for repoId ${repoId}, linked to vector store ${vectorStoreIdToUse}`);
    return assistant;
  }

  public async handleUserMessage(
    repoId: string,
    userId: string | undefined,
    message: string,
    threadId?: string
  ): Promise<{ assistantResponse: AssistantResponseMessage; threadId: string }> {
    console.log(`[AssistantChatService] handleUserMessage called for repoId: ${repoId}, threadId: ${threadId}`);
    
    const assistant = await this.getOrCreateRepositoryAssistant(repoId);
    let currentThreadId = threadId;

    if (!currentThreadId) {
      const thread = await this.openai.beta.threads.create();
      currentThreadId = thread.id;
      console.log(`[AssistantChatService] Created new thread ${currentThreadId}`);
    } else {
      if (typeof currentThreadId !== 'string') {
        console.error('[AssistantChatService] Invalid threadId provided.');
        // Consider how to handle this – perhaps return an error response
        // For now, let's mimic the behavior of creating a new thread if invalid.
        const thread = await this.openai.beta.threads.create();
        currentThreadId = thread.id;
        console.warn(`[AssistantChatService] Invalid threadId received, created new thread ${currentThreadId}`);
      } else {
        console.log(`[AssistantChatService] Using existing thread ${currentThreadId}`);
      }
    }

    await this.openai.beta.threads.messages.create(currentThreadId, {
      role: 'user',
      content: message,
    });
    console.log(`[AssistantChatService] Added user message to thread ${currentThreadId}`);

    let run = await this.openai.beta.threads.runs.createAndPoll(currentThreadId, {
        assistant_id: assistant.id,
    });
    console.log(`[AssistantChatService] Created run ${run.id} for thread ${currentThreadId}, initial status: ${run.status}`);
    
    // Loop for polling run status if it's not immediately completed or requires action
    // OpenAI's createAndPoll should handle this, but if we needed manual polling:
    // while (run.status === 'queued' || run.status === 'in_progress' || run.status === 'cancelling') {
    //   await delay(1000); // Poll every 1 second
    //   run = await this.openai.beta.threads.runs.retrieve(currentThreadId, run.id);
    //   console.log(`[AssistantChatService] Run ${run.id} status: ${run.status}`);
    // }
    // createAndPoll handles the polling until a terminal state (completed, failed, etc.) or requires_action.

    if (run.status === 'requires_action') {
      console.log(`[AssistantChatService] Run ${run.id} requires action.`);
      if (run.required_action && run.required_action.type === 'submit_tool_outputs') {
        const toolCall = run.required_action.submit_tool_outputs.tool_calls[0]; // Assuming one tool call for now
        const toolArgs = JSON.parse(toolCall.function.arguments);
        let messageForUser = "";

        if (toolCall.function.name === 'propose_kb_file_creation') {
          console.log(`[AssistantChatService] Action required: ${toolCall.function.name}`);
          messageForUser = `The assistant proposes to create a file at 'knowledge-base/${toolArgs.filePath}' with the provided content. Do you approve?`;
          if (toolArgs.filePath.startsWith('knowledge-base/')) { // Defensive check
            messageForUser = `The assistant proposes to create a file at '${toolArgs.filePath}' with the provided content. Do you approve?`;
          }
        } else if (toolCall.function.name === 'propose_kb_file_edit') {
          console.log(`[AssistantChatService] Action required: ${toolCall.function.name}`);
          messageForUser = `The assistant proposes to edit the file 'knowledge-base/${toolArgs.filePath}' with new content. Do you approve?`;
          if (toolArgs.filePath.startsWith('knowledge-base/')) { // Defensive check
            messageForUser = `The assistant proposes to edit the file '${toolArgs.filePath}' with new content. Do you approve?`;
          }
        } else if (toolCall.function.name === 'propose_kb_file_delete') {
          console.log(`[AssistantChatService] Action required: ${toolCall.function.name}`);
          messageForUser = `The assistant proposes to delete the file 'knowledge-base/${toolArgs.filePath}'. Do you approve?`;
          if (toolArgs.filePath.startsWith('knowledge-base/')) { // Defensive check
            messageForUser = `The assistant proposes to delete the file '${toolArgs.filePath}'. Do you approve?`;
          }
        } else {
          // Handle other tool calls or unknown tool calls if necessary
          console.warn(`[AssistantChatService] Run ${run.id} requires action for unhandled tool: ${toolCall.function.name}`);
           return { 
            assistantResponse: {
              type: 'error',
              id: run.id,
              content: `Run requires action for an unhandled tool: ${toolCall.function.name}`,
              timestamp: new Date(),
            },
            threadId: currentThreadId,
          };
        }

        // Common return structure for action_request
        return {
          assistantResponse: {
            type: 'action_request',
            id: toolCall.id, 
            content: {
              toolCallId: toolCall.id,
              runId: run.id,
              threadId: currentThreadId,
              toolName: toolCall.function.name,
              toolArgs: toolArgs,
              messageForUser: messageForUser,
            },
            timestamp: new Date(),
          },
          threadId: currentThreadId,
        };
      }
    }

    if (run.status === 'completed') {
      console.log(`[AssistantChatService] Run ${run.id} completed. Fetching messages.`);
      const messages = await this.openai.beta.threads.messages.list(currentThreadId, { limit: 1, order: 'desc' });
      const lastMessage = messages.data.find(m => m.role === 'assistant');

      if (lastMessage && lastMessage.content[0]?.type === 'text') {
        console.log(`[AssistantChatService] Got assistant response for thread ${currentThreadId}`);
        return {
          assistantResponse: {
            type: 'message',
            id: lastMessage.id,
            content: lastMessage.content[0].text.value,
            timestamp: new Date(lastMessage.created_at * 1000),
          },
          threadId: currentThreadId,
        };
      } else {
        console.warn(`[AssistantChatService] No suitable assistant message found after run ${run.id} completion.`);
        return {
          assistantResponse: { type: 'error', id: run.id, content: 'No response from assistant.', timestamp: new Date() },
          threadId: currentThreadId,
        };
      }
    } else {
      console.error(`[AssistantChatService] Run ${run.id} ended with status: ${run.status}. Error: ${run.last_error}`);
      let errorMessage = `Chat processing failed. Run status: ${run.status}`;
      if (run.last_error) {
        errorMessage = `Chat processing failed: ${run.last_error.message} (Code: ${run.last_error.code})`;
      }
      return {
        assistantResponse: { type: 'error', id: run.id, content: errorMessage, timestamp: new Date() },
        threadId: currentThreadId,
      };
    }
  }

  public async handleSubmitToolResult(
    repoId: string,
    userId: string | undefined, // Potentially for logging or finer-grained permissions later
    threadId: string,
    runId: string,
    toolCallId: string,
    toolName: string,
    toolArgs: any, // e.g., { filePath: string, content: string }
    decision: 'approved' | 'rejected'
  ): Promise<{ assistantResponse: AssistantResponseMessage; threadId: string }> {
    console.log(`[AssistantChatService] handleSubmitToolResult called for repoId: ${repoId}, threadId: ${threadId}, runId: ${runId}, tool: ${toolName}, decision: ${decision}`);
    let toolOutputString = "";

    if (toolName === 'propose_kb_file_creation') {
      if (decision === 'approved') {
        if (!toolArgs.filePath || typeof toolArgs.filePath !== 'string' || !toolArgs.content || typeof toolArgs.content !== 'string') {
            console.error("[AssistantChatService] Invalid filePath or content for file creation.");
            toolOutputString = JSON.stringify({ success: false, error: "Invalid arguments for file creation." });
        } else {
            const targetFilePath = await this.sanitizeKbPath(repoId, toolArgs.filePath);
            if (!targetFilePath) {
                toolOutputString = JSON.stringify({ success: false, error: `Invalid file path: ${toolArgs.filePath}. It might be outside the knowledge-base directory or contain invalid characters.` });
            } else {
                try {
                    const dirForFile = path.dirname(targetFilePath);
                    await fsp.mkdir(dirForFile, { recursive: true });
                    await fsp.writeFile(targetFilePath, toolArgs.content);
                    console.log(`[AssistantChatService] File created successfully: ${targetFilePath}`);
                    toolOutputString = JSON.stringify({ success: true, message: `File '${toolArgs.filePath}' created successfully.` });

                    // Update vector store (same logic as creation for now)
                    const vectorStoreId = vectorStoreMap.get(repoId);
                    if (vectorStoreId) {
                        console.log(`[AssistantChatService] Updating vector store ${vectorStoreId} with new file ${targetFilePath} (creation flow)`);
                        try {
                            const fileStream = fs.createReadStream(targetFilePath);
                            const fileObject = await this.openai.files.create({ file: fileStream, purpose: 'assistants' });
                            await this.openai.vectorStores.files.create(vectorStoreId, { file_id: fileObject.id });
                            console.log(`[AssistantChatService] Submitted file ${fileObject.id} (${toolArgs.filePath}) to vector store ${vectorStoreId}.`);
                        } catch (vsError) {
                            console.error(`[AssistantChatService] Failed to update vector store ${vectorStoreId} with file ${targetFilePath}:`, vsError);
                        }
                    } else {
                        console.warn(`[AssistantChatService] No vector store ID found for repo ${repoId}. Cannot update vector store.`);
                    }
                } catch (error: any) {
                    console.error(`[AssistantChatService] Error creating file ${targetFilePath}:`, error);
                    toolOutputString = JSON.stringify({ success: false, error: `Failed to create file: ${error.message}` });
                }
            }
        }
      } else { // Rejected
        toolOutputString = JSON.stringify({ success: false, message: 'User rejected the file creation proposal.' });
      }
    } else if (toolName === 'propose_kb_file_edit') {
      if (decision === 'approved') {
        if (!toolArgs.filePath || typeof toolArgs.filePath !== 'string' || !toolArgs.newContent || typeof toolArgs.newContent !== 'string') {
            console.error("[AssistantChatService] Invalid filePath or newContent for file edit.");
            toolOutputString = JSON.stringify({ success: false, error: "Invalid arguments for file edit." });
        } else {
            const targetFilePath = await this.sanitizeKbPath(repoId, toolArgs.filePath);
            if (!targetFilePath) {
                toolOutputString = JSON.stringify({ success: false, error: `Invalid file path: ${toolArgs.filePath}. It might be outside the knowledge-base directory or contain invalid characters.` });
            } else {
                try {
                    // Check if file exists before editing
                    await fsp.access(targetFilePath); // Throws if doesn't exist
                    
                    await fsp.writeFile(targetFilePath, toolArgs.newContent);
                    console.log(`[AssistantChatService] File edited successfully: ${targetFilePath}`);
                    toolOutputString = JSON.stringify({ success: true, message: `File '${toolArgs.filePath}' edited successfully.` });

                    // Update vector store (same logic as creation for now, adds the new version)
                    const vectorStoreId = vectorStoreMap.get(repoId);
                    if (vectorStoreId) {
                        console.log(`[AssistantChatService] Updating vector store ${vectorStoreId} with edited file ${targetFilePath}`);
                        try {
                            const fileStream = fs.createReadStream(targetFilePath);
                            const fileObject = await this.openai.files.create({ file: fileStream, purpose: 'assistants' });
                            await this.openai.vectorStores.files.create(vectorStoreId, { file_id: fileObject.id });
                            console.log(`[AssistantChatService] Submitted updated file ${fileObject.id} (${toolArgs.filePath}) to vector store ${vectorStoreId} after edit.`);
                        } catch (vsError) {
                            console.error(`[AssistantChatService] Failed to update vector store ${vectorStoreId} with edited file ${targetFilePath}:`, vsError);
                        }
                    } else {
                        console.warn(`[AssistantChatService] No vector store ID found for repo ${repoId}. Cannot update vector store with edited file.`);
                    }
                } catch (error: any) {
                    if (error.code === 'ENOENT') {
                        console.error(`[AssistantChatService] Error editing file: File not found at ${targetFilePath}`);
                        toolOutputString = JSON.stringify({ success: false, error: `File not found: ${toolArgs.filePath}. Cannot edit.` });
                    } else {
                        console.error(`[AssistantChatService] Error editing file ${targetFilePath}:`, error);
                        toolOutputString = JSON.stringify({ success: false, error: `Failed to edit file: ${error.message}` });
                    }
                }
            }
        }
      } else { // Rejected
        toolOutputString = JSON.stringify({ success: false, message: 'User rejected the file edit proposal.' });
      }
    } else if (toolName === 'propose_kb_file_delete') {
      if (decision === 'approved') {
        if (!toolArgs.filePath || typeof toolArgs.filePath !== 'string') {
            console.error("[AssistantChatService] Invalid filePath for file deletion.");
            toolOutputString = JSON.stringify({ success: false, error: "Invalid arguments for file deletion." });
        } else {
            const targetFilePath = await this.sanitizeKbPath(repoId, toolArgs.filePath);
            if (!targetFilePath) {
                toolOutputString = JSON.stringify({ success: false, error: `Invalid file path: ${toolArgs.filePath}. It might be outside the knowledge-base directory or contain invalid characters.` });
            } else {
                try {
                    // Check if file exists before deleting
                    await fsp.access(targetFilePath); // Throws if doesn't exist
                    
                    await fsp.unlink(targetFilePath);
                    console.log(`[AssistantChatService] File deleted successfully: ${targetFilePath}`);
                    toolOutputString = JSON.stringify({ success: true, message: `File '${toolArgs.filePath}' deleted successfully.` });

                    // Vector Store: For now, we are not removing the file from the vector store.
                    // This is a limitation as the VS might contain outdated information.
                    // Future enhancement: Implement mapping of filePath to OpenAI file_id for precise deletion from VS.
                    const vectorStoreId = vectorStoreMap.get(repoId);
                    if (vectorStoreId) {
                         console.warn(`[AssistantChatService] File ${targetFilePath} was deleted from the filesystem, but its content may still exist in vector store ${vectorStoreId}. The vector store may need to be rebuilt or a more granular file deletion from the VS needs to be implemented.`);
                    }

                } catch (error: any) {
                    if (error.code === 'ENOENT') {
                        console.error(`[AssistantChatService] Error deleting file: File not found at ${targetFilePath}`);
                        toolOutputString = JSON.stringify({ success: false, error: `File not found: ${toolArgs.filePath}. Cannot delete.` });
                    } else {
                        console.error(`[AssistantChatService] Error deleting file ${targetFilePath}:`, error);
                        toolOutputString = JSON.stringify({ success: false, error: `Failed to delete file: ${error.message}` });
                    }
                }
            }
        }
      } else { // Rejected
        toolOutputString = JSON.stringify({ success: false, message: 'User rejected the file deletion proposal.' });
      }
    } else {
      console.warn(`[AssistantChatService] Received tool result for unhandled tool: ${toolName}`);
      toolOutputString = JSON.stringify({ success: false, error: `Tool ${toolName} is not handled by the approval/rejection flow.` });
    }

    if (!toolOutputString) { // Should not happen if logic above is correct
        console.error("[AssistantChatService] toolOutputString is empty, which is an error. Defaulting to a generic error for OpenAI.");
        toolOutputString = JSON.stringify({ success: false, error: "Internal error processing tool result."});
    }
    
    console.log(`[AssistantChatService] Submitting tool output for toolCallId ${toolCallId}: ${toolOutputString}`);

    // Submit tool output and poll
    // Note: createAndPoll is not for submitting tool outputs. Use submitToolOutputs and then poll.
    try {
        await this.openai.beta.threads.runs.submitToolOutputs(threadId, runId, {
            tool_outputs: [{ tool_call_id: toolCallId, output: toolOutputString }],
        });
        console.log(`[AssistantChatService] Submitted tool outputs for run ${runId}. Polling for completion...`);

        let run = await this.openai.beta.threads.runs.retrieve(threadId, runId);
        // Polling loop
        while (run.status === 'queued' || run.status === 'in_progress' || run.status === 'cancelling') {
            await delay(1000); // Poll every 1 second
            run = await this.openai.beta.threads.runs.retrieve(threadId, runId);
            console.log(`[AssistantChatService] Polling Run ${run.id} status: ${run.status}`);
        }
        console.log(`[AssistantChatService] Polling finished for Run ${run.id}. Final status: ${run.status}`);


        if (run.status === 'completed') {
            const messages = await this.openai.beta.threads.messages.list(threadId, { limit: 1, order: 'desc' });
            const lastMessage = messages.data.find(m => m.role === 'assistant');
            if (lastMessage && lastMessage.content[0]?.type === 'text') {
                 console.log(`[AssistantChatService] Got assistant response post-tool-submission for thread ${threadId}`);
                return {
                    assistantResponse: {
                        type: 'message',
                        id: lastMessage.id,
                        content: lastMessage.content[0].text.value,
                        timestamp: new Date(lastMessage.created_at * 1000),
                    },
                    threadId: threadId,
                };
            } else {
                console.warn(`[AssistantChatService] No suitable assistant message found after run ${run.id} completion (post-tool).`);
                return {
                    assistantResponse: { type: 'error', id: run.id, content: 'No response from assistant after tool submission.', timestamp: new Date() },
                    threadId: threadId,
                };
            }
        } else {
             console.error(`[AssistantChatService] Run ${run.id} (post-tool) ended with status: ${run.status}. Error: ${run.last_error}`);
             let errorMessage = `Chat processing failed after tool submission. Run status: ${run.status}`;
            if (run.last_error) {
                errorMessage = `Chat processing failed after tool submission: ${run.last_error.message} (Code: ${run.last_error.code})`;
            }
            return {
                assistantResponse: { type: 'error', id: run.id, content: errorMessage, timestamp: new Date() },
                threadId: threadId,
            };
        }

    } catch (error: any) {
        console.error(`[AssistantChatService] Error submitting tool outputs or polling for run ${runId}:`, error);
        // Check if error is an OpenAIAPIError and has a status property
        let errorContent = 'Failed to submit tool outputs or process further.';
        if (error instanceof OpenAI.APIError) {
             errorContent = `OpenAI API Error: ${error.message} (Status: ${error.status}, Type: ${error.type})`;
        } else if (error.message) {
            errorContent = error.message;
        }
        return {
            assistantResponse: {
                type: 'error',
                id: runId, // or a new error ID
                content: errorContent,
                timestamp: new Date(),
            },
            threadId: threadId,
        };
    }
  }
} 