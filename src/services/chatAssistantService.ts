import { Repository } from '../core/repository';
import { toolDefinitions } from '../config/prompts';
// import { IFile } from '../core/types/file'; // Unused, and true path uncertain
// import { KnowledgeBaseService } from './knowledgeBaseService'; // For KB path - Service does not exist
import { FileChangeOperation, FileChangeInfo } from '../core/types/commonTypes';
import { LLMService, ConversationTurn } from '../orchestrator/llmService'; // Import LLMService and ConversationTurn
import { TimelineService } from '../core/timelineService'; // Import TimelineService


// TODO: Define a more specific LlmProvider interface if direct LLM interaction is handled here.
// For now, we assume an abstract LLM interaction mechanism.

const chatSystemPrompt = `\
You are an AI assistant helping a user manage their knowledge base.
You have access to a set of tools to read, write, edit, and delete files and directories within the knowledge base.
The knowledge base is located under the 'knowledge-base/' directory in the repository.
All file paths you provide to tools MUST be relative to the root of the repository and start with 'knowledge-base/'.
When a user asks to rename a file, you should use 'write_file' for the new path and 'delete_file' for the old path.
Respond to the user's request by performing the necessary actions using the available tools.
When you have completed all tool actions for a given user request and are ready to provide a final message to the user, 
you MUST respond with a JSON object in your content field, structured as follows:
{
  "status": "completed_chat_interaction",
  "summary": "A concise summary of the actions taken (e.g., 'Renamed file X to Y and updated links.')",
  "final_message_to_user": "A message to display to the user confirming the actions."
}

Think step-by-step. If a user asks to rename 'knowledge-base/ideas/old.md' to 'knowledge-base/concepts/new.md', you would:
1. Call 'read_file' on 'knowledge-base/ideas/old.md'.
2. Call 'write_file' for 'knowledge-base/concepts/new.md' with the content.
3. Call 'delete_file' on 'knowledge-base/ideas/old.md'.
4. Then, respond with the 'completed_chat_interaction' JSON structure described above.

Available tools (you will call these using the native tool calling mechanism, not by putting JSON in your content unless it is the final completion signal):
${toolDefinitions.map(t => `- ${t.name}: ${t.description}`).join('\n')}
`;

interface LlmToolCallRequest {
  tool_name: string;
  tool_parameters: any;
}

// LLM is expected to respond with either a tool call or this completion object for chat
interface LlmChatCompletionResponse {
  status: 'completed_chat_interaction';
  summary: string;
  final_message_to_user: string;
}

// Type for what our Chat LLM interaction loop expects from LLMService
// It could be a raw string (direct answer), a tool call object, or the final chat completion object.
type ExpectedLlmOutputType = LlmToolCallRequest | LlmChatCompletionResponse | string;


export class ChatAssistantService {
  private repository: Repository;
  private llmService: LLMService;
  private timelineService: TimelineService;
  private kbPath: string;

  constructor(repository: Repository, llmService: LLMService, timelineService: TimelineService) {
    this.repository = repository;
    this.llmService = llmService;
    this.timelineService = timelineService;
    this.kbPath = 'knowledge-base'; // Hardcoded KB path
  }

  private async executeToolCall(toolName: string, toolParameters: any): Promise<any> {
    // Ensure paths are correctly scoped to the knowledge base if necessary,
    // or that tools handle paths as expected by the LLM (e.g. relative to repo root).
    // The current system prompt instructs LLM to use paths like 'knowledge-base/file.md'.
    
    if (toolParameters.path && typeof toolParameters.path === 'string') {
        if (!toolParameters.path.startsWith(this.kbPath + '/') && toolParameters.path !== this.kbPath && toolParameters.path !== (this.kbPath + '/')) {
             throw new Error(`Tool path parameter must be within the '${this.kbPath}/' directory or be '${this.kbPath}'. Path: ${toolParameters.path}`);
        }
        if (toolParameters.path.includes('..')) {
            throw new Error(`Tool path parameter must not contain '..'. Path: ${toolParameters.path}`);
        }
    }

    console.log(`[ChatService] Executing tool: ${toolName} with params:`, toolParameters);
    switch (toolName) {
      case 'read_file':
        try {
            const content = await this.repository.readFile(toolParameters.path);
            return content === null ? "File not found or is empty." : content;
        } catch (error) {
            console.error(`[ChatService] Error reading file ${toolParameters.path}:`, error);
            return `Error reading file: ${(error as Error).message}`;
        }
      case 'write_file':
        await this.repository.writeFile(toolParameters.path, toolParameters.content);
        return `File ${toolParameters.path} written successfully.`;
      case 'edit_file':
        await this.repository.writeFile(toolParameters.path, toolParameters.edits);
        return `File ${toolParameters.path} edited successfully.`;
      case 'create_directory':
        await this.repository.createDirectory(toolParameters.path);
        return `Directory ${toolParameters.path} created successfully.`;
      case 'list_directory':
        const filesInfo = await this.repository.listFiles(toolParameters.path);
        return filesInfo.map(info => info.path);
      case 'get_file_tree':
        // TODO: Implement recursive file tree if required by LLM expectation
        return await this.repository.listFiles(toolParameters.path); 
      case 'delete_file':
        await this.repository.deleteFile(toolParameters.path);
        return `File ${toolParameters.path} deleted successfully.`;
      default:
        // console.error(`[ChatService] Unknown tool called: ${toolName}`); // Keep for server logs
        // throw new Error(`Unknown tool: ${toolName}`); // Old behavior
        return `Error: Tool '${toolName}' is not available or recognized in this chat context.`; // New behavior
    }
  }

  public async processUserMessage(
    userId: string, 
    repoId: string, 
    userMessage: string
  ): Promise<LlmChatCompletionResponse> {
    
    await this.llmService.updateRepositoryPath(this.repository.path);

    const conversationHistory: ConversationTurn[] = [
      { role: 'system', content: chatSystemPrompt },
      { role: 'user', content: userMessage }
    ];
    
    const MAX_ITERATIONS = 10;
    let iterations = 0;
    const toolExecutionResultsForCommit: Array<{tool_name: string; output: any; params: any}> = [];

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      console.log(`[ChatService] Conversation Turn: ${iterations}`);
      const llmResponseString = await this.llmService.callLLMWithHistory(conversationHistory, toolDefinitions, true);

      if (!llmResponseString) {
        console.error("[ChatService] LLM returned null or empty response.");
        return {
          status: "completed_chat_interaction",
          summary: "Error: LLM returned no response.",
          final_message_to_user: "Sorry, I received an empty response from the assistant. Please try again."
        };
      }

      let llmMessageObject: any; // Holds the parsed {role, content, tool_calls} object from LLM
      try {
        llmMessageObject = JSON.parse(llmResponseString);
      } catch (e) {
        console.warn("[ChatService] LLM response was not valid JSON. Treating as direct string message:", llmResponseString);
        // If parsing fails, assume it's a direct text response that concludes the interaction.
        conversationHistory.push({ role: 'assistant', content: llmResponseString });
        // No file changes to commit in this scenario.
        return {
          status: "completed_chat_interaction",
          summary: "LLM provided a direct text response.",
          final_message_to_user: llmResponseString
        };
      }

      // Add LLM's full response object to history (this is what OpenAI API returns)
      conversationHistory.push({ role: 'assistant', content: llmMessageObject });

      if (llmMessageObject.tool_calls && llmMessageObject.tool_calls.length > 0) {
        // LLM wants to call one or more tools (Native Tool Calling)
        for (const toolCall of llmMessageObject.tool_calls) {
          if (toolCall.type === 'function') {
            const toolName = toolCall.function.name;
            const toolArguments = JSON.parse(toolCall.function.arguments || '{}');
            
            try {
              console.log(`[ChatService] LLM requesting tool (native): ${toolName} with args:`, toolArguments);
              const toolOutput = await this.executeToolCall(toolName, toolArguments);
              toolExecutionResultsForCommit.push({ tool_name: toolName, output: toolOutput, params: toolArguments });
              conversationHistory.push({ 
                  role: 'tool', 
                  tool_call_id: toolCall.id, 
                  name: toolName, 
                  content: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput)
              });
            } catch (error) {
              console.error(`[ChatService] Error executing tool ${toolName}:`, error);
              const errorMessage = `Error: ${(error as Error).message}`;
              toolExecutionResultsForCommit.push({ tool_name: toolName, output: errorMessage, params: toolArguments });
              conversationHistory.push({ 
                  role: 'tool', 
                  tool_call_id: toolCall.id,
                  name: toolName, 
                  content: errorMessage 
              });
            }
          }
        }
        continue; // Go back to LLM with tool results
      } else if (llmMessageObject.content) {
        // LLM provided content. Check for completion signal, fallback tool call, or direct message.
        let potentialToolCallInContent: LlmToolCallRequest | null = null;
        let potentialCompletionResponse: LlmChatCompletionResponse | null = null;
        let isDirectTextMessage = false;

        try {
          const parsedContent = JSON.parse(llmMessageObject.content);
          if (parsedContent.status === 'completed_chat_interaction' && parsedContent.summary && parsedContent.final_message_to_user) {
            potentialCompletionResponse = parsedContent as LlmChatCompletionResponse;
          } else if (parsedContent.tool_name && parsedContent.tool_parameters) {
            // Fallback: LLM used the old format for a tool call in content
            potentialToolCallInContent = parsedContent as LlmToolCallRequest;
          }
        } catch (e) {
          // Content was not JSON, so it's a direct text message from the LLM.
          isDirectTextMessage = true;
        }

        if (potentialCompletionResponse) {
          console.log("[ChatService] LLM signaled completed_chat_interaction via content.");
          // Commit changes before returning
          const commitMessage = `chore(chat): ${potentialCompletionResponse.summary}`;
          const author = { name: 'Chat Assistant', email: 'assistant@example.com' };
          const changedFilePaths: string[] = [];
          for (const result of toolExecutionResultsForCommit) {
              if (result.output && typeof result.output === 'string' && !result.output.startsWith('Error:')) {
                  // Only add paths from write, edit, or create operations for the commit.
                  // delete_file operations are handled by git.remove() within the repository.deleteFile method.
                  if (['write_file', 'edit_file', 'create_directory'].includes(result.tool_name)) {
                      if (result.params && result.params.path && typeof result.params.path === 'string') {
                          if (!changedFilePaths.includes(result.params.path)) {
                              changedFilePaths.push(result.params.path);
                          }
                      }
                  }
              }
          }
          if (changedFilePaths.length > 0) {
            try {
              const commitResult = await this.repository.commitChanges(changedFilePaths, commitMessage, author);
              console.log(`[ChatService] Changes committed for paths: ${changedFilePaths.join(', ')} with message: ${commitMessage}`);

              // Add to timeline if commit was successful
              if (commitResult.success && commitResult.hash) {
                await this.timelineService.addChatAssistantCommitEntry(
                  this.repository,
                  { id: commitResult.hash, message: commitResult.message || commitMessage },
                  potentialCompletionResponse.summary,
                  userId
                );
              }
            } catch (commitError) {
              console.error("[ChatService] Error committing changes:", commitError);
              potentialCompletionResponse.summary += " (Warning: failed to commit changes)";
              potentialCompletionResponse.final_message_to_user += " (Warning: there was an issue saving some of the changes.)";
            }
          } else {
            console.log("[ChatService] No file changes detected by chat tools to commit.");
          }
          return potentialCompletionResponse;
        } else if (potentialToolCallInContent) {
          // Handle the fallback tool call found in content
          console.log(`[ChatService] LLM requesting tool (fallback in content): ${potentialToolCallInContent.tool_name} with args:`, potentialToolCallInContent.tool_parameters);
          try {
            const toolOutput = await this.executeToolCall(potentialToolCallInContent.tool_name, potentialToolCallInContent.tool_parameters);
            toolExecutionResultsForCommit.push({ tool_name: potentialToolCallInContent.tool_name, output: toolOutput, params: potentialToolCallInContent.tool_parameters });
            // Note: For tool calls in content, we don't have a tool_call_id from OpenAI.
            // The history entry for assistant already contains the raw content. This tool result is for the next turn.
            conversationHistory.push({ 
                role: 'tool', 
                name: potentialToolCallInContent.tool_name, 
                content: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput)
            });
          } catch (error) {
            console.error(`[ChatService] Error executing fallback tool ${potentialToolCallInContent.tool_name}:`, error);
            const errorMessage = `Error: ${(error as Error).message}`;
            toolExecutionResultsForCommit.push({ tool_name: potentialToolCallInContent.tool_name, output: errorMessage, params: potentialToolCallInContent.tool_parameters });
            conversationHistory.push({ 
                role: 'tool', 
                name: potentialToolCallInContent.tool_name, 
                content: errorMessage 
            });
          }
          continue; // Go back to LLM with tool results
        } else if (isDirectTextMessage || typeof llmMessageObject.content === 'string') {
          // Content was a direct text message (either failed JSON.parse or was string initially)
          console.log("[ChatService] LLM provided a direct text message:", llmMessageObject.content);
          return {
            status: "completed_chat_interaction",
            summary: "LLM provided a direct text answer.",
            final_message_to_user: llmMessageObject.content
          };
        } else {
          // Content was JSON, but not a recognized completion signal or fallback tool call.
          console.warn("[ChatService] LLM content was JSON but not a recognized signal/tool call:", llmMessageObject.content);
          return {
            status: "completed_chat_interaction",
            summary: "LLM provided an unexpected JSON response.",
            final_message_to_user: JSON.stringify(llmMessageObject.content) // Send back the stringified JSON
          };
        }
      } else {
        // No tool_calls and no content. This is unexpected.
        console.error("[ChatService] LLM response had no tool_calls and no content:", llmMessageObject);
        return {
            status: "completed_chat_interaction",
            summary: "Error: LLM response was empty or malformed.",
            final_message_to_user: "Sorry, I received an empty or malformed response from the assistant."
        };
      }
    } // End of while loop
    
    console.error("[ChatService] Reached maximum iterations for tool calls.");
    return {
        status: "completed_chat_interaction",
        summary: "Reached maximum iterations. Operation may be incomplete.",
        final_message_to_user: "Sorry, I encountered an issue while processing your request (max iterations reached). Please try again or rephrase."
    };
  }
} 