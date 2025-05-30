import { MCPTool, MCPToolParameters } from '../registerTools';

const dummyTool: MCPTool = {
  name: 'dummy_tool',
  description: 'A simple dummy tool for testing the MCP server setup. Echoes input.',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'A message to echo back.',
      },
      repeat: {
        type: 'number',
        description: 'Number of times to repeat the message.',
      },
    },
    required: ['message'],
  },
  run: async (args: { message: string; repeat?: number }, services) => {
    // services.orchestratorService can be used here if needed, for example.
    // services.repositoryManager etc.
    console.log(`[MCP DummyTool] Called with args: ${JSON.stringify(args)}`);
    if (args.message === 'throw_error') {
      throw new Error('Dummy tool intentionally thrown error!');
    }
    let response = `Dummy tool received: ${args.message}`;
    if (args.repeat && args.repeat > 0) {
      response = Array(args.repeat).fill(args.message).join(', ');
    }
    return { echoedMessage: response };
  },
};

export default dummyTool; 