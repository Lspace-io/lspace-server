import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Import the webhook API
import { setupWebhookRoutes } from '../../src/api/webhookApi';
import { WebhookService } from '../../src/services/webhookService';
import { RepositoryManager } from '../../src/core/repositoryManager';

describe('Webhook API', () => {
  let app: express.Application;
  let mockRepositoryManager: RepositoryManager;
  let mockWebhookService: WebhookService;
  
  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();
    
    // Create Express app
    app = express();
    app.use(express.json());
    
    // Create mock repository manager
    mockRepositoryManager = new RepositoryManager();
    vi.spyOn(mockRepositoryManager, 'getRepository').mockImplementation((id) => {
      if (id === 'repo1-id') {
        return {
          path: '/path/to/repo1'
        } as any;
      }
      throw new Error('Repository not found');
    });
    
    // Create mock webhook service
    mockWebhookService = {
      registerWebhook: vi.fn(),
      unregisterWebhook: vi.fn(),
      listWebhooks: vi.fn(),
      triggerWebhook: vi.fn(),
      validateWebhookPayload: vi.fn()
    } as any;
    
    // Set up API routes
    setupWebhookRoutes(app, mockRepositoryManager, mockWebhookService);
  });

  it('should register a new webhook', async () => {
    // Mock the webhook service
    mockWebhookService.registerWebhook.mockResolvedValue({
      id: 'webhook1',
      url: 'https://example.com/webhook',
      events: ['commit', 'file.added'],
      secret: 'webhook-secret'
    });
    
    const response = await request(app)
      .post('/api/repositories/repo1-id/webhooks')
      .send({
        url: 'https://example.com/webhook',
        events: ['commit', 'file.added'],
        secret: 'webhook-secret'
      })
      .expect('Content-Type', /json/)
      .expect(201);
    
    expect(response.body).toEqual({
      id: 'webhook1',
      url: 'https://example.com/webhook',
      events: ['commit', 'file.added']
      // Secret should not be returned in the response
    });
    
    expect(mockWebhookService.registerWebhook).toHaveBeenCalledWith(
      'repo1-id',
      {
        url: 'https://example.com/webhook',
        events: ['commit', 'file.added'],
        secret: 'webhook-secret'
      }
    );
  });

  it('should list all webhooks for a repository', async () => {
    // Mock the webhook service
    mockWebhookService.listWebhooks.mockResolvedValue([
      {
        id: 'webhook1',
        url: 'https://example.com/webhook1',
        events: ['commit']
      },
      {
        id: 'webhook2',
        url: 'https://example.com/webhook2',
        events: ['file.added', 'file.modified']
      }
    ]);
    
    const response = await request(app)
      .get('/api/repositories/repo1-id/webhooks')
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual([
      {
        id: 'webhook1',
        url: 'https://example.com/webhook1',
        events: ['commit']
      },
      {
        id: 'webhook2',
        url: 'https://example.com/webhook2',
        events: ['file.added', 'file.modified']
      }
    ]);
    
    expect(mockWebhookService.listWebhooks).toHaveBeenCalledWith('repo1-id');
  });

  it('should unregister a webhook', async () => {
    // Mock the webhook service
    mockWebhookService.unregisterWebhook.mockResolvedValue(true);
    
    await request(app)
      .delete('/api/repositories/repo1-id/webhooks/webhook1')
      .expect(204);
    
    expect(mockWebhookService.unregisterWebhook).toHaveBeenCalledWith('repo1-id', 'webhook1');
  });

  it('should test a webhook', async () => {
    // Mock the webhook service
    mockWebhookService.triggerWebhook.mockResolvedValue({
      success: true,
      statusCode: 200
    });
    
    const response = await request(app)
      .post('/api/repositories/repo1-id/webhooks/webhook1/test')
      .send({
        event: 'commit',
        payload: {
          commit: 'test-commit',
          message: 'Test commit'
        }
      })
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      statusCode: 200
    });
    
    expect(mockWebhookService.triggerWebhook).toHaveBeenCalledWith(
      'repo1-id',
      'webhook1',
      'commit',
      {
        commit: 'test-commit',
        message: 'Test commit'
      }
    );
  });

  it('should handle incoming webhook for GitHub integration', async () => {
    // Mock the webhook validator
    mockWebhookService.validateWebhookPayload.mockReturnValue(true);
    
    // This is a mock of a GitHub webhook payload
    const githubPayload = {
      ref: 'refs/heads/main',
      repository: {
        name: 'test-repo',
        owner: {
          name: 'test-owner'
        }
      },
      commits: [
        {
          id: 'commit-id',
          message: 'Test commit',
          added: ['new-file.md'],
          modified: ['modified-file.md'],
          removed: []
        }
      ]
    };
    
    const response = await request(app)
      .post('/api/webhooks/github')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', 'sha256=mock-signature')
      .send(githubPayload)
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      event: 'push',
      repository: 'test-repo'
    });
    
    expect(mockWebhookService.validateWebhookPayload).toHaveBeenCalledWith(
      expect.any(Buffer),
      'sha256=mock-signature',
      expect.any(String)
    );
  });

  it('should return 404 for non-existent repository', async () => {
    // Mock the repository manager to throw for non-existent repository
    vi.spyOn(mockRepositoryManager, 'getRepository').mockImplementation((id) => {
      throw new Error('Repository not found');
    });
    
    await request(app)
      .post('/api/repositories/non-existent/webhooks')
      .send({
        url: 'https://example.com/webhook',
        events: ['commit']
      })
      .expect(404);
  });

  it('should return 404 for non-existent webhook', async () => {
    // Mock the webhook service to throw for non-existent webhook
    mockWebhookService.unregisterWebhook.mockRejectedValue(
      new Error('Webhook not found')
    );
    
    await request(app)
      .delete('/api/repositories/repo1-id/webhooks/non-existent')
      .expect(404);
  });

  it('should validate webhook secrets', async () => {
    // Mock the webhook validator to return false
    mockWebhookService.validateWebhookPayload.mockReturnValue(false);
    
    await request(app)
      .post('/api/webhooks/github')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', 'sha256=invalid-signature')
      .send({})
      .expect(401);
  });
});