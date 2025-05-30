import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Repository } from '../core/repository';
import { SavedRepositoryConfig } from '../core/repositoryManager';

export class GitHubAdapter {
  private baseClonePath: string;

  constructor(baseClonePath: string = '.lspace_clones') {
    this.baseClonePath = path.resolve(process.cwd(), baseClonePath);
    if (!fs.existsSync(this.baseClonePath)) {
      fs.mkdirSync(this.baseClonePath, { recursive: true });
    }
  }

  private getLocalPath(owner: string, repo: string): string {
    return path.join(this.baseClonePath, owner, repo);
  }

  async initialize(repoConfig: SavedRepositoryConfig, pat: string): Promise<Repository> {
    if (repoConfig.type !== 'github' || !repoConfig.owner || !repoConfig.repo) {
      throw new Error('Invalid repository configuration for GitHubAdapter. Missing owner or repo.');
    }

    const localPath = this.getLocalPath(repoConfig.owner, repoConfig.repo);
    const authenticatedUrl = `https://x-access-token:${pat}@github.com/${repoConfig.owner}/${repoConfig.repo}.git`;
    const cloneTargetParentDir = path.dirname(localPath);

    try {
      if (fs.existsSync(path.join(localPath, '.git'))) {
        console.log(`GitHubAdapter: Repository ${repoConfig.owner}/${repoConfig.repo} already cloned at ${localPath}. Configuring remote and fetching latest changes...`);
        execSync(`git -C "${localPath}" remote set-url origin "${authenticatedUrl}"`, { stdio: 'pipe' });
        execSync(`git -C "${localPath}" fetch origin ${repoConfig.branch || 'main'} --depth=1 --tags`, { stdio: 'pipe' });
        execSync(`git -C "${localPath}" checkout ${repoConfig.branch || 'main'} --force`, { stdio: 'pipe' });
        console.log(`GitHubAdapter: Fetched and checked out ${repoConfig.branch || 'main'} for ${repoConfig.owner}/${repoConfig.repo}.`);
      } else {
        console.log(`GitHubAdapter: Cloning repository ${repoConfig.owner}/${repoConfig.repo} to ${localPath}...`);
        if (!fs.existsSync(cloneTargetParentDir)) {
          fs.mkdirSync(cloneTargetParentDir, { recursive: true });
        }
        execSync(`git clone --branch ${repoConfig.branch || 'main'} --depth 1 "${authenticatedUrl}" "${localPath}"`, { stdio: 'pipe' });
        console.log(`GitHubAdapter: Cloned ${repoConfig.owner}/${repoConfig.repo} successfully.`);
      }
      return new Repository(localPath);
    } catch (error: any) {
      console.error(`GitHubAdapter: Failed to initialize repository ${repoConfig.owner}/${repoConfig.repo}: ${error.message}`);
      if (error.stderr) {
        console.error(`GitHubAdapter: Git stderr: ${error.stderr.toString()}`);
      }
      if (error.stdout) {
        console.error(`GitHubAdapter: Git stdout: ${error.stdout.toString()}`);
      }
      throw error;
    }
  }

  async push(repoConfig: SavedRepositoryConfig, pat: string): Promise<void> {
    if (repoConfig.type !== 'github' || !repoConfig.owner || !repoConfig.repo) {
      throw new Error(`Cannot push non-GitHub repository: ${repoConfig.name}. Missing owner or repo.`);
    }
    
    const localPath = this.getLocalPath(repoConfig.owner, repoConfig.repo);
    const authenticatedUrl = `https://x-access-token:${pat}@github.com/${repoConfig.owner}/${repoConfig.repo}.git`;
    const branchToPush = repoConfig.branch || 'main'; // Default to main if not specified

    try {
      console.log(`GitHubAdapter: Pushing changes in ${localPath} to ${repoConfig.owner}/${repoConfig.repo} branch ${branchToPush} using Git CLI...`);
      
      // Standard push. Add --force or --force-with-lease if needed based on desired behavior.
      execSync(`git -C "${localPath}" push "${authenticatedUrl}" ${branchToPush}`, { stdio: 'pipe' });
      
      console.log(`GitHubAdapter: Successfully pushed to ${repoConfig.owner}/${repoConfig.repo} branch ${branchToPush}.`);
    } catch (error: any) {
      console.error(`GitHubAdapter: Failed to push to ${repoConfig.owner}/${repoConfig.repo} branch ${branchToPush}: ${error.message}`);
      if (error.stderr) {
        console.error(`GitHubAdapter: Git stderr: ${error.stderr.toString()}`);
      }
      if (error.stdout) {
        console.error(`GitHubAdapter: Git stdout: ${error.stdout.toString()}`);
      }
      // Consider specific error handling here if a force push fallback is still desired for certain errors.
      throw error;
    }
  }

  async sync(repoConfig: SavedRepositoryConfig, pat: string): Promise<void> {
    if (repoConfig.type !== 'github' || !repoConfig.owner || !repoConfig.repo) {
      console.log(`GitHubAdapter: Repository ${repoConfig.name} is not a GitHub repository or is missing owner/repo. Skipping sync.`);
      return;
    }
    
    const localPath = this.getLocalPath(repoConfig.owner, repoConfig.repo);
    const authenticatedUrl = `https://x-access-token:${pat}@github.com/${repoConfig.owner}/${repoConfig.repo}.git`;
    const branchToSync = repoConfig.branch || 'main';
    
    try {
      console.log(`GitHubAdapter: Syncing ${localPath} with ${repoConfig.owner}/${repoConfig.repo} branch ${branchToSync} using Git CLI...`);
      
      if (!fs.existsSync(path.join(localPath, '.git'))) {
        console.log(`GitHubAdapter: Local repository not found at ${localPath}. Cannot sync. Consider initializing first.`);
        // Optionally, call initialize or throw an error
        return;
      }
      
      execSync(`git -C "${localPath}" remote set-url origin "${authenticatedUrl}"`, { stdio: 'pipe' });
      execSync(`git -C "${localPath}" fetch origin ${branchToSync} --depth=1 --tags`, { stdio: 'pipe' });
      execSync(`git -C "${localPath}" checkout ${branchToSync} --force`, { stdio: 'pipe' });
      // execSync(`git -C "${localPath}" reset --hard origin/${branchToSync}`, { stdio: 'pipe' }); // Alternative to ensure it matches remote head
      
      console.log(`GitHubAdapter: Successfully synced ${repoConfig.owner}/${repoConfig.repo} to latest ${branchToSync}.`);
    } catch (error: any) {
      console.error(`GitHubAdapter: Failed to sync ${repoConfig.owner}/${repoConfig.repo} branch ${branchToSync}: ${error.message}`);
      if (error.stderr) {
        console.error(`GitHubAdapter: Git stderr: ${error.stderr.toString()}`);
      }
      if (error.stdout) {
        console.error(`GitHubAdapter: Git stdout: ${error.stdout.toString()}`);
      }
      throw error;
    }
  }
} 