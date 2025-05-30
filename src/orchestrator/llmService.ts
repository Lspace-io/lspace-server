import axios from 'axios';
import path from 'path';
import { systemPrompt, toolDefinitions, fillPromptTemplate, contradictionAnalysisPrompt } from '../config/prompts';
import { FileSystemToolImpl } from '../core/fileSystemToolImpl';
import { Repository } from '../core/repository';

// Types for document classification
export interface ClassificationResult {
  category: string;
  subcategory: string;
  suggestedPath: string;
  tags: string[];
}

// Types for document structuring
export interface StructuredDocument {
  title: string;
  content: string;
  frontMatter: {
    title: string;
    tags: string[];
    date: string;
    [key: string]: any;
  };
}

// Types for duplicate detection
export interface DuplicateDetectionResult {
  isDuplicate: boolean;
  duplicatePath?: string;
  similarity?: number;
  mergeRecommendation?: 'keep_existing' | 'replace' | 'merge';
  mergedContent?: string;
}

// Types for content organization
export interface ContentOrganizationResult {
  moves: { from: string; to: string }[];
  updates: { path: string; content: string }[];
  newFiles: { path: string; content: string }[];
}

// Types for repository summary
export interface RepositorySummary {
  title: string;
  description: string;
  topics: string[];
  fileCount: number;
  mainCategories: string[];
  lastUpdated: string;
}

// Types for pruning recommendations
export interface PruningRecommendations {
  obsoleteFiles: string[];
  duplicates: { original: string; duplicate: string; similarity: number }[];
  recommendations: (
    | { action: 'delete'; path: string; reason: string }
    | { action: 'merge'; source: string; target: string; reason: string }
  )[];
}

// Types for knowledge extraction
export interface KnowledgeExtractionResult {
  topics: { path: string; title: string }[];
  concepts: { topic: string; name: string; description: string }[];
  relationships: { from: string; to: string; type: string }[];
}

// Types for knowledge base generation
export interface KnowledgeBaseArticle {
  title: string;
  content: string;
  topics: string[];
  subtopics?: string[];
  relatedTopics?: string[];
  sourceDocuments: { path: string; title: string }[];
}

export interface LLMConflictHandlingRule {
  strategy: 'newer_overrides_older_with_footnote' | 'merge_with_conflict_markers' | 'keep_both';
  checksumDuplicates?: boolean;
}

export interface LLMNewArticleSkeleton {
  titleSuggestion: string;
  summaryPrompt: string;
  sectionsPerChunk: string[];
  sourceReference: {
    path: string;
    lines?: string;
  };
}

export interface LLMIntegrationResult {
  changed: boolean;
  title?: string;
  sources?: Array<{ file: string; lines?: string }>;
  mergedContent: string;
}

// Added for generateKbArticlesFromSource
export interface GeneratedKbArticle {
  kbPagePath: string; // e.g., "knowledge-base/topics/generated-topic.md"
  kbPageContent: string; // Full markdown content including frontmatter
  title: string; // Title of the KB article, should be in frontmatter
}

// --- NEW TYPES for Conversational Tool-Based Approach ---
interface ToolCallRequest {
  tool_name: string;
  tool_parameters: Record<string, any>;
}

interface LLMResponse {
  // LLM might respond with a tool call, a status, or a direct message for summary.
  tool_call?: ToolCallRequest;
  status?: 'completed_file_processing' | 'completed_all_processing' | 'error';
  message?: string; // For general messages or final summary content
  error_details?: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ToolCallRequest | ToolCallResponse; // ToolCallResponse added for tool role content type
  tool_call_id?: string; // Optional: if the role is 'assistant' and content is a tool_call
  name?: string; // Optional: if role is 'tool', this is the tool name
}

// Added for clarity on what a tool responds with, to be stringified into ConversationTurn content
export interface ToolCallResponse {
    success: boolean;
    content?: any; // Could be string, string[], object etc.
    error?: string;
    message?: string; // General message from tool execution
}

interface FileSystemToolService { // Placeholder interface for a service that would execute tools
  readFile(path: string): Promise<{ success: boolean; content?: string; error?: string }>;
  writeFile(path: string, content: string): Promise<{ success: boolean; error?: string }>;
  editFile(path: string, edits: any): Promise<{ success: boolean; error?: string }>;
  createDirectory(path: string): Promise<{ success: boolean; error?: string }>;
  listDirectory(path: string): Promise<{ success: boolean; content?: string[]; error?: string }>;
  getFileTree(path: string): Promise<{ success: boolean; tree?: any; error?: string }>;
}
// --- END NEW TYPES ---

/**
 * Service for interacting with LLMs for various document processing tasks
 * REFACTORED for a conversational, tool-based knowledge base generation approach.
 */
export class LLMService {
  private apiKey: string;
  private endpoint: string;
  private model: string;
  private fileSystemToolService: FileSystemToolService;
  private repository: Repository;
  
  constructor(config: { 
    apiKey: string; 
    endpoint?: string; 
    model?: string;
    repositoryPath: string;
  }) {
    // Ensure API key is provided
    if (!config.apiKey && !process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key is required. Please set it in options or as an environment variable OPENAI_API_KEY.');
    }

    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
    this.endpoint = config.endpoint || process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1/chat/completions';
    this.model = config.model || process.env.OPENAI_MODEL || 'gpt-4o';

    // Instantiate Repository and FileSystemToolImpl
    this.repository = new Repository(config.repositoryPath);
    this.fileSystemToolService = new FileSystemToolImpl(this.repository);
    console.log(`LLMService initialized to use repository at: ${config.repositoryPath}`);
  }
  
  /**
   * Updates the repository path used by the LLM service.
   * This is critical for ensuring that file operations through tools happen
   * in the correct repository context.
   * 
   * @param newRepositoryPath The absolute path to the repository
   */
  public updateRepositoryPath(newRepositoryPath: string): void {
    if (this.repository.path !== newRepositoryPath) {
      console.log(`Updating LLMService repository path from ${this.repository.path} to ${newRepositoryPath}`);
      this.repository = new Repository(newRepositoryPath);
      this.fileSystemToolService = new FileSystemToolImpl(this.repository);
    }
  }
  
  private async executeToolCall(toolRequest: ToolCallRequest): Promise<ConversationTurn> {
    const { tool_name, tool_parameters } = toolRequest;
    console.log(`[LLMService] Executing tool: ${tool_name} with parameters:`, JSON.stringify(tool_parameters));
    
    let result;
    try {
      switch (tool_name) {
        case 'read_file':
          result = await this.fileSystemToolService.readFile(tool_parameters.path);
          console.log(`[LLMService] Read file ${tool_parameters.path}: success=${result.success}`);
          break;
        case 'write_file':
          result = await this.fileSystemToolService.writeFile(tool_parameters.path, tool_parameters.content);
          console.log(`[LLMService] Write file ${tool_parameters.path}: success=${result.success}`);
          break;
        case 'edit_file':
          result = await this.fileSystemToolService.editFile(tool_parameters.path, tool_parameters.edits);
          console.log(`[LLMService] Edit file ${tool_parameters.path}: success=${result.success}`);
          break;
        case 'create_directory':
          result = await this.fileSystemToolService.createDirectory(tool_parameters.path);
          console.log(`[LLMService] Create directory ${tool_parameters.path}: success=${result.success}`);
          break;
        case 'list_directory':
          result = await this.fileSystemToolService.listDirectory(tool_parameters.path);
          console.log(`[LLMService] List directory ${tool_parameters.path}: success=${result.success}`);
          break;
        case 'get_file_tree':
          result = await this.fileSystemToolService.getFileTree(tool_parameters.path);
          console.log(`[LLMService] Get file tree for ${tool_parameters.path}: success=${result.success}`);
          break;
        case 'request_summary_generation': // This is a signal, not a file system op
          result = { success: true, message: "Summary generation requested by LLM." };
          console.log(`[LLMService] Summary generation requested`);
          break;
        default:
          console.error(`[LLMService] Unknown tool: ${tool_name}`);
          result = { success: false, error: `Unknown tool: ${tool_name}` };
      }
      
      // Log a truncated version of the result for debugging
      const resultString = JSON.stringify(result);
      const truncatedResult = resultString.length > 200 
        ? resultString.substring(0, 200) + '...' 
        : resultString;
      console.log(`[LLMService] Tool result: ${truncatedResult}`);
      
      return {
        role: 'tool',
        name: tool_name,
        content: JSON.stringify(result),
      };
    } catch (error: any) {
      console.error(`[LLMService] Error executing tool ${tool_name}:`, error);
      return {
        role: 'tool',
        name: tool_name,
        content: JSON.stringify({ success: false, error: error.message || 'Tool execution failed' }),
      };
    }
  }
  
  /**
   * Processes a single input document using a conversational, tool-based approach.
   * Manages the interaction loop with the LLM.
   * @param inputFileName Name of the input file
   * @param inputFileContent Content of the input file to process.
   * @param knowledgeBaseStateForAnalysis Current state/context of the knowledge base (e.g., file tree summary).
   * @param knowledgeBasePromptContext Current state/context of the knowledge base (e.g., file tree summary).
   * @param totalFiles Total number of files to process
   * @param currentFileNumber Current file number being processed
   * @param maxTurns Maximum number of conversation turns to prevent infinite loops.
   */
  async processDocumentConversational(
    inputFileName: string,
    inputFileContent: string,
    knowledgeBaseStateForAnalysis: any, // Changed from knowledgeBaseContext: string
    knowledgeBasePromptContext: string, // New parameter for the actual prompt string
    totalFiles: number,
    currentFileNumber: number,
    maxTurns: number = 15
  ): Promise<{ status: string; history: ConversationTurn[]; summary?: string }> {
    const conversationHistory: ConversationTurn[] = [];

    const initialSystemMessage = fillPromptTemplate(systemPrompt, {});
    conversationHistory.push({ role: 'system', content: initialSystemMessage });
    
    let contradictionInfo = '';
    // Use knowledgeBaseStateForAnalysis for contradiction logic
    if (knowledgeBaseStateForAnalysis && knowledgeBaseStateForAnalysis.documentContents) {
      try {
        // knowledgeBaseStateForAnalysis is already an object (parsed or constructed in OrchestratorService)
        const contradictionAnalysis = await this.analyzeForContradictions(inputFileContent, knowledgeBaseStateForAnalysis);
        
        if (contradictionAnalysis.hasContradictions && contradictionAnalysis.details.length > 0) {
          contradictionInfo = `\n\nCONTRADICTION ALERT: The following contradictions were identified between this document and existing knowledge base content:\n\n`;
          contradictionAnalysis.details.forEach((contradiction, index) => {
            contradictionInfo += `Contradiction ${index + 1}:\n`;
            contradictionInfo += `- File: ${contradiction.existingFile}\n`;
            contradictionInfo += `- Type: ${contradiction.contradictionType}\n`;
            contradictionInfo += `- Old Information: \"${contradiction.oldInformation}\"\n`;
            contradictionInfo += `- New Information: \"${contradiction.newInformation}\"\n`;
            contradictionInfo += `- Confidence: ${contradiction.confidence}%\n\n`;
          });
          contradictionInfo += `IMPORTANT: When integrating this document, prioritize the newer information and UPDATE ALL affected files to maintain consistency. Explicitly note in the affected files that information has been updated based on ${inputFileName}.\n`;
        }
      } catch (error) {
        console.error('[LLMService] Error analyzing contradictions:', error);
        // Proceed without contradiction analysis
      }
    }

    // Use knowledgeBasePromptContext for the LLM prompt
    const initialUserMessage = `Processing file: ${inputFileName} (${currentFileNumber} of ${totalFiles}).
Input File Content:
\`\`\`
${inputFileContent}
\`\`\`

Knowledge Base Context:
\`\`\`
${knowledgeBasePromptContext} 
\`\`\`
${contradictionInfo}

BEFORE DOING ANYTHING ELSE: 
1. Check if a summary.md file exists in the knowledge-base directory
2. If it doesn't exist, create it with an overview of the knowledge base structure
3. If it does exist, read it to understand the current knowledge base organization

WHAT TO DO NEXT:
1. Integrate this document into the knowledge base following the KNOWLEDGE BASE CONSTRUCTION PRINCIPLES
2. After making all other changes, update the summary.md file to include any new or modified content
3. In the summary.md file, add a note about processing this document in the "Recent Updates" section

What actions do you need to take to integrate this document into the knowledge base?`;
    conversationHistory.push({ role: 'user', content: initialUserMessage });

    let turns = 0;
    while (turns < maxTurns) {
      turns++;
      console.log(`Conversation Turn: ${turns}`);

      const llmRawResponse = await this.callLLMWithHistory(conversationHistory, toolDefinitions);

      if (!llmRawResponse) {
        const assistantMessageWithError = 'LLM did not provide a parsable response (null).';
        conversationHistory.push({ role: 'assistant', content: assistantMessageWithError });
        return { status: 'error', history: conversationHistory, summary: assistantMessageWithError };
      }

      try {
        const assistantMessageObject = JSON.parse(llmRawResponse);
        // Add the raw assistant message object to history. Content might be a string or tool_calls object.
        conversationHistory.push({ role: 'assistant', content: assistantMessageObject });

        if (assistantMessageObject.tool_calls && assistantMessageObject.tool_calls.length > 0) {
          for (const toolCall of assistantMessageObject.tool_calls) {
            if (toolCall.type === 'function') {
              const toolCallRequest: ToolCallRequest = {
                tool_name: toolCall.function.name,
                tool_parameters: JSON.parse(toolCall.function.arguments || '{}')
              };
              console.log(`LLM requesting tool: ${toolCallRequest.tool_name} with params:`, toolCallRequest.tool_parameters);
              const toolResultTurn = await this.executeToolCall(toolCallRequest);
              const toolResponseTurn: ConversationTurn = {
                role: 'tool',
                tool_call_id: toolCall.id, // OpenAI requires this
                name: toolCallRequest.tool_name, // conventionally, the function name
                content: toolResultTurn.content // content from executeToolCall is already stringified JSON
              };
              conversationHistory.push(toolResponseTurn);
            }
          }
          continue; // Loop back to let LLM continue with tool results
        } else if (assistantMessageObject.content) {
          const messageContentStr = assistantMessageObject.content;
          try {
            // Check if the content string itself is a JSON object for our custom status
            const parsedContentStatus = JSON.parse(messageContentStr);
            if (parsedContentStatus.status) {
              const status = parsedContentStatus.status;
              console.log(`LLM Status via content: ${status}`);
              if (status === 'completed_all_processing') {
                return { status: 'awaiting_final_summary', history: conversationHistory };
              } else if (status === 'completed_file_processing') {
                return { status: 'completed_file_processing', history: conversationHistory };
              } else if (status === 'error') {
                const summary = parsedContentStatus.error_details || 'LLM reported an error via status object.';
                console.error(`LLM reported an error: ${summary}`);
                return { status: 'error', history: conversationHistory, summary };
              }
            } else {
              console.log('LLM message content was JSON, but not a recognized status object:', messageContentStr);
            }
          } catch (e) {
            // Content was not JSON, or not our specific status JSON. LLM is just talking.
            console.log('LLM responded with plain text message (not a tool call or known status JSON):', messageContentStr);
          }
        } else {
          console.warn('LLM response message had no tool_calls and no content:', assistantMessageObject);
        }
      } catch (error: any) {
        console.error('Failed to parse LLM raw response as JSON. Content:', llmRawResponse, 'Error:', error);
        
        // ADDED: Check if the raw response contains tool call information in plain text
        const toolCallPattern = /{[\s\n]*"tool_name"[\s\n]*:[\s\n]*"([^"]+)"[\s\n]*,[\s\n]*"tool_parameters"[\s\n]*:[\s\n]*([\s\S]+?)[\s\n]*}/;
        const statusPattern = /{[\s\n]*"status"[\s\n]*:[\s\n]*"([^"]+)"[\s\n]*}/;
        
        let hasExtractedToolCall = false;
        
        // Try to extract tool call from raw text response
        const toolCallMatch = llmRawResponse.match(toolCallPattern);
        if (toolCallMatch) {
          console.log('Found tool call in plain text response, attempting to extract');
          try {
            const toolName = toolCallMatch[1];
            // Try to parse the parameters part
            const parametersText = toolCallMatch[2];
            // Reconstruct proper JSON with the extracted parts
            const fullToolCallJson = `{"tool_name":"${toolName}","tool_parameters":${parametersText}}`;
            const extractedToolCall = JSON.parse(fullToolCallJson);
            
            // Create a proper tool call and continue processing
            console.log(`Extracted tool call from text: ${toolName}`, extractedToolCall.tool_parameters);
            const toolCallRequest: ToolCallRequest = {
              tool_name: extractedToolCall.tool_name,
              tool_parameters: extractedToolCall.tool_parameters
            };
            
            // Add the raw text as assistant message
            conversationHistory.push({ role: 'assistant', content: llmRawResponse });
            
            // Execute the extracted tool call
            const toolResultTurn = await this.executeToolCall(toolCallRequest);
            const toolResponseTurn: ConversationTurn = {
              role: 'tool',
              name: toolCallRequest.tool_name,
              content: toolResultTurn.content
            };
            conversationHistory.push(toolResponseTurn);
            hasExtractedToolCall = true;
            continue; // Continue with the conversation
          } catch (extractError) {
            console.error('Failed to extract tool call from text:', extractError);
          }
        }
        
        // Check for status pattern
        const statusMatch = llmRawResponse.match(statusPattern);
        if (statusMatch && !hasExtractedToolCall) {
          console.log('Found status in plain text response, attempting to extract');
          const status = statusMatch[1];
          console.log(`Extracted status from text: ${status}`);
          conversationHistory.push({ role: 'assistant', content: llmRawResponse });
          
          if (status === 'completed_all_processing') {
            return { status: 'awaiting_final_summary', history: conversationHistory };
          } else if (status === 'completed_file_processing') {
            return { status: 'completed_file_processing', history: conversationHistory };
          }
        }
        
        // If we couldn't extract a tool call or status, record the error and continue
        conversationHistory.push({ role: 'assistant', content: `LLM responded with non-JSON content when JSON was expected.` });
        return { status: 'error', history: conversationHistory, summary: 'LLM responded with non-JSON content when JSON was expected.' };
      }
    }

    console.warn('Max conversation turns reached.');
    return { status: 'max_turns_reached', history: conversationHistory, summary: 'Max conversation turns reached.' };
  }

  /**
   * Generates a detailed summary of the knowledge base changes based on the processing history.
   * This method is called after document processing to create detailed commit messages.
   */
  async generateKnowledgeBaseSummary(processingHistory: ConversationTurn[]): Promise<string> {
    const userMessageForSummary = `
Please provide a detailed summary of all changes made to the knowledge base. This summary will be used for a commit message.

Include the following sections:
1. Files Created or Updated - List all files that were created or modified
2. Content Changes - Describe the specific content that was added or changed in each file
3. Integration Strategy - Explain how information was synthesized or merged from different sources
4. Key Insights - Highlight the most important information or concepts that were added

Format your response as Markdown. Be specific about what changed and why it's valuable.
If no changes were made, state that.
`;
    
    // Use the last 20 messages to have more context for the summary
    const messagesForSummary: ConversationTurn[] = [
        // Use a system message to force narrative output instead of JSON
        { 
          role: 'system', 
          content: 'You are a documentation assistant that helps write detailed summaries of changes. Respond in clear, structured Markdown with headings and bullet points. DO NOT output JSON format responses.' 
        },
        ...processingHistory.slice(-20), 
        { role: 'user', content: userMessageForSummary }
    ];

    // For summaries, we don't want the JSON format requirement
    const summaryResponseJson = await this.callLLMWithHistory(messagesForSummary, [], false); 

    if (summaryResponseJson) {
        try {
            // For non-JSON mode, the response might be a plain Markdown string
            // or it might still be a JSON response with content
            let finalSummary: string;
            
            try {
                // Try to parse as JSON first
                const summaryMessageObject = JSON.parse(summaryResponseJson);
                if (summaryMessageObject.content && typeof summaryMessageObject.content === 'string') {
                    finalSummary = summaryMessageObject.content.trim();
                } else {
                    console.warn("Summary response content was not a string or was missing:", summaryMessageObject.content);
                    finalSummary = JSON.stringify(summaryMessageObject, null, 2);
                }
            } catch (parseError) {
                // Not JSON, probably raw text response
                console.log("Summary response is not JSON (expected for narrative output)");
                finalSummary = summaryResponseJson.trim();
            }
            
            // Log a preview of the summary
            console.log("Generated KB summary preview:", finalSummary.substring(0, 200) + "...");
            return finalSummary;
        } catch (e) {
            console.error("Error processing summary response:", e);
            // Fallback: use whatever we got as a string
            if (typeof summaryResponseJson === 'string') return summaryResponseJson.trim();
        }
    }
    return 'Could not generate detailed summary of knowledge base changes.';
  }
  
  /**
   * Gets the current knowledge base structure and content by calling the get_file_tree tool
   * and reading the content of important files to provide better context.
   * This enhanced context helps with identifying and resolving contradictions.
   */
  public async getCurrentKnowledgeBaseStructure(): Promise<any> {
    console.log(`[LLMService] getCurrentKnowledgeBaseStructure called for repository: ${this.repository.path}`);
    try {
      const treeResult = await this.fileSystemToolService.getFileTree('.'); // Get tree from KB root
      if (!treeResult.success) {
        return { error: 'Failed to retrieve KB structure', details: treeResult.error };
      }
      
      // Create an enhanced context object that includes both structure and content
      let enhancedContext: {
        tree: any[]; // Assuming 'any' for now, should be FileNode[] ideally
        documentContents: Record<string, string>; // Explicitly type documentContents
        error?: string;
        details?: string;
      } = { tree: [], documentContents: {} };
      
      // Identify key KB files to include content for (limit to important files to avoid context overflow)
      // First get all markdown files from the knowledge base
      let allFiles: string[] = [];
      try {
        const listResult = await this.fileSystemToolService.listDirectory('knowledge-base');
        if (listResult.success && Array.isArray(listResult.content)) {
          // Get all markdown files recursively (this is a simplification - in real implementation,
          // you might want to use a proper recursive function to get all files)
          for (const entry of listResult.content) {
            if (entry.endsWith('.md')) {
              allFiles.push(`knowledge-base/${entry}`);
            } else {
              // Try to list subdirectories
              try {
                const subDirResult = await this.fileSystemToolService.listDirectory(`knowledge-base/${entry}`);
                if (subDirResult.success && Array.isArray(subDirResult.content)) {
                  for (const subEntry of subDirResult.content) {
                    if (subEntry.endsWith('.md')) {
                      allFiles.push(`knowledge-base/${entry}/${subEntry}`);
                    }
                  }
                }
              } catch (subDirError) {
                // Ignore errors for non-directories
              }
            }
          }
        }
      } catch (listError) {
        console.warn('Error listing KB files:', listError);
        // Continue with what we have
      }
      
      // Read content of each file (up to a reasonable number to avoid context overflow)
      const MAX_FILES_TO_INCLUDE = 5; // Limit the number of files to include
      const filesToInclude = allFiles.slice(0, MAX_FILES_TO_INCLUDE);
      
      for (const filePath of filesToInclude) {
        try {
          const readResult = await this.fileSystemToolService.readFile(filePath);
          if (readResult.success && readResult.content) {
            enhancedContext.documentContents[filePath] = readResult.content;
          }
        } catch (readError) {
          console.warn(`Error reading file ${filePath}:`, readError);
        }
      }
      
      // Add the file tree structure to the description.
      if (treeResult && treeResult.tree) {
        enhancedContext.tree = treeResult.tree;
      } else if (treeResult && treeResult.tree) {
        enhancedContext.tree = treeResult.tree;
      } else if (treeResult) {
        enhancedContext.tree = [treeResult];
      }
      
      return enhancedContext;
    } catch (error: any) {
      console.error('Error retrieving current KB structure:', error);
      return { error: 'Failed to retrieve KB structure', details: error.message };
    }
  }

  /**
   * Calls the LLM with the conversation history and available tools.
   * REFACTORED to use OpenAI's native tool calling.
   * @param history The conversation history.
   * @param availableTools Tool definitions to make available to the LLM.
   * @param forceJsonResponse Whether to force JSON response format (default: true)
   */
  public async callLLMWithHistory(history: ConversationTurn[], availableTools: any[], forceJsonResponse: boolean = true): Promise<string | null> {
    // Add a system instruction to ensure JSON responses (only if forceJsonResponse is true)
    const systemJsonInstructions = {
      role: 'system',
      content: 'IMPORTANT: You must respond only with valid JSON. Do not include any explanatory text. Do not use markdown code blocks. Your entire response must be a single valid JSON object.'
    };
    
    // Add the instruction to the beginning of the messages array if there isn't already a system message
    let messages = history.map(turn => {
      const { role, content } = turn;
      if (role === 'tool') {
        return {
          role: role,
          tool_call_id: turn.tool_call_id,
          name: turn.name,
          content: content as string,
        };
      } else if (role === 'assistant') {
        // Assistant content here is the OpenAI message object (which might have .content or .tool_calls)
        // It was stored directly in history by processDocumentConversational
        if (typeof content === 'object' && content !== null) {
          return { role: 'assistant', ...content }; // Spread the message object which contains .content and/or .tool_calls
        }
        // Fallback if somehow assistant content is just a string (should not happen if processDocumentConversational is correct)
        return { role: 'assistant', content: content as string | null };
      }
      // System and User roles have string content
      return { role: role, content: content as string };
    });
    
    // Only add the JSON instruction if there isn't already a system message and we want JSON
    if (forceJsonResponse && !messages.some(m => m.role === 'system')) {
      messages = [systemJsonInstructions, ...messages];
    }

    const requestBody: any = {
      model: this.model,
      messages: messages
    };

    // Only add JSON response format if we want to force JSON
    if (forceJsonResponse) {
      requestBody.response_format = { type: "json_object" };
    }

    if (availableTools && availableTools.length > 0) {
      requestBody.tools = availableTools.map(t => ({ type: "function", function: t }));
      requestBody.tool_choice = "auto";
      // If we're using tools, don't force JSON format as it conflicts with tool calls
      delete requestBody.response_format;
    }
    
    console.log('Sending to LLM API with model:', this.model);
    console.log('Number of messages:', messages.length);
    
    // Fix potential null reference by adding a check
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    console.log('Last user message:', lastUserMessage?.content 
      ? (lastUserMessage.content.substring(0, 100) + '...') 
      : 'No user message found');
      
    if (requestBody.tools) {
      console.log('Number of available tools:', requestBody.tools.length);
      console.log('Tool names:', requestBody.tools.map((t: any) => t.function.name).join(', '));
    }

    try {
      const response = await axios.post(this.endpoint, requestBody, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`, // Fixed header
          'Content-Type': 'application/json',
        },
      });

      if (response.data.choices && response.data.choices.length > 0) {
        const message = response.data.choices[0].message;
        console.log('LLM response received. Message type:', typeof message);
        
        // If we're not forcing JSON, return the raw content
        if (!forceJsonResponse && message.content) {
          console.log('Non-JSON response mode. Content preview:', message.content.substring(0, 100) + '...');
          return message.content;
        }
        
        // JSON processing path
        if (message.content) {
          console.log('Content preview:', message.content.substring(0, 100) + '...');
          
          // Check if the content is already valid JSON or try to extract JSON
          try {
            // Test if it's valid JSON already
            JSON.parse(message.content);
            // If we reached here, it's valid JSON, so just return the stringified message object
          } catch (e) {
            // Not valid JSON, try to extract JSON from the content
            // Improved regex to better match JSON objects
            const jsonPattern = /(\{[\s\S]*?\})/g;
            const matches = [...message.content.matchAll(jsonPattern)];
            
            // Try each match to see if any is valid JSON
            for (const match of matches) {
              try {
                const potentialJson = match[1];
                const extractedJson = JSON.parse(potentialJson);
                // If valid, create a new message object with just the JSON
                console.log('Found valid JSON in response:', JSON.stringify(extractedJson).substring(0, 50) + '...');
                const fixedMessage = { ...message, content: JSON.stringify(extractedJson) };
                return JSON.stringify(fixedMessage);
              } catch (e2) {
                // Continue to next match
                console.warn('Match was not valid JSON, trying next match if available');
              }
            }
            // If we get here, no valid JSON was found
            console.warn('Failed to extract valid JSON from content');
          }
        }
        if (message.tool_calls) {
          console.log('Tool calls received:', message.tool_calls.length);
        }
        return JSON.stringify(message);
      }
      console.warn("LLM API response had no choices or empty choices array.");
      return null;
    } catch (error: any) {
      console.error('Error calling LLM API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
      if (error.response && error.response.data && error.response.data.error && error.response.data.error.message) {
        throw new Error(`LLM API Error: ${error.response.data.error.message}`);
      }
      throw new Error('LLM API request failed due to network or other unhandled error.');
    }
  }

  // --- Implementation for methods called by KnowledgeBaseService ---
  /**
   * Process new content to integrate with existing content using the LLM
   */
  public async integrateContent(params: any): Promise<LLMIntegrationResult> {
    console.log('Using processDocumentConversational for content integration');
    const { existingContent, existingMetadata, newChunkText, newChunkSourcePath } = params;
    
    // Build a context string that describes the KB state
    const kbContext = `This content needs to be integrated into an existing article.
Existing article title: ${existingMetadata.title || 'Untitled'}
Existing article sources: ${JSON.stringify(existingMetadata.sources || [])}
Existing article path: ${newChunkSourcePath}`;
    
    // Use our conversational approach
    const result = await this.processDocumentConversational(
      path.basename(newChunkSourcePath),
      newChunkText,
      existingMetadata,
      kbContext,
      1, // Single document being processed
      1
    );
    
    // For now, assume that any changes are positive
    return {
      changed: true,
      mergedContent: existingContent, // The LLM should have written the file directly
      sources: existingMetadata.sources || []
    };
  }

  /**
   * Generate a new article skeleton using the LLM
   */
  public async generateNewArticleSkeleton(params: LLMNewArticleSkeleton): Promise<{
    title: string;
    bodyContent: string;
  }> {
    const messages: ConversationTurn[] = [
      {
        role: 'system' as ConversationTurn['role'],
        content: `You are a technical writer. Generate a concise title and a markdown document body for a new knowledge base article. 
The article should summarize the provided information chunk. 
Source path: ${params.sourceReference.path}${params.sourceReference.lines ? ` (lines: ${params.sourceReference.lines})` : ''}
Title suggestion: ${params.titleSuggestion}
Summary prompt: ${params.summaryPrompt}
Desired sections per chunk: ${params.sectionsPerChunk.join(', ')}`
      },
      {
        role: 'user' as ConversationTurn['role'],
        content: 'Please generate the title and markdown body content. Respond with a JSON object: { "title": "Your Title", "bodyContent": "Your markdown content..." }'
      }
    ];

    const llmResponse = await this.callLLMWithHistory(messages, [], true);
    
    if (!llmResponse) {
      return { title: 'Untitled Article', bodyContent: 'No content generated' };
    }

    try {
      const responseObj = JSON.parse(llmResponse);
      if (responseObj.title && responseObj.bodyContent) {
        return {
          title: responseObj.title,
          bodyContent: responseObj.bodyContent
        };
      } else {
        console.warn('LLM response did not contain expected title or bodyContent:', responseObj);
        return { title: 'Untitled Article', bodyContent: 'No content generated' };
      }
    } catch (e) {
      console.error('Error parsing LLM response:', e);
      return { title: 'Untitled Article', bodyContent: 'Error parsing response' };
    }
  }

  /**
   * Analyze content to determine appropriate topic category
   */
  public async analyzeTopic(content: string): Promise<{ topicPath: string }> {
    const messages: ConversationTurn[] = [
      {
        role: 'system' as ConversationTurn['role'],
        content: 'You are a topic modeling expert. Analyze the provided content and suggest a hierarchical file path for storing it in a knowledge base. For example, if the content is about API authentication using OAuth, a good path might be "authentication/oauth/api-keys.md". The path should be relative and use forward slashes. Only include the path, not the filename itself initially, unless it is very specific.'
      },
      {
        role: 'user' as ConversationTurn['role'],
        content: `Content to analyze: ${content.substring(0, 2000)}... \n\nRespond with a JSON object: { "topicPath": "suggested/path/for/topic" }` // Removed .md from example
      }
    ];
    const llmResponse = await this.callLLMWithHistory(messages, [], true);
    
    if (!llmResponse) {
      return { topicPath: 'general' };
    }
    
    try {
      const responseObj = JSON.parse(llmResponse);
      if (responseObj.topicPath) {
        return { topicPath: responseObj.topicPath };
      } else {
        console.warn('LLM response did not contain expected topicPath:', responseObj);
        return { topicPath: 'general' };
      }
    } catch (e) {
      console.error('Error parsing LLM response:', e);
      return { topicPath: 'general' };
    }
  }

  /**
   * Simple wrapper to call the LLM with a prompt
   */
  public async callLLM(prompt: string): Promise<string> {
    console.log('Calling LLM with prompt');
    
    try {
      const history: ConversationTurn[] = [
        { role: 'system' as const, content: 'You are a knowledge base assistant.' },
        { role: 'user' as const, content: prompt }
      ];
      
      const response = await this.callLLMWithHistory(history, []);
      if (!response) {
        return 'none';
      }
      
      // Try to extract content from the response
      try {
        const responseObj = JSON.parse(response);
        if (responseObj.content) {
          return responseObj.content;
        }
        return response;
      } catch (e) {
        return response;
      }
    } catch (error) {
      console.error('Error in callLLM:', error);
      return 'none';
    }
  }
  
  /**
   * Analyzes a new document for potential contradictions with existing knowledge base content.
   * This helps identify conflicts that need to be resolved during knowledge base updates.
   * Uses the contradictionAnalysisPrompt from prompts.ts.
   * 
   * @param newDocumentContent Content of the new document being processed
   * @param knowledgeBaseState Current state of the knowledge base with content
   * @returns Analysis result with contradiction details
   */
  public async analyzeForContradictions(
    newDocumentContent: string, 
    knowledgeBaseState: any
  ): Promise<{ 
    hasContradictions: boolean; 
    details: Array<{
      existingFile: string;
      contradictionType: string;
      oldInformation: string;
      newInformation: string;
      confidence: number;
    }>
  }> {
    console.log('[LLMService] Analyzing document for contradictions with existing KB');
    
    // Default return value if no contradictions found
    const emptyResult = {
      hasContradictions: false,
      details: []
    };
    
    // If there's no document content in the KB state, there's nothing to compare against
    if (!knowledgeBaseState.documentContents || Object.keys(knowledgeBaseState.documentContents).length === 0) {
      console.log('[LLMService] No existing KB content to check for contradictions');
      return emptyResult;
    }
    
    // Format the existing knowledge base content for the prompt
    const existingKbContent = Object.entries(knowledgeBaseState.documentContents).map(([filePath, content]) => {
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
      return `
FILE: ${filePath}
\`\`\`
${contentStr.substring(0, 2000)} ${contentStr.length > 2000 ? '...(truncated)' : ''}
\`\`\`
`;
    }).join('\n');
    
    const prompt = fillPromptTemplate(contradictionAnalysisPrompt, {
      newDocumentContent,
      existingKbContent: JSON.stringify(knowledgeBaseState, null, 2)
    });

    const messages: ConversationTurn[] = [
      { role: 'system', content: "You are a contradiction detection expert. Follow the instructions in the user message precisely." } as ConversationTurn, 
      { role: 'user', content: prompt } as ConversationTurn
    ];

    const llmResponse = await this.callLLMWithHistory(messages, [], true);
    
    if (!llmResponse) {
      console.warn('[LLMService] No response from contradiction analysis');
      return emptyResult;
    }
    
    // Parse the response to get the analysis result
    try {
      const responseObj = JSON.parse(llmResponse);
      
      // Extract the content if needed (might be wrapped)
      let analysisResult;
      if (responseObj.content) {
        try {
          analysisResult = JSON.parse(responseObj.content);
        } catch (innerError) {
          console.warn('[LLMService] Could not parse content as JSON, using outer response');
          analysisResult = responseObj;
        }
      } else {
        analysisResult = responseObj;
      }
      
      // Validate and return the result
      if (typeof analysisResult.hasContradictions === 'boolean' && Array.isArray(analysisResult.details)) {
        console.log(`[LLMService] Contradiction analysis complete. Found ${analysisResult.details.length} contradictions`);
        return analysisResult;
      } else {
        console.warn('[LLMService] Malformed contradiction analysis result:', analysisResult);
        return emptyResult;
      }
    } catch (parseError) {
      console.error('[LLMService] Error parsing contradiction analysis:', parseError);
      return emptyResult;
    }
  }
  // --- End Implementations ---

  // --- Modified stubs for methods called by OrchestratorService ---
  // These are now just returning default values instead of throwing errors
  
  public async detectDuplicates(content: any, existingFiles: any): Promise<DuplicateDetectionResult> {
    console.warn('LLMService.detectDuplicates using default implementation.');
    return {
      isDuplicate: false,
      similarity: 0,
      mergeRecommendation: 'keep_existing'
    };
  }

  public async structureDocument(content: any, context: any): Promise<StructuredDocument> {
    console.warn('LLMService.structureDocument using default implementation.');
    // Just return the content with minimal structure
    return {
      title: 'Untitled Document',
      content: content,
      frontMatter: {
        title: 'Untitled Document',
        tags: [],
        date: new Date().toISOString()
      }
    };
  }

  public async organizeContent(files: any): Promise<ContentOrganizationResult> {
    console.warn('LLMService.organizeContent using default implementation.');
    // Return an empty organization result
    return {
      moves: [],
      updates: [],
      newFiles: []
    };
  }

  public async generateSummary(files: any): Promise<RepositorySummary> {
    console.warn('LLMService.generateSummary using default implementation.');
    // Return a basic summary
    return {
      title: 'Repository Summary',
      description: `Repository contains ${files.length} file(s).`,
      topics: ['general'],
      fileCount: files.length,
      mainCategories: ['uncategorized'],
      lastUpdated: new Date().toISOString()
    };
  }

  public async detectObsoleteContent(files: any): Promise<PruningRecommendations> {
    console.warn('LLMService.detectObsoleteContent using default implementation.');
    // Return empty recommendations
    return {
      obsoleteFiles: [],
      duplicates: [],
      recommendations: []
    };
  }
  // --- End Modified Stubs ---

  // Old methods like classifyDocument, structureDocument, etc., would be removed or deprecated.
  // For example:
  /** @deprecated Use processDocumentConversational instead */
  async classifyDocument_old(content: string): Promise<any> {
    throw new Error('This method is deprecated. Use processDocumentConversational.');
  }
  // ... (similarly for other old methods)

  /**
   * Synthesizes knowledge from a given raw input file into the knowledge base.
   * This method orchestrates the LLM interaction to update the KB in the repository root,
   * primarily focusing on README.md and related content files.
   * 
   * @param repository The active repository instance, passed by the orchestrator.
   * @param rawFilePath The path to the raw input file (e.g., '/.lspace/raw_inputs/doc.txt')
   * @param rawFileContent The actual content of the raw input file
   * @returns A promise resolving to an object indicating success, a message, and the primary KB path affected.
   */
  public async synthesizeToKnowledgeBase(
    repository: Repository, // The orchestrator passes the correct repository instance
    rawFilePath: string, // Used for context (e.g., filename for prompts) and logging
    rawFileContent: string // The actual content of the raw input file
  ): Promise<{ success: boolean; message?: string; kbPath?: string }> {
    console.log(`[LLMService] Starting KB synthesis for: ${rawFilePath} in repository ${repository.path}`);
    this.updateRepositoryPath(repository.path); // Ensure tools operate on the correct repo path

    try {
      // const rawFileContentResult = await this.fileSystemToolService.readFile(rawFilePath); // No longer read here
      // if (!rawFileContentResult.success || typeof rawFileContentResult.content !== 'string') { // No longer read here
      //   const errorMsg = `Failed to read raw input file ${rawFilePath}: ${rawFileContentResult.error || 'No content'}`; // No longer read here
      //   console.error(`[LLMService] ${errorMsg}`); // No longer read here
      //   return { success: false, message: errorMsg }; // No longer read here
      // } // No longer read here
      // const inputFileContent = rawFileContentResult.content; // Use rawFileContent directly
      const inputFileContent = rawFileContent; // Use the passed-in content

      // Prepare context for the LLM by getting the current state of the knowledge base.
      const currentKbState = await this.getCurrentKnowledgeBaseStructure();
      // Format this state into a string description for the LLM prompt.
      let kbStateDescription = "";
      if (currentKbState && currentKbState.documentContents && Object.keys(currentKbState.documentContents).length > 0) {
        kbStateDescription += "EXISTING KNOWLEDGE BASE CONTENT:\n\n";
        for (const [kbFilePath, content] of Object.entries(currentKbState.documentContents)) {
          kbStateDescription += `FILE: ${kbFilePath}\n\`\`\`\n${content}\n\`\`\`\n\n`;
        }
        kbStateDescription += "KNOWLEDGE BASE STRUCTURE:\n";
      }
      // Add the file tree structure to the description.
      if (currentKbState && currentKbState.structure) { // Check if structure exists
        kbStateDescription += JSON.stringify(currentKbState.structure, null, 2);
      } else if (currentKbState && currentKbState.tree) { // Fallback to tree if structure is not the primary key
        kbStateDescription += JSON.stringify(currentKbState.tree, null, 2);
      } else if (currentKbState) { // Fallback to the whole object if specific parts aren't found
        kbStateDescription += JSON.stringify(currentKbState, null, 2);
      }

      console.log(`[LLMService] Processing content from ${rawFilePath} with conversational LLM.`);
      const llmResult = await this.processDocumentConversational(
        path.basename(rawFilePath), // Provide just the base name of the input file.
        inputFileContent,
        currentKbState, // The structured object for analysis by the LLM, if needed.
        kbStateDescription, // The string representation for the prompt.
        1, // Assuming one file is processed at a time by this method call.
        1  // Current file number.
      );

      if (llmResult.status === 'completed_file_processing' || llmResult.status === 'completed_all_processing') {
        let summaryMessage = `KB updated successfully for ${path.basename(rawFilePath)}.`;
        try {
            const commitSummary = await this.generateKnowledgeBaseSummary(llmResult.history);
            summaryMessage = `KB update for ${path.basename(rawFilePath)}: ${commitSummary}`;
            console.log("[LLMService] Generated summary of LLM operations:", commitSummary);
        } catch(summaryError: any) {
            console.warn(`[LLMService] Could not generate summary of LLM operations: ${summaryError.message}`);
        }
        
        // Changes made by the LLM via tools are in the working directory. OrchestratorService will handle the final commit.
        return {
          success: true,
          message: summaryMessage,
          kbPath: 'README.md' // Defaulting to README.md as the primary entry point, per prompts.
        };
      } else {
        const errorMsg = `LLM processing for ${rawFilePath} did not complete as expected. Status: ${llmResult.status}. History: ${JSON.stringify(llmResult.history)}`;
        console.error(`[LLMService] ${errorMsg}`);
        return { success: false, message: errorMsg };
      }
    } catch (error: any) {
      const errorMsg = `Critical error during KB synthesis for ${rawFilePath}: ${error.message}`;
      console.error(`[LLMService] ${errorMsg}`, error);
      return { success: false, message: errorMsg };
    }
  }

  // Method to query the knowledge base
  public async queryKnowledgeBase(
    repository: Repository, 
    queryText: string,
    maxContextFiles: number = 10, // Limit the number of files to read for context
    maxFileLength: number = 5000 // Limit the length of each file to save tokens
  ): Promise<{ answer: string; sources: string[] }> {
    this.updateRepositoryPath(repository.path); // Ensure context is correct
    console.log(`[LLMService] Querying KB in repository ${repository.path} with query: "${queryText}"`);

    let contextContent = '';
    const sources: string[] = [];

    try {
      const allFilesAndDirs = await repository.listAllFilesRecursive('.'); // Use recursive listing
      // Filter for relevant KB files (e.g., .md, .txt, not in .lspace or .git)
      const kbFiles = allFilesAndDirs
        .filter(f => 
          f.type === 'file' && // Only files
          // Path filtering was already good, ensuring it applies to recursively found paths
          !f.path.startsWith('.lspace/') && 
          !f.path.includes('.git/') && // Check .git within path components too
          (f.path.endsWith('.md') || f.path.endsWith('.txt'))
        )
        .slice(0, maxContextFiles); // Limit number of files

      for (const file of kbFiles) {
        try {
          const fileContent = await repository.readFile(file.path); // Corrected: Use readFile instead of readFileContent
          contextContent += `\n\n--- File: ${file.path} ---\n${fileContent.substring(0, maxFileLength)}`;
          sources.push(file.path);
          if (contextContent.length > maxFileLength * maxContextFiles * 0.8) { // Heuristic to stop if context gets too big
            console.log(`[LLMService] Context length limit reached, stopping file reading.`);
            break;
          }
        } catch (readError: any) {
          console.warn(`[LLMService] Failed to read file ${file.path} for query context: ${readError.message}`);
        }
      }

      if (sources.length === 0) {
        console.log("[LLMService] No relevant KB files found to answer the query.");
        return { answer: "I could not find any relevant documents in the knowledge base to answer your query.", sources: [] };
      }

      const prompt = `You are a helpful AI assistant answering questions based on the provided knowledge base content.\nBased SOLELY on the following context from the knowledge base, please answer the user's query.\nDo not use any external knowledge. If the answer is not found in the context, say so clearly. Provide the answer as a concise, natural language text only.\n
CONTEXT:\n${contextContent}\n\nQUERY: ${queryText}\n\nANSWER:`;

      // Use callLLMWithHistory directly to control forceJsonResponse
      const history: ConversationTurn[] = [
        { role: 'system', content: 'You are a helpful AI assistant that provides concise, natural language answers based on provided context. Do not output JSON.' },
        { role: 'user', content: `CONTEXT:\n${contextContent}\n\nBased SOLELY on the above context, please answer the following query. If the answer is not found in the context, say so clearly. Do not use any external knowledge.\n\nQUERY: ${queryText}\n\nANSWER:` }
      ];

      const llmResponseString = await this.callLLMWithHistory(history, [], false); // forceJsonResponse = false
      
      let answer = "Sorry, I encountered an issue generating an answer.";
      if (llmResponseString) {
        try {
          // If forceJsonResponse was false, llmResponseString should be the direct text content, 
          // or a JSON string of the assistant's message if it chose to respond that way (less likely without tools).
          const parsed = JSON.parse(llmResponseString);
          answer = parsed.content || llmResponseString; // Prefer .content if it's an OpenAI message object string
        } catch (e) {
          answer = llmResponseString; // Assume it's plain text
        }
      }

      return {
        answer: answer,
        sources: sources,
      };

    } catch (error: any) {
      console.error(`[LLMService] Error querying knowledge base: ${error.message}`, error.stack);
      return {
        answer: `Error processing your query: ${error.message}`,
        sources: [],
      };
    }
  }
}

// Example usage (conceptual):
/*
async function main() {
  const llmService = new LLMService({
    apiKey: process.env.OPENAI_API_KEY || 'your-api-key',
  });

  const inputFile = "Some input document content...";
  const kbContext = "Current KB is empty."; // or some summary

  const result = await llmService.processDocumentConversational(inputFile, kbContext, 1, 1);
  console.log('Processing Result:', result.status);
  console.log('Conversation History:', JSON.stringify(result.history, null, 2));

  if (result.status === 'awaiting_final_summary' || result.status === 'file_processed') { // Simplified condition
    const summary = await llmService.generateKnowledgeBaseSummary(result.history);
    console.log('Final Summary:', summary);
  }
}

main().catch(console.error);
*/