import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// These imports will fail until we implement the adapter
import { LocalGitAdapter } from '../../src/adapters/localGitAdapter';
import { Repository } from '../../src/core/repository';

// Get the current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to test repository
const TEST_REPO_PATH = path.join(__dirname, '..', '..', 'test-repos', 'sample-repo');

describe('LocalGitAdapter', () => {
  beforeEach(() => {
    // Ensure test repository exists and is clean
    if (!fs.existsSync(TEST_REPO_PATH)) {
      fs.mkdirSync(TEST_REPO_PATH, { recursive: true });
    }
    
    // Clean up any existing git directory
    const gitDir = path.join(TEST_REPO_PATH, '.git');
    if (fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up any test files but keep the repository
    const filesToDelete = fs.readdirSync(TEST_REPO_PATH)
      .filter(file => file !== '.git');
    
    for (const file of filesToDelete) {
      const filePath = path.join(TEST_REPO_PATH, file);
      if (fs.lstatSync(filePath).isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
    }
  });

  it('should initialize a repository', async () => {
    // This test should pass when we implement the adapter
    const adapter = new LocalGitAdapter();
    const repository = await adapter.initialize(TEST_REPO_PATH);
    
    expect(repository).toBeInstanceOf(Repository);
    expect(repository.path).toBe(TEST_REPO_PATH);
    expect(fs.existsSync(path.join(TEST_REPO_PATH, '.git'))).toBe(true);
  });

  it('should add a file to the repository', async () => {
    const adapter = new LocalGitAdapter();
    const repository = await adapter.initialize(TEST_REPO_PATH);
    
    const testFilePath = 'test-file.md';
    const testFileContent = '# Test File\n\nThis is a test file.';
    
    await repository.writeFile(testFilePath, testFileContent);
    
    // Check that the file was created
    const fullPath = path.join(TEST_REPO_PATH, testFilePath);
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.readFileSync(fullPath, 'utf8')).toBe(testFileContent);
  });

  it('should commit changes to the repository', async () => {
    const adapter = new LocalGitAdapter();
    const repository = await adapter.initialize(TEST_REPO_PATH);
    
    const testFilePath = 'test-file.md';
    const testFileContent = '# Test File\n\nThis is a test file.';
    
    await repository.writeFile(testFilePath, testFileContent);
    const commitResult = await repository.commit('Add test file');
    
    expect(commitResult.success).toBe(true);
    expect(commitResult.hash).toBeTruthy();
    
    // Check that the file is now tracked by git
    const status = await repository.getStatus();
    expect(status.files.find(f => f.path === testFilePath)?.staged).toBe(true);
  });

  it('should read a file from the repository', async () => {
    const adapter = new LocalGitAdapter();
    const repository = await adapter.initialize(TEST_REPO_PATH);
    
    const testFilePath = 'test-file.md';
    const testFileContent = '# Test File\n\nThis is a test file.';
    
    await repository.writeFile(testFilePath, testFileContent);
    await repository.commit('Add test file');
    
    const content = await repository.readFile(testFilePath);
    expect(content).toBe(testFileContent);
  });

  it('should list files in the repository', async () => {
    const adapter = new LocalGitAdapter();
    const repository = await adapter.initialize(TEST_REPO_PATH);
    
    const testFiles = [
      { path: 'file1.md', content: '# File 1' },
      { path: 'file2.md', content: '# File 2' },
      { path: 'docs/file3.md', content: '# File 3' }
    ];
    
    // Create the docs directory
    fs.mkdirSync(path.join(TEST_REPO_PATH, 'docs'), { recursive: true });
    
    // Write files
    for (const file of testFiles) {
      await repository.writeFile(file.path, file.content);
    }
    
    await repository.commit('Add test files');
    
    const files = await repository.listFiles();
    
    expect(files).toHaveLength(3);
    expect(files).toContainEqual(expect.objectContaining({ path: 'file1.md' }));
    expect(files).toContainEqual(expect.objectContaining({ path: 'file2.md' }));
    expect(files).toContainEqual(expect.objectContaining({ path: 'docs/file3.md' }));
  });
});