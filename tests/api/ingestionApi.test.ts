import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Import the ingestion API
import { setupIngestionRoutes } from '../../src/api/ingestionApi';
import { RepositoryManager } from '../../src/core/repositoryManager';
import { OrchestratorService } from '../../src/orchestrator/orchestratorService';

describe('Ingestion API', () => {
  let app: express.Application;
  let mockRepositoryManager: RepositoryManager;
  let mockOrchestratorService: OrchestratorService;
  
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
          path: '/path/to/repo1',
          writeFile: vi.fn().mockResolvedValue(undefined),
          commit: vi.fn().mockResolvedValue({ success: true, hash: 'commit-hash' })
        } as any;
      }
      throw new Error('Repository not found');
    });
    
    vi.spyOn(mockRepositoryManager, 'getRepositoryId').mockImplementation((name) => {
      if (name === 'repo1') {
        return 'repo1-id';
      }
      throw new Error('Repository not found');
    });
    
    // Create mock orchestrator service
    mockOrchestratorService = {
      processDocument: vi.fn(),
      processDocuments: vi.fn(),
      organizeRepository: vi.fn(),
      generateRepositorySummary: vi.fn(),
      pruneRepository: vi.fn()
    } as any;
    
    // Set up API routes
    setupIngestionRoutes(app, mockRepositoryManager, mockOrchestratorService);
  });

  it('should ingest a single document', async () => {
    // Mock the orchestrator to process the document
    mockOrchestratorService.processDocument.mockResolvedValue({
      path: 'docs/ai/concept.md',
      category: 'ai',
      title: 'AI Concept'
    });
    
    const response = await request(app)
      .post('/api/ingest/repo1-id')
      .send({
        content: '# AI Concept\n\nThis is a document about artificial intelligence.',
        metadata: {
          source: 'user-upload',
          tags: ['ai', 'concept']
        }
      })
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      path: 'docs/ai/concept.md',
      category: 'ai',
      title: 'AI Concept'
    });
    
    expect(mockOrchestratorService.processDocument).toHaveBeenCalledWith(
      'repo1-id',
      '# AI Concept\n\nThis is a document about artificial intelligence.',
      {
        source: 'user-upload',
        tags: ['ai', 'concept']
      }
    );
  });

  it('should ingest multiple documents', async () => {
    // Mock the orchestrator to process multiple documents
    mockOrchestratorService.processDocuments.mockResolvedValue({
      processed: 2,
      paths: ['docs/ai/concept.md', 'docs/ml/basics.md'],
      results: [
        {
          path: 'docs/ai/concept.md',
          category: 'ai',
          title: 'AI Concept'
        },
        {
          path: 'docs/ml/basics.md',
          category: 'ml',
          title: 'ML Basics'
        }
      ]
    });
    
    const response = await request(app)
      .post('/api/ingest/repo1-id/batch')
      .send({
        documents: [
          {
            content: '# AI Concept\n\nThis is a document about artificial intelligence.',
            metadata: {
              source: 'user-upload',
              tags: ['ai', 'concept']
            }
          },
          {
            content: '# ML Basics\n\nThis is a document about machine learning basics.',
            metadata: {
              source: 'user-upload',
              tags: ['ml', 'basics']
            }
          }
        ]
      })
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      processed: 2,
      paths: ['docs/ai/concept.md', 'docs/ml/basics.md']
    });
    
    expect(mockOrchestratorService.processDocuments).toHaveBeenCalledWith(
      'repo1-id',
      [
        {
          content: '# AI Concept\n\nThis is a document about artificial intelligence.',
          metadata: {
            source: 'user-upload',
            tags: ['ai', 'concept']
          }
        },
        {
          content: '# ML Basics\n\nThis is a document about machine learning basics.',
          metadata: {
            source: 'user-upload',
            tags: ['ml', 'basics']
          }
        }
      ]
    );
  });

  it('should ingest from URL', async () => {
    // Mock the orchestrator to process the document
    mockOrchestratorService.processDocument.mockResolvedValue({
      path: 'docs/web/article.md',
      category: 'web',
      title: 'Web Article'
    });
    
    // Mock the fetch function (would be injected in the real implementation)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('# Web Article\n\nThis is a web article.')
    });
    
    const response = await request(app)
      .post('/api/ingest/repo1-id/url')
      .send({
        url: 'https://example.com/article',
        metadata: {
          source: 'web',
          tags: ['article']
        }
      })
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      path: 'docs/web/article.md',
      category: 'web',
      title: 'Web Article'
    });
    
    expect(global.fetch).toHaveBeenCalledWith('https://example.com/article');
    expect(mockOrchestratorService.processDocument).toHaveBeenCalledWith(
      'repo1-id',
      '# Web Article\n\nThis is a web article.',
      {
        source: 'web',
        tags: ['article'],
        url: 'https://example.com/article'
      }
    );
  });

  it('should restructure a repository', async () => {
    // Mock the orchestrator to organize the repository
    mockOrchestratorService.organizeRepository.mockResolvedValue({
      moved: 2,
      updated: 3,
      created: 1,
      unchanged: 1
    });
    
    const response = await request(app)
      .post('/api/ingest/repo1-id/organize')
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      moved: 2,
      updated: 3,
      created: 1,
      unchanged: 1
    });
    
    expect(mockOrchestratorService.organizeRepository).toHaveBeenCalledWith('repo1-id');
  });

  it('should process text from connectors', async () => {
    // Mock the orchestrator to process the document
    mockOrchestratorService.processDocument.mockResolvedValue({
      path: 'connectors/slack/message.md',
      category: 'communication',
      title: 'Slack Message'
    });
    
    const response = await request(app)
      .post('/api/ingest/repo1-id/connector')
      .send({
        connector: 'slack',
        content: 'This is a message from Slack.',
        metadata: {
          channel: 'general',
          user: 'user1',
          timestamp: '2023-05-01T12:00:00Z'
        }
      })
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      path: 'connectors/slack/message.md',
      category: 'communication',
      title: 'Slack Message'
    });
    
    expect(mockOrchestratorService.processDocument).toHaveBeenCalledWith(
      'repo1-id',
      'This is a message from Slack.',
      {
        connector: 'slack',
        channel: 'general',
        user: 'user1',
        timestamp: '2023-05-01T12:00:00Z'
      }
    );
  });

  it('should return 404 for non-existent repository', async () => {
    await request(app)
      .post('/api/ingest/non-existent')
      .send({
        content: '# Test Document',
        metadata: {}
      })
      .expect(404);
  });

  it('should handle processing errors', async () => {
    // Mock the orchestrator to throw an error
    mockOrchestratorService.processDocument.mockRejectedValue(
      new Error('Processing failed')
    );
    
    await request(app)
      .post('/api/ingest/repo1-id')
      .send({
        content: '# Test Document',
        metadata: {}
      })
      .expect(500);
  });
});