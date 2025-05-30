import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Import the services we'll test (these don't exist yet)
import { OrchestratorService } from '../../src/orchestrator/orchestratorService';
import { RepositoryManager } from '../../src/core/repositoryManager';
import { Repository } from '../../src/core/repository';
import { LocalGitAdapter } from '../../src/adapters/localGitAdapter';

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to test repositories
const TEST_REPOS_DIR = path.join(__dirname, '..', '..', 'test-repos');
const REPO_PATH = path.join(TEST_REPOS_DIR, 'test-context');

describe('OrchestratorService', () => {
  let repositoryManager: RepositoryManager;
  let orchestratorService: OrchestratorService;
  let repository: Repository;
  let repoId: string;
  
  beforeEach(async () => {
    // Create test repository directory
    if (!fs.existsSync(REPO_PATH)) {
      fs.mkdirSync(REPO_PATH, { recursive: true });
    }
    
    // Initialize repository
    const adapter = new LocalGitAdapter();
    repository = await adapter.initialize(REPO_PATH);
    
    // Create repository manager
    repositoryManager = new RepositoryManager();
    repoId = await repositoryManager.registerRepository('test-context', repository);
    
    // Create orchestrator service
    orchestratorService = new OrchestratorService(repositoryManager);
    
    // Mock the LLM service
    vi.mock('../../src/orchestrator/llmService', () => ({
      LLMService: {
        classifyDocument: vi.fn(),
        structureDocument: vi.fn(),
        organizeContent: vi.fn(),
        detectDuplicates: vi.fn(),
        generateSummary: vi.fn()
      }
    }));
  });

  afterEach(() => {
    // Clean up test repository
    if (fs.existsSync(REPO_PATH)) {
      fs.rmSync(REPO_PATH, { recursive: true, force: true });
    }
    
    // Reset mocks
    vi.resetAllMocks();
  });

  it('should classify and add a new document', async () => {
    // Test document content
    const documentContent = `# Machine Learning Basics
    
This document provides an introduction to machine learning concepts.

## Supervised Learning

Supervised learning is a type of machine learning where the model is trained on labeled data.

## Unsupervised Learning

Unsupervised learning deals with unlabeled data.
`;
    
    // Mock the LLM service to classify this as a technical document
    const mockClassifyDocument = vi.spyOn(orchestratorService['llmService'], 'classifyDocument')
      .mockResolvedValue({
        category: 'technical',
        subcategory: 'machine-learning',
        suggestedPath: 'technical/machine-learning/basics.md',
        tags: ['machine-learning', 'ai', 'tutorial']
      });
    
    // Mock the LLM service to structure the document
    const mockStructureDocument = vi.spyOn(orchestratorService['llmService'], 'structureDocument')
      .mockResolvedValue({
        title: 'Machine Learning Basics',
        content: documentContent,
        frontMatter: {
          title: 'Machine Learning Basics',
          tags: ['machine-learning', 'ai', 'tutorial'],
          date: expect.any(String)
        }
      });
    
    // Process the document
    const result = await orchestratorService.processDocument(repoId, documentContent);
    
    // Verify that the document was classified
    expect(mockClassifyDocument).toHaveBeenCalledWith(documentContent);
    
    // Verify that the document was structured
    expect(mockStructureDocument).toHaveBeenCalledWith(documentContent, expect.any(Object));
    
    // Verify the result
    expect(result).toEqual({
      path: 'technical/machine-learning/basics.md',
      category: 'technical',
      subcategory: 'machine-learning',
      title: 'Machine Learning Basics',
      tags: ['machine-learning', 'ai', 'tutorial']
    });
    
    // Verify that the file was written to the repository
    const filePath = 'technical/machine-learning/basics.md';
    const fileExists = await repository.fileExists(filePath);
    expect(fileExists).toBe(true);
    
    // Verify that the commit was made
    const status = await repository.getStatus();
    expect(status.files.find(f => f.path === filePath)).toBeDefined();
  });

  it('should detect and handle duplicates when processing documents', async () => {
    // Create an existing document
    const existingContent = `# Machine Learning Basics
    
This is an existing document about machine learning.
`;
    const existingPath = 'technical/machine-learning/basics.md';
    
    // Create the directory structure
    const dirPath = path.join(REPO_PATH, 'technical/machine-learning');
    fs.mkdirSync(dirPath, { recursive: true });
    
    // Add the existing file to the repository
    await repository.writeFile(existingPath, existingContent);
    await repository.commit('Add existing document');
    
    // New document with similar content
    const newContent = `# Introduction to Machine Learning
    
This document covers the basics of machine learning concepts.
`;
    
    // Mock the LLM service to detect a duplicate
    const mockDetectDuplicates = vi.spyOn(orchestratorService['llmService'], 'detectDuplicates')
      .mockResolvedValue({
        isDuplicate: true,
        duplicatePath: existingPath,
        similarity: 0.85,
        mergeRecommendation: 'merge',
        mergedContent: `# Machine Learning Basics
        
This is an existing document about machine learning.

## Additional Information

This document covers the basics of machine learning concepts.
`
      });
    
    // Process the document
    const result = await orchestratorService.processDocument(repoId, newContent);
    
    // Verify that duplicate detection was called
    expect(mockDetectDuplicates).toHaveBeenCalled();
    
    // Verify the result
    expect(result).toEqual({
      path: existingPath,
      duplicate: true,
      similarity: 0.85,
      action: 'merge'
    });
    
    // Verify that the file was updated
    const updatedContent = await repository.readFile(existingPath);
    expect(updatedContent).toContain('Additional Information');
    
    // Verify that a commit was made
    const status = await repository.getStatus();
    expect(status.files.find(f => f.path === existingPath)).toBeDefined();
  });

  it('should organize and structure repository content', async () => {
    // Add multiple files to the repository
    const files = [
      { path: 'note1.md', content: '# Note about AI' },
      { path: 'note2.md', content: '# Another note about ML' },
      { path: 'random.md', content: '# Random thoughts' }
    ];
    
    for (const file of files) {
      await repository.writeFile(file.path, file.content);
    }
    await repository.commit('Add test files');
    
    // Mock the LLM service to organize content
    const mockOrganizeContent = vi.spyOn(orchestratorService['llmService'], 'organizeContent')
      .mockResolvedValue({
        moves: [
          { from: 'note1.md', to: 'ai/concepts.md' },
          { from: 'note2.md', to: 'ml/basics.md' }
        ],
        updates: [
          { 
            path: 'ai/concepts.md', 
            content: '# Artificial Intelligence Concepts\n\nFormerly note1.md\n\n# Note about AI'
          },
          { 
            path: 'ml/basics.md', 
            content: '# Machine Learning Basics\n\nFormerly note2.md\n\n# Another note about ML'
          }
        ],
        newFiles: [
          {
            path: 'README.md',
            content: '# Knowledge Base\n\n- [AI Concepts](ai/concepts.md)\n- [ML Basics](ml/basics.md)'
          }
        ]
      });
    
    // Organize the repository content
    const result = await orchestratorService.organizeRepository(repoId);
    
    // Verify that organize content was called
    expect(mockOrganizeContent).toHaveBeenCalled();
    
    // Verify the result
    expect(result).toEqual({
      moved: 2,
      updated: 2,
      created: 1,
      unchanged: 1 // random.md was left unchanged
    });
    
    // Verify that the files were reorganized
    const aiConceptsExists = await repository.fileExists('ai/concepts.md');
    const mlBasicsExists = await repository.fileExists('ml/basics.md');
    const readmeExists = await repository.fileExists('README.md');
    
    expect(aiConceptsExists).toBe(true);
    expect(mlBasicsExists).toBe(true);
    expect(readmeExists).toBe(true);
    
    // Verify that a commit was made
    const status = await repository.getStatus();
    expect(status.branch).toBe('main');
  });

  it('should generate a summary for a repository', async () => {
    // Add test files
    const files = [
      { path: 'ai/concepts.md', content: '# AI Concepts' },
      { path: 'ml/basics.md', content: '# ML Basics' },
      { path: 'README.md', content: '# Knowledge Base' }
    ];
    
    // Create directory structure
    fs.mkdirSync(path.join(REPO_PATH, 'ai'), { recursive: true });
    fs.mkdirSync(path.join(REPO_PATH, 'ml'), { recursive: true });
    
    for (const file of files) {
      await repository.writeFile(file.path, file.content);
    }
    await repository.commit('Add test files');
    
    // Mock the LLM service to generate a summary
    const mockGenerateSummary = vi.spyOn(orchestratorService['llmService'], 'generateSummary')
      .mockResolvedValue({
        title: 'AI/ML Knowledge Base',
        description: 'A collection of notes on artificial intelligence and machine learning.',
        topics: ['ai', 'machine-learning'],
        fileCount: 3,
        mainCategories: ['ai', 'ml'],
        lastUpdated: expect.any(String)
      });
    
    // Generate the summary
    const summary = await orchestratorService.generateRepositorySummary(repoId);
    
    // Verify that generate summary was called
    expect(mockGenerateSummary).toHaveBeenCalled();
    
    // Verify the summary
    expect(summary).toEqual({
      title: 'AI/ML Knowledge Base',
      description: 'A collection of notes on artificial intelligence and machine learning.',
      topics: ['ai', 'machine-learning'],
      fileCount: 3,
      mainCategories: ['ai', 'ml'],
      lastUpdated: expect.any(String)
    });
  });

  it('should prune obsolete or redundant information', async () => {
    // Add test files with some obsolete content
    const files = [
      { path: 'outdated.md', content: '# Outdated Information\n\nThis is obsolete.' },
      { path: 'duplicate1.md', content: '# Duplicate Content\n\nThis is duplicate content.' },
      { path: 'duplicate2.md', content: '# Duplicate Content\n\nThis is duplicate content with minor changes.' },
      { path: 'current.md', content: '# Current Information\n\nThis is up to date.' }
    ];
    
    for (const file of files) {
      await repository.writeFile(file.path, file.content);
    }
    await repository.commit('Add test files');
    
    // Mock the pruning recommendations
    vi.spyOn(orchestratorService['llmService'], 'detectDuplicates')
      .mockResolvedValue({
        obsoleteFiles: ['outdated.md'],
        duplicates: [
          { original: 'duplicate1.md', duplicate: 'duplicate2.md', similarity: 0.9 }
        ],
        recommendations: [
          { action: 'delete', path: 'outdated.md', reason: 'Information is obsolete' },
          { action: 'merge', source: 'duplicate2.md', target: 'duplicate1.md', reason: 'Duplicate content' }
        ]
      });
    
    // Prune the repository
    const result = await orchestratorService.pruneRepository(repoId);
    
    // Verify the result
    expect(result).toEqual({
      deleted: 1, // outdated.md
      merged: 1,  // duplicate2.md merged into duplicate1.md
      unchanged: 1 // current.md
    });
    
    // Verify that files were properly handled
    const outdatedExists = await repository.fileExists('outdated.md');
    const duplicate2Exists = await repository.fileExists('duplicate2.md');
    const currentExists = await repository.fileExists('current.md');
    
    expect(outdatedExists).toBe(false);
    expect(duplicate2Exists).toBe(false);
    expect(currentExists).toBe(true);
    
    // Verify that a commit was made
    const status = await repository.getStatus();
    expect(status.branch).toBe('main');
  });
});