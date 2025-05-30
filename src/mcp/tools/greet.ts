import { MCPTool, MCPToolParameters } from '../registerTools';

const greetTool: MCPTool = {
  name: 'greet',
  description: 'Responds with a greeting to the provided name.',
  parameters: {
    type: 'object',
    properties: {
      name: { 
        type: 'string',
        description: 'The name of the person to greet.'
      }
    },
    required: ['name']
  } as MCPToolParameters, // Type assertion for parameters
  run: async (args: { name: string }, services) => {
    // services.orchestratorService, services.repositoryManager etc. are available if needed
    if (!args || typeof args.name !== 'string') {
      throw new Error('Invalid arguments: name must be a string');
    }
    return `Hello, ${args.name}! Your existing MCP setup is being used.`;
  }
};

export default greetTool; 