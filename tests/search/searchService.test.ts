import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Import the services we'll test (these don't exist yet)
import { SearchService } from '../../src/search/searchService';
import { RepositoryManager } from '../../src/core/repositoryManager';
import { Repository } from '../../src/core/repository';
import { LocalGitAdapter } from '../../src/adapters/localGitAdapter';

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to test repositories
const TEST_REPOS_DIR = path.join(__dirname, '..', '..', 'test-repos');
const REPO1_PATH = path.join(TEST_REPOS_DIR, 'repo1');
const REPO2_PATH = path.join(TEST_REPOS_DIR, 'repo2');

describe('SearchService', () => {
  let repositoryManager: RepositoryManager;
  let searchService: SearchService;
  let repo1: Repository;
  let repo2: Repository;
  let repo1Id: string;
  let repo2Id: string;
  
  beforeEach(async () => {
    // Create test repositories directories
    [REPO1_PATH, REPO2_PATH].forEach(repoPath => {
      if (!fs.existsSync(repoPath)) {
        fs.mkdirSync(repoPath, { recursive: true });
      }
    });
    
    // Initialize repositories
    const adapter = new LocalGitAdapter();
    repo1 = await adapter.initialize(REPO1_PATH);
    repo2 = await adapter.initialize(REPO2_PATH);
    
    // Create repository manager
    repositoryManager = new RepositoryManager();
    repo1Id = await repositoryManager.registerRepository('repo1', repo1);
    repo2Id = await repositoryManager.registerRepository('repo2', repo2);
    
    // Create test files in repositories
    const testFiles = [
      { repo: repo1, path: 'doc1.md', content: '# Document 1\n\nThis is a test document about **artificial intelligence** and machine learning.' },
      { repo: repo1, path: 'doc2.md', content: '# Document 2\n\nThis document discusses **git** repositories and version control systems.' },
      { repo: repo2, path: 'doc3.md', content: '# Document 3\n\nHere we talk about **artificial intelligence** applications in business.' },
      { repo: repo2, path: 'doc4.md', content: '# Document 4\n\nThis is about software development and **programming** best practices.' },
    ];
    
    for (const file of testFiles) {
      await file.repo.writeFile(file.path, file.content);
      await file.repo.commit(`Add ${file.path}`);
    }
    
    // Create search service
    searchService = new SearchService(repositoryManager);
    
    // Initialize search index
    await searchService.initializeIndex();
  });

  afterEach(() => {
    // Clean up test repositories
    [REPO1_PATH, REPO2_PATH].forEach(repoPath => {
      if (fs.existsSync(repoPath)) {
        fs.rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  it('should perform keyword search across repositories', async () => {
    // Search for the keyword "artificial intelligence"
    const results = await searchService.keywordSearch('artificial intelligence');
    
    // Should find 2 documents
    expect(results).toHaveLength(2);
    
    // Verify the results
    expect(results).toContainEqual(expect.objectContaining({ 
      repositoryId: repo1Id,
      path: 'doc1.md',
      score: expect.any(Number),
    }));
    
    expect(results).toContainEqual(expect.objectContaining({ 
      repositoryId: repo2Id,
      path: 'doc3.md',
      score: expect.any(Number),
    }));
    
    // Results should be sorted by score (highest first)
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it('should perform semantic search using embeddings', async () => {
    // Search for semantically similar content to "AI applications"
    const results = await searchService.semanticSearch('AI applications');
    
    // Should find relevant documents
    expect(results.length).toBeGreaterThan(0);
    
    // The first result should be doc3.md (most relevant to AI applications)
    expect(results[0]).toEqual(expect.objectContaining({ 
      repositoryId: repo2Id,
      path: 'doc3.md',
      score: expect.any(Number)
    }));
  });

  it('should filter search results by repository', async () => {
    // Search only in repo1
    const results = await searchService.keywordSearch('document', { repositoryId: repo1Id });
    
    // Should find documents only from repo1
    expect(results.length).toBeGreaterThan(0);
    results.forEach(result => {
      expect(result.repositoryId).toBe(repo1Id);
    });
  });

  it('should update search index when files change', async () => {
    // Add a new file to repo1
    await repo1.writeFile('new-doc.md', '# New Document\n\nThis document is about **quantum computing**.');
    await repo1.commit('Add new-doc.md');
    
    // Update the index
    await searchService.updateIndex(repo1Id);
    
    // Search for "quantum"
    const results = await searchService.keywordSearch('quantum');
    
    // Should find the new document
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({ 
      repositoryId: repo1Id,
      path: 'new-doc.md',
      score: expect.any(Number)
    }));
  });

  it('should search for related files', async () => {
    // Find files related to doc1.md
    const results = await searchService.findRelatedFiles(repo1Id, 'doc1.md');
    
    // Should find doc3.md as related (both about AI)
    expect(results).toContainEqual(expect.objectContaining({ 
      repositoryId: repo2Id,
      path: 'doc3.md',
      score: expect.any(Number)
    }));
  });
});