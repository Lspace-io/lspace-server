import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Import the repositories API
import { setupFileModificationRoutes } from '../../src/api/fileModificationApi';
import { RepositoryManager } from '../../src/core/repositoryManager';

describe('File Modification API', () => {
  let app: express.Application;
  let mockRepositoryManager: RepositoryManager;
  
  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();
    
    // Create Express app
    app = express();
    app.use(express.json());
    
    // Create mocked repository
    const mockRepo = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue('# Existing content'),
      commit: vi.fn().mockResolvedValue({ success: true, hash: 'commit-hash' }),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      fileExists: vi.fn().mockImplementation((path) => {
        return Promise.resolve(path === 'existing.md');
      }),
      moveFile: vi.fn().mockResolvedValue(undefined)
    };
    
    // Create mock repository manager
    mockRepositoryManager = {
      getRepository: vi.fn().mockImplementation((id) => {
        if (id === 'repo1-id') {
          return mockRepo;
        }
        throw new Error('Repository not found');
      }),
      getRepositoryId: vi.fn().mockImplementation((name) => {
        if (name === 'repo1') {
          return 'repo1-id';
        }
        throw new Error('Repository not found');
      })
    } as any;
    
    // Set up API routes
    setupFileModificationRoutes(app, mockRepositoryManager as any);
  });

  it('should create a new file', async () => {
    const response = await request(app)
      .post('/api/repositories/repo1-id/files')
      .send({
        path: 'new-file.md',
        content: '# New File\n\nThis is a new file.'
      })
      .expect('Content-Type', /json/)
      .expect(201);
    
    expect(response.body).toEqual({
      success: true,
      path: 'new-file.md',
      commit: 'commit-hash'
    });
    
    const repository = mockRepositoryManager.getRepository('repo1-id');
    expect(repository.writeFile).toHaveBeenCalledWith(
      'new-file.md',
      '# New File\n\nThis is a new file.'
    );
    expect(repository.commit).toHaveBeenCalledWith(
      expect.stringContaining('Add new-file.md')
    );
  });

  it('should update an existing file', async () => {
    const repository = mockRepositoryManager.getRepository('repo1-id');
    
    const response = await request(app)
      .put('/api/repositories/repo1-id/files/existing.md')
      .send({
        content: '# Updated File\n\nThis file has been updated.'
      })
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      path: 'existing.md',
      commit: 'commit-hash'
    });
    
    expect(repository.writeFile).toHaveBeenCalledWith(
      'existing.md',
      '# Updated File\n\nThis file has been updated.'
    );
    expect(repository.commit).toHaveBeenCalledWith(
      expect.stringContaining('Update existing.md')
    );
  });

  it('should delete a file', async () => {
    const repository = mockRepositoryManager.getRepository('repo1-id');
    
    const response = await request(app)
      .delete('/api/repositories/repo1-id/files/existing.md')
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      path: 'existing.md',
      commit: 'commit-hash'
    });
    
    expect(repository.deleteFile).toHaveBeenCalledWith('existing.md');
    expect(repository.commit).toHaveBeenCalledWith(
      expect.stringContaining('Delete existing.md')
    );
  });

  it('should move/rename a file', async () => {
    const repository = mockRepositoryManager.getRepository('repo1-id');
    
    const response = await request(app)
      .post('/api/repositories/repo1-id/files/move')
      .send({
        oldPath: 'existing.md',
        newPath: 'renamed.md'
      })
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      oldPath: 'existing.md',
      newPath: 'renamed.md',
      commit: 'commit-hash'
    });
    
    expect(repository.moveFile).toHaveBeenCalledWith('existing.md', 'renamed.md');
    expect(repository.commit).toHaveBeenCalledWith(
      expect.stringContaining('Move existing.md to renamed.md')
    );
  });

  it('should return 404 for non-existent repository', async () => {
    await request(app)
      .post('/api/repositories/non-existent/files')
      .send({
        path: 'new-file.md',
        content: '# New File'
      })
      .expect(404);
  });

  it('should return 404 for non-existent file', async () => {
    await request(app)
      .put('/api/repositories/repo1-id/files/non-existent.md')
      .send({
        content: '# Updated File'
      })
      .expect(404);
  });

  it('should apply a patch to a file', async () => {
    const repository = mockRepositoryManager.getRepository('repo1-id');
    
    // Mock file exists check
    repository.fileExists = vi.fn().mockResolvedValue(true);
    
    // Mock readFile to return original content
    repository.readFile = vi.fn().mockResolvedValue('# Original Content\n\nThis is the original file content.');
    
    const response = await request(app)
      .patch('/api/repositories/repo1-id/files/existing.md')
      .send({
        patches: [
          { operation: 'replace', path: '/title', value: 'Updated Title' },
          { operation: 'add', path: '/sections/-', value: '## New Section\n\nThis is a new section.' }
        ]
      })
      .expect('Content-Type', /json/)
      .expect(200);
    
    expect(response.body).toEqual({
      success: true,
      path: 'existing.md',
      commit: 'commit-hash'
    });
    
    // The implementation would need to apply the JSON Patch to the markdown,
    // but for this test we're just making sure the API routes are working
    expect(repository.writeFile).toHaveBeenCalled();
    expect(repository.commit).toHaveBeenCalledWith(
      expect.stringContaining('Update existing.md')
    );
  });

  it('should create multiple files in a single commit', async () => {
    const repository = mockRepositoryManager.getRepository('repo1-id');
    
    const response = await request(app)
      .post('/api/repositories/repo1-id/files/batch')
      .send({
        files: [
          { path: 'file1.md', content: '# File 1' },
          { path: 'file2.md', content: '# File 2' },
          { path: 'docs/file3.md', content: '# File 3' }
        ],
        commitMessage: 'Add multiple files'
      })
      .expect('Content-Type', /json/)
      .expect(201);
    
    expect(response.body).toEqual({
      success: true,
      fileCount: 3,
      commit: 'commit-hash'
    });
    
    expect(repository.writeFile).toHaveBeenCalledTimes(3);
    expect(repository.commit).toHaveBeenCalledWith('Add multiple files');
  });
});