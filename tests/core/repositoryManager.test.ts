import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// These imports will fail until we implement the manager
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

describe('RepositoryManager', () => {
  beforeEach(() => {
    // Ensure test repositories directory exists
    if (!fs.existsSync(TEST_REPOS_DIR)) {
      fs.mkdirSync(TEST_REPOS_DIR, { recursive: true });
    }
    
    // Create test repositories directories
    [REPO1_PATH, REPO2_PATH].forEach(repoPath => {
      if (!fs.existsSync(repoPath)) {
        fs.mkdirSync(repoPath, { recursive: true });
      }
    });
  });

  afterEach(() => {
    // Clean up test repositories
    [REPO1_PATH, REPO2_PATH].forEach(repoPath => {
      if (fs.existsSync(repoPath)) {
        fs.rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  it('should register a repository', async () => {
    const manager = new RepositoryManager();
    const adapter = new LocalGitAdapter();
    
    const repository = await adapter.initialize(REPO1_PATH);
    const repoId = await manager.registerRepository('repo1', repository);
    
    expect(repoId).toBeDefined();
    expect(manager.getRepository(repoId)).toBe(repository);
    expect(manager.getRepositoryId('repo1')).toBe(repoId);
  });

  it('should manage multiple repositories', async () => {
    const manager = new RepositoryManager();
    const adapter = new LocalGitAdapter();
    
    const repo1 = await adapter.initialize(REPO1_PATH);
    const repo2 = await adapter.initialize(REPO2_PATH);
    
    const repo1Id = await manager.registerRepository('repo1', repo1);
    const repo2Id = await manager.registerRepository('repo2', repo2);
    
    expect(repo1Id).not.toBe(repo2Id);
    
    // Get repositories by ID
    expect(manager.getRepository(repo1Id)).toBe(repo1);
    expect(manager.getRepository(repo2Id)).toBe(repo2);
    
    // Get repositories by name
    expect(manager.getRepositoryByName('repo1')).toBe(repo1);
    expect(manager.getRepositoryByName('repo2')).toBe(repo2);
    
    // List all repositories
    const repos = manager.listRepositories();
    expect(repos).toHaveLength(2);
    expect(repos).toContainEqual(expect.objectContaining({ id: repo1Id, name: 'repo1' }));
    expect(repos).toContainEqual(expect.objectContaining({ id: repo2Id, name: 'repo2' }));
  });

  it('should unregister a repository', async () => {
    const manager = new RepositoryManager();
    const adapter = new LocalGitAdapter();
    
    const repository = await adapter.initialize(REPO1_PATH);
    const repoId = await manager.registerRepository('repo1', repository);
    
    expect(manager.getRepository(repoId)).toBe(repository);
    
    manager.unregisterRepository(repoId);
    
    expect(() => manager.getRepository(repoId)).toThrow();
    expect(manager.getRepositoryByName('repo1')).toBeUndefined();
    expect(manager.listRepositories()).toHaveLength(0);
  });

  it('should persist repository configuration', async () => {
    const manager = new RepositoryManager();
    const adapter = new LocalGitAdapter();
    
    const repo1 = await adapter.initialize(REPO1_PATH);
    const repo2 = await adapter.initialize(REPO2_PATH);
    
    await manager.registerRepository('repo1', repo1);
    await manager.registerRepository('repo2', repo2);
    
    // Save configuration
    const configPath = path.join(TEST_REPOS_DIR, 'config.json');
    await manager.saveConfiguration(configPath);
    
    // Create a new manager and load configuration
    const newManager = new RepositoryManager();
    await newManager.loadConfiguration(configPath);
    
    // Check that repositories were loaded
    expect(newManager.listRepositories()).toHaveLength(2);
    expect(newManager.getRepositoryByName('repo1')).toBeDefined();
    expect(newManager.getRepositoryByName('repo2')).toBeDefined();
    
    // Clean up
    fs.unlinkSync(configPath);
  });
});