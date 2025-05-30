import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GitHubAdapter } from '../../src/adapters/githubGitAdapter';
import { Repository } from '../../src/core/repository';

// Mock the GitHub API
vi.mock('@octokit/rest', () => {
  return {
    Octokit: vi.fn(() => ({
      repos: {
        get: vi.fn(),
        getContent: vi.fn(),
        createOrUpdateFileContents: vi.fn(),
        listCommits: vi.fn()
      },
      git: {
        getTree: vi.fn(),
        createBlob: vi.fn(),
        createTree: vi.fn(),
        createCommit: vi.fn(),
        updateRef: vi.fn()
      }
    }))
  };
});

describe('GitHubAdapter', () => {
  let adapter: GitHubAdapter;
  let mockOctokit: any;
  
  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();
    
    // Create adapter with mock credentials
    adapter = new GitHubAdapter({
      token: 'mock-token',
      owner: 'test-owner',
      repo: 'test-repo'
    });
    
    // Get reference to the mocked Octokit instance
    mockOctokit = adapter['octokit'];
  });

  it('should initialize a repository', async () => {
    // Mock repository information
    mockOctokit.repos.get.mockResolvedValue({
      data: {
        name: 'test-repo',
        owner: { login: 'test-owner' },
        default_branch: 'main'
      }
    });
    
    // Call initialize
    const repository = await adapter.initialize();
    
    // Verify the repository
    expect(repository).toBeInstanceOf(Repository);
    expect(repository.path).toBe('github://test-owner/test-repo');
    
    // Verify that the GitHub API was called
    expect(mockOctokit.repos.get).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo'
    });
  });

  it('should add a file to the repository', async () => {
    // Mock repository initialization
    mockOctokit.repos.get.mockResolvedValue({
      data: {
        name: 'test-repo',
        owner: { login: 'test-owner' },
        default_branch: 'main'
      }
    });
    
    // Mock the GitHub API for creating file content
    mockOctokit.repos.createOrUpdateFileContents.mockResolvedValue({
      data: {
        content: { sha: 'new-file-sha' },
        commit: { sha: 'new-commit-sha' }
      }
    });
    
    // Initialize repository
    const repository = await adapter.initialize();
    
    // Write a file
    const testFilePath = 'test-file.md';
    const testFileContent = '# Test File\n\nThis is a test file.';
    
    await repository.writeFile(testFilePath, testFileContent);
    
    // Verify that the GitHub API was called to create the file
    expect(mockOctokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      path: testFilePath,
      message: expect.stringContaining('Add test-file.md'),
      content: expect.any(String), // Base64 encoded content
      branch: 'main'
    });
  });

  it('should commit changes to the repository', async () => {
    // Mock repository initialization
    mockOctokit.repos.get.mockResolvedValue({
      data: {
        name: 'test-repo',
        owner: { login: 'test-owner' },
        default_branch: 'main'
      }
    });
    
    // Mock the git API for creating a commit
    mockOctokit.git.createCommit.mockResolvedValue({
      data: { sha: 'new-commit-sha' }
    });
    
    // Mock the git API for updating a reference
    mockOctokit.git.updateRef.mockResolvedValue({
      data: { ref: 'refs/heads/main', object: { sha: 'new-commit-sha' } }
    });
    
    // Initialize repository
    const repository = await adapter.initialize();
    
    // Stage a file (this is handled internally in the GitHub adapter)
    repository['stagedFiles'] = [
      { path: 'test-file.md', content: '# Test File', mode: '100644' }
    ];
    
    // Create a commit
    const commitResult = await repository.commit('Test commit message');
    
    // Verify the commit result
    expect(commitResult.success).toBe(true);
    expect(commitResult.hash).toBe('new-commit-sha');
    
    // Verify that the GitHub API was called to create the commit
    expect(mockOctokit.git.createCommit).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      message: 'Test commit message',
      tree: expect.any(String),
      parents: expect.any(Array)
    });
    
    // Verify that the GitHub API was called to update the reference
    expect(mockOctokit.git.updateRef).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      ref: 'heads/main',
      sha: 'new-commit-sha'
    });
  });

  it('should read a file from the repository', async () => {
    // Mock repository initialization
    mockOctokit.repos.get.mockResolvedValue({
      data: {
        name: 'test-repo',
        owner: { login: 'test-owner' },
        default_branch: 'main'
      }
    });
    
    // Mock the GitHub API for getting file content
    mockOctokit.repos.getContent.mockResolvedValue({
      data: {
        type: 'file',
        content: Buffer.from('# Test File\n\nThis is a test file.').toString('base64'),
        encoding: 'base64'
      }
    });
    
    // Initialize repository
    const repository = await adapter.initialize();
    
    // Read a file
    const testFilePath = 'test-file.md';
    const content = await repository.readFile(testFilePath);
    
    // Verify the content
    expect(content).toBe('# Test File\n\nThis is a test file.');
    
    // Verify that the GitHub API was called to get the file content
    expect(mockOctokit.repos.getContent).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      path: testFilePath,
      ref: 'main'
    });
  });

  it('should list files in the repository', async () => {
    // Mock repository initialization
    mockOctokit.repos.get.mockResolvedValue({
      data: {
        name: 'test-repo',
        owner: { login: 'test-owner' },
        default_branch: 'main'
      }
    });
    
    // Mock the git API for getting the tree
    mockOctokit.git.getTree.mockResolvedValue({
      data: {
        sha: 'tree-sha',
        tree: [
          { path: 'file1.md', type: 'blob', mode: '100644', sha: 'file1-sha' },
          { path: 'file2.md', type: 'blob', mode: '100644', sha: 'file2-sha' },
          { path: 'docs', type: 'tree', mode: '040000', sha: 'docs-sha' },
          { path: 'docs/file3.md', type: 'blob', mode: '100644', sha: 'file3-sha' }
        ]
      }
    });
    
    // Initialize repository
    const repository = await adapter.initialize();
    
    // List files
    const files = await repository.listFiles();
    
    // Verify the files
    expect(files).toHaveLength(3);
    expect(files).toContainEqual({ path: 'file1.md', type: 'file' });
    expect(files).toContainEqual({ path: 'file2.md', type: 'file' });
    expect(files).toContainEqual({ path: 'docs/file3.md', type: 'file' });
    
    // Verify that the GitHub API was called to get the tree
    expect(mockOctokit.git.getTree).toHaveBeenCalledWith({
      owner: 'test-owner',
      repo: 'test-repo',
      tree_sha: 'main',
      recursive: 1
    });
  });

  it('should get the status of the repository', async () => {
    // Mock repository initialization
    mockOctokit.repos.get.mockResolvedValue({
      data: {
        name: 'test-repo',
        owner: { login: 'test-owner' },
        default_branch: 'main'
      }
    });
    
    // Initialize repository
    const repository = await adapter.initialize();
    
    // Stage some files
    repository['stagedFiles'] = [
      { path: 'test-file.md', content: '# Test File', mode: '100644' }
    ];
    
    // Get status
    const status = await repository.getStatus();
    
    // Verify the status
    expect(status.branch).toBe('main');
    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toEqual({
      path: 'test-file.md',
      staged: true,
      modified: true,
      added: true,
      deleted: false
    });
  });
});