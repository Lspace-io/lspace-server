import { MCPTool, MCPToolParameters } from '../registerTools';
import { ProcessableInput } from '../../orchestrator/orchestratorService';

const submitContentTool: MCPTool = {
  name: 'submit_content_to_lspace',
  description: 'Submits content (text snippet, file upload, or web URL) to a specified Lspace repository for ingestion and knowledge base integration.',
  parameters: {
    type: 'object',
    properties: {
      repositoryId: {
        type: 'string',
        description: 'The ID of the Lspace repository.',
      },
      inputType: {
        type: 'string',
        description: 'The type of content being submitted.',
        enum: ['text_snippet', 'file_upload', 'web_url'],
      },
      content: {
        type: 'string',
        description: 'The actual content (for text_snippet or file_upload). Base64 encode for binary files.',
      },
      fileName: {
        type: 'string',
        description: 'The name of the file (for file_upload type). Required if inputType is file_upload.',
      },
      url: {
        type: 'string',
        description: 'The URL to fetch content from (for web_url type). Required if inputType is web_url.',
      },
      title: {
        type: 'string',
        description: 'An optional title for the content (e.g., for text_snippet or to override fetched title for web_url). Tiebreak for filename if not provided for file_upload.',
      },
      user: {
        type: 'string',
        description: 'Optional identifier for the user submitting the content.',
      },
      metadata: {
        type: 'object',
        description: 'Optional additional metadata for the input. Pass as a flat JSON object.',
      },
    },
    required: ['repositoryId', 'inputType'], // Content/fileName/url become conditionally required
  },
  run: async (args: any, services) => {
    console.log(`[MCP submit_content_to_lspace] Called with args: ${JSON.stringify(args)}`);
    const { orchestratorService } = services;
    const { repositoryId, inputType, content, fileName, url, title, user, metadata } = args;

    let processableInput: ProcessableInput;

    switch (inputType) {
      case 'file_upload':
        if (!content) {
          throw new Error('Missing required parameter "content" for file_upload.');
        }
        if (!fileName && !title) {
          throw new Error('Missing required parameter "fileName" or "title" for file_upload.');
        }
        processableInput = {
          type: 'file_upload',
          repositoryId,
          fileName: fileName || title, // Use title as fallback for fileName
          content,
          user,
          metadata,
        };
        break;
      case 'text_snippet':
        if (!content) {
          throw new Error('Missing required parameter "content" for text_snippet.');
        }
        processableInput = {
          type: 'text_snippet',
          repositoryId,
          title,
          content,
          user,
          metadata,
        };
        break;
      case 'web_url':
        if (!url) {
          throw new Error('Missing required parameter "url" for web_url.');
        }
        processableInput = {
          type: 'web_url',
          repositoryId,
          url,
          user,
          metadata,
          // Title from args could be used by orchestrator if it decides to allow overriding fetched titles
        };
        break;
      default:
        throw new Error(`Unsupported inputType: ${inputType}. Must be one of ['text_snippet', 'file_upload', 'web_url'].`);
    }

    try {
      const result = await orchestratorService.processInput(processableInput);
      return result; // The OrchestratorService.processInput result is already structured well for an MCP response
    } catch (error: any) {
      console.error(`[MCP submit_content_to_lspace] Error calling orchestratorService.processInput: ${error.message}`, error.stack);
      throw new Error(`Failed to submit content to Lspace: ${error.message}`); // Re-throw to be caught by MCP handler
    }
  },
};

export default submitContentTool; 