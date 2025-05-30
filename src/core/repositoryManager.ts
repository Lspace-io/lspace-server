import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Repository } from './repository';
import { GitHubAdapter } from '../adapters/githubAdapter';

// Define new interfaces for credentials
export interface GitHubPAT {
  alias: string;
  token: string;
}

export interface CredentialsConfig {
  github_pats: GitHubPAT[];
}

export interface RepositoryInfo {
  id: string;
  name: string;
  repository: Repository;
  type: string;
  path?: string; // Local path, optional
  // GitHub specific fields
  owner?: string; // GitHub owner (username or org)
  repo?: string;  // GitHub repository name
  branch?: string; // GitHub branch
  pat_alias?: string; // Alias for the PAT to use
  // Additional metadata as needed
  config: Record<string, any>; // Keeps original config for other types
}

// --- BEGIN UPDATED REPOSITORY CONFIG TYPES ---
interface BaseRepoConfig {
  id: string;
  name: string;
  path_to_kb?: string; // Common optional field for KB path within repo, defaults to '.'
}

export interface LocalRepoConfig extends BaseRepoConfig {
  type: "local";
  path: string; 
}

export interface GitHubRepoConfig extends BaseRepoConfig {
  type: "github";
  owner: string;    
  repo: string;     
  branch: string;   
  pat_alias: string; 
}

export type SavedRepositoryConfig = LocalRepoConfig | GitHubRepoConfig;
// --- END UPDATED REPOSITORY CONFIG TYPES ---

interface FullConfigFormat {
  credentials?: CredentialsConfig; // Optional credentials section
  repositories: SavedRepositoryConfig[];
}

/**
 * RepositoryManager manages multiple git repositories
 * and provides a configuration system for self-hosted deployments
 */
export class RepositoryManager {
  private repositories: Map<string, RepositoryInfo> = new Map();
  private nameToId: Map<string, string> = new Map();
  private idToConfig: Map<string, SavedRepositoryConfig> = new Map();
  private credentialsConfig?: CredentialsConfig;
  private configPath: string; // No longer optional, will be set in constructor or load
  private githubAdapter?: GitHubAdapter; // To be initialized
  private cloneBaseDir: string = path.join(process.cwd(), 'cloned-github-repos'); // Default base for clones
  
  constructor() {
    // Assume config.local.json is always in the current working directory
    // This path will be used by loadConfiguration and saveConfiguration
    this.configPath = path.resolve(process.cwd(), 'config.local.json');
    console.log(`[RepoManager] Default config path set to: ${this.configPath}`);
  }
  
  /**
   * Register a new repository
   * @param name Human-readable name
   * @param repository Repository instance
   * @param type Repository type (local, github, etc.)
   * @param config Full configuration object for this repository from config file
   * @returns Repository ID
   */
  async registerRepository(
    name: string, 
    repository: Repository, 
    type: string, // Keep string here for flexibility from caller, but internal config is stricter
    config: SavedRepositoryConfig // Use THE NEW SavedRepositoryConfig here
  ): Promise<string> {
    const id = config.id || uuidv4();
    
    // Ensure the config has this ID now, for consistency when saving
    // The `type` on `config` will be from the specific variant (LocalRepoConfig or GitHubRepoConfig)
    const finalConfig: SavedRepositoryConfig = { ...config, id, name }; // name from arg, type from config variant

    const repoInfo: RepositoryInfo = {
      id,
      name,
      repository,
      type: config.type, // Use the type from the config variant
      path: config.type === 'local' ? config.path : undefined,
      owner: config.type === 'github' ? config.owner : undefined,
      repo: config.type === 'github' ? config.repo : undefined,
      branch: config.type === 'github' ? config.branch : undefined,
      pat_alias: config.type === 'github' ? config.pat_alias : undefined,
      config: finalConfig 
    };
    this.repositories.set(id, repoInfo);
    this.idToConfig.set(id, finalConfig); // Store the config by ID
    
    // Map the name to the ID for easy lookup
    this.nameToId.set(name, id);
    
    return id;
  }
  
  /**
   * Get a repository by ID
   * @param id Repository ID
   * @returns Repository instance
   */
  getRepository(id: string): Repository {
    const info = this.repositories.get(id);
    if (!info) {
      throw new Error(`Repository not found: ${id}`);
    }
    return info.repository;
  }
  
  /**
   * Get a repository ID by name
   * @param name Repository name
   * @returns Repository ID
   */
  getRepositoryId(name: string): string {
    const id = this.nameToId.get(name);
    if (!id) {
      throw new Error(`Repository not found: ${name}`);
    }
    return id;
  }
  
  /**
   * Get a repository by name
   * @param name Repository name
   * @returns Repository instance or undefined if not found
   */
  getRepositoryByName(name: string): Repository | undefined {
    try {
      const id = this.getRepositoryId(name);
      return this.getRepository(id);
    } catch (error) {
      return undefined;
    }
  }
  
  /**
   * Get repository information
   * @param id Repository ID
   * @returns Repository information
   */
  getRepositoryInfo(id: string): Omit<RepositoryInfo, 'repository'> | undefined {
    const info = this.repositories.get(id);
    if (!info) return undefined;
    
    // Return a copy without the repository instance
    const { repository, ...rest } = info;
    return rest;
  }
  
  /**
   * List all repositories
   * @returns Array of repository info
   */
  listRepositories(): { 
    id: string; 
    name: string; 
    type: string; 
    path_to_kb?: string;
    // Local specific
    path?: string; 
    // GitHub specific
    owner?: string; 
    repo?: string; 
    branch?: string; 
    pat_alias?: string; 
  }[] {
    return Array.from(this.idToConfig.values()).map(conf => {
        const base = {
            id: conf.id,
            name: conf.name,
            type: conf.type,
            path_to_kb: conf.path_to_kb
        };
        if (conf.type === 'local') {
            return { ...base, path: conf.path };
        } else if (conf.type === 'github') {
            return { 
                ...base, 
                owner: conf.owner, 
                repo: conf.repo, 
                branch: conf.branch, 
                pat_alias: conf.pat_alias 
            };
        }
        return base; // Should not happen with a well-typed discriminated union
    });
  }
  
  /**
   * Unregister a repository
   * @param id Repository ID
   */
  unregisterRepository(id: string): void {
    const info = this.repositories.get(id);
    if (!info) {
      throw new Error(`Repository not found: ${id}`);
    }
    
    // Remove from name-to-id map
    this.nameToId.delete(info.name);
    
    // Remove from repositories map
    this.repositories.delete(id);
  }
  
  /**
   * Save repository configuration to a file
   */
  async saveConfiguration(): Promise<void> {
    // No longer needs configPath argument, uses this.configPath set in constructor
    if (!this.configPath) {
      // This case should ideally not be reached if constructor sets it.
      throw new Error("[RepoManager] Config path not set. Critical error.");
    }
    const fullConfig: FullConfigFormat = {
      credentials: this.credentialsConfig, // Include credentials if they exist
      repositories: Array.from(this.idToConfig.values()),
    };
    try {
      await fs.promises.writeFile(this.configPath, JSON.stringify(fullConfig, null, 2));
      console.log(`[RepoManager] Configuration saved to ${this.configPath}`);
    } catch (error: any) {
      console.error(`[RepoManager] Error saving configuration to ${this.configPath}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Load repository configuration from a file
   * @param configPath File path
   */
  async loadConfiguration(): Promise<void> { // Removed configPath argument
    // Uses this.configPath set in constructor
    console.log(`Loading configuration from ${this.configPath}`);
    if (!fs.existsSync(this.configPath)) {
      // If the default config file doesn't exist, we can create a default one or throw.
      // For now, let's throw, assuming a base config should exist or be created by user/setup script.
      console.error(`[RepoManager] Configuration file not found at default location: ${this.configPath}`);
      throw new Error(`Configuration file not found: ${this.configPath}. Please ensure it exists.`);
    }
    
    const configContent = fs.readFileSync(this.configPath, 'utf8');
    const fullConfigData: FullConfigFormat = JSON.parse(configContent);

    if (fullConfigData.credentials) {
      this.credentialsConfig = fullConfigData.credentials;
      console.log(`[RepoManager] Loaded ${this.credentialsConfig.github_pats?.length || 0} GitHub PATs.`);
    }

    this.repositories.clear();
    this.nameToId.clear();
    this.idToConfig.clear(); 
    
    // Initialize GitHubAdapter if there are PATs or if it's simply needed
    // It can be initialized even without PATs, it just won't be able to auth for private repos then.
    this.githubAdapter = new GitHubAdapter(this.cloneBaseDir); 
    console.log(`[RepoManager] GitHubAdapter initialized to use clone base directory: ${this.cloneBaseDir}`);

    for (const repoConfig of fullConfigData.repositories) {
      try {
        await this.setupRepositoryFromConfig(repoConfig); 
      } catch (error: any) {
        console.error(`[RepoManager] Error setting up repository ${repoConfig.name} (ID: ${repoConfig.id || 'N/A'}) from config: ${error.message}`);
      }
    }
    console.log('[RepoManager] Configuration loaded successfully.');
  }

  private async setupRepositoryFromConfig(repoConfig: SavedRepositoryConfig): Promise<void> {
    let repoInstance: Repository;

    if (!repoConfig.name || !repoConfig.type) {
        console.warn(`[RepoManager] Skipping repository config due to missing name or type:`, repoConfig);
        return;
    }

    if (repoConfig.type === 'github') {
      if (!this.githubAdapter) {
        throw new Error('GitHubAdapter not initialized. Cannot setup GitHub repository.');
      }
      // Now owner, repo, branch, pat_alias are guaranteed by GitHubRepoConfig type
      const pat = this.getPATByAlias(repoConfig.pat_alias);
      if (!pat) {
        throw new Error(`PAT alias "${repoConfig.pat_alias}" not found for GitHub repo ${repoConfig.name}.`);
      }
      
      console.log(`[RepoManager] Initializing GitHub repository ${repoConfig.owner}/${repoConfig.repo} using GitHubAdapter...`);
      repoInstance = await this.githubAdapter.initialize(repoConfig, pat);
      console.log(`[RepoManager] GitHub repository ${repoConfig.name} initialized. Path: ${repoInstance.path}`);
    } else if (repoConfig.type === 'local') {
      // path is guaranteed by LocalRepoConfig type
      const localRepoPath = path.resolve(repoConfig.path); 
      repoInstance = new Repository(localRepoPath);
    } else {
      // This case should ideally be impossible if SavedRepositoryConfig is correctly a discriminated union
      // and a `never` type assertion could be used for exhaustive checks.
      const _exhaustiveCheck: never = repoConfig; // This will error if not all types are handled
      throw new Error(`Unsupported repository type: ${(_exhaustiveCheck as any).type} for repository ${(_exhaustiveCheck as any).name}`);
    }

    await this.registerRepository(repoConfig.name, repoInstance, repoConfig.type, repoConfig);
    console.log(`[RepoManager] Registered repository: "${repoConfig.name}" (ID: ${repoConfig.id || this.nameToId.get(repoConfig.name)}, Type: ${repoConfig.type})`);
  }

  public async addNewRepositoryConfig(repoConfigData: Omit<LocalRepoConfig, 'id'> | Omit<GitHubRepoConfig, 'id'>): Promise<string> {
    const id = uuidv4(); // Always generate a new ID for new configs
    
    const fullRepoConfig: SavedRepositoryConfig = { ...repoConfigData, id } as SavedRepositoryConfig;
    // The above cast `as SavedRepositoryConfig` is needed because TS can't infer the discriminated union type correctly 
    // from `Omit<..., 'id'> & {id: string}` when `repoConfigData` itself is a union of Omits.
    // We rely on the input `repoConfigData` being one of the valid structures (LocalRepoConfig sans id, or GitHubRepoConfig sans id).

    if (this.idToConfig.has(id)) {
      // Should be rare with uuidv4 but good to check.
      throw new Error(`Repository with generated ID ${id} already exists.`);
    }
    if (this.nameToId.has(fullRepoConfig.name)) {
      throw new Error(`Repository with name "${fullRepoConfig.name}" already exists.`);
    }

    if (fullRepoConfig.type === 'github') {
      // Fields owner, repo, branch, pat_alias are guaranteed by GitHubRepoConfig type if type is 'github'
      if (!this.getPATByAlias(fullRepoConfig.pat_alias)) {
        throw new Error(`PAT alias "${fullRepoConfig.pat_alias}" not found in credentials.`);
      }
    } else if (fullRepoConfig.type === 'local') {
      // Field path is guaranteed if type is 'local'
      if (!fullRepoConfig.path) { // Should be caught by type system, but defense in depth
          throw new Error('Local repository config requires a path.');
      }
    }

    // Add to in-memory config map first
    this.idToConfig.set(id, fullRepoConfig);
    // this.nameToId will be updated by setupRepositoryFromConfig via registerRepository

    try {
      // Persist the configuration change BEFORE attempting to set up (clone/register)
      await this.saveConfiguration();
      
      // Now set up the repository (clone if needed, create Repository instance, register)
      await this.setupRepositoryFromConfig(fullRepoConfig);
      return id;
    } catch (error) {
      // If setup fails, we should ideally roll back the config change
      this.idToConfig.delete(id);
      // Also remove from nameToId if it was added by a partial registerRepository call (though setupRepositoryFromConfig calls registerRepository at the end)
      // This rollback is tricky if saveConfiguration succeeded but setup failed.
      // For now, log and rethrow. A more robust solution might involve a temp config state.
      console.error(`[RepoManager] Error during addNewRepositoryConfig for "${fullRepoConfig.name}". Attempting to roll back config addition. Error:`, error);
      await this.saveConfiguration(); // Attempt to save the rolled-back state
      throw error; // Rethrow the original error
    }
  }

  public getAllRepositoryConfigs(): SavedRepositoryConfig[] {
    return Array.from(this.idToConfig.values());
  }

  // Method to remove a repository configuration
  public async removeRepositoryConfig(idOrName: string): Promise<void> {
    let repoIdToRemove: string | undefined;
    let repoNameToRemove: string | undefined;

    if (this.idToConfig.has(idOrName)) {
      repoIdToRemove = idOrName;
      repoNameToRemove = this.idToConfig.get(idOrName)!.name;
    } else if (this.nameToId.has(idOrName)) {
      repoIdToRemove = this.nameToId.get(idOrName)!;
      repoNameToRemove = idOrName;
    } else {
      throw new Error(`Repository with name or ID "${idOrName}" not found.`);
    }

    if (!repoIdToRemove || !repoNameToRemove) { // Should be set if found
        throw new Error(`Internal error: Could not determine ID and Name for repository "${idOrName}".`);
    }

    // Remove from runtime maps
    this.repositories.delete(repoIdToRemove);
    this.nameToId.delete(repoNameToRemove);
    this.idToConfig.delete(repoIdToRemove);

    console.log(`[RepoManager] Removed repository "${repoNameToRemove}" (ID: ${repoIdToRemove}) from runtime.`);

    // Persist the change
    await this.saveConfiguration();
    console.log(`[RepoManager] Repository "${repoNameToRemove}" removed from configuration file.`);
    // Note: This does not delete the cloned repository from disk.
    // That could be an optional additional step if desired.
  }

  // Find a repository configuration by its name
  async findRepositoryConfigByName(name: string): Promise<SavedRepositoryConfig | null> {
    const id = this.nameToId.get(name);
    if (id) {
      const config = this.idToConfig.get(id);
      return config || null;
    }
    return null;
  }

  // Method to get credentials if needed by other services
  getCredentials(): CredentialsConfig | undefined {
    return this.credentialsConfig;
  }

  getPATByAlias(alias: string): string | undefined {
    if (!this.credentialsConfig || !this.credentialsConfig.github_pats) {
      return undefined;
    }
    const patEntry = this.credentialsConfig.github_pats.find(p => p.alias === alias);
    return patEntry ? patEntry.token : undefined;
  }

  // Method to set the clone base directory, e.g., from app config
  public setCloneBaseDirectory(baseDir: string): void {
    this.cloneBaseDir = path.resolve(baseDir);
    console.log(`[RepoManager] Set clone base directory to: ${this.cloneBaseDir}`);
  }

  // Method to push changes to GitHub repositories
  public async pushToRemote(repositoryId: string): Promise<void> {
    const repoConfig = this.idToConfig.get(repositoryId);
    if (!repoConfig) {
      throw new Error(`Repository with ID ${repositoryId} not found.`);
    }

    if (repoConfig.type !== 'github') {
      console.log(`[RepoManager] Repository ${repoConfig.name} is not a GitHub repository. Skipping push.`);
      return;
    }

    if (!this.githubAdapter) {
      throw new Error('GitHubAdapter not initialized. Cannot push to GitHub repository.');
    }

    const pat = this.getPATByAlias(repoConfig.pat_alias);
    if (!pat) {
      throw new Error(`PAT alias "${repoConfig.pat_alias}" not found for GitHub repo ${repoConfig.name}.`);
    }

    try {
      await this.githubAdapter.push(repoConfig, pat);
    } catch (error: any) {
      console.error(`[RepoManager] Failed to push repository ${repoConfig.name}:`, error.message);
      throw error;
    }
  }

  // Method to sync GitHub repositories with remote
  public async syncWithRemote(repositoryId: string): Promise<void> {
    const repoConfig = this.idToConfig.get(repositoryId);
    if (!repoConfig) {
      throw new Error(`Repository with ID ${repositoryId} not found.`);
    }

    if (repoConfig.type !== 'github') {
      console.log(`[RepoManager] Repository ${repoConfig.name} is not a GitHub repository. Skipping sync.`);
      return;
    }

    if (!this.githubAdapter) {
      throw new Error('GitHubAdapter not initialized. Cannot sync GitHub repository.');
    }

    const pat = this.getPATByAlias(repoConfig.pat_alias);
    if (!pat) {
      throw new Error(`PAT alias "${repoConfig.pat_alias}" not found for GitHub repo ${repoConfig.name}.`);
    }

    try {
      await this.githubAdapter.sync(repoConfig, pat);
    } catch (error: any) {
      console.error(`[RepoManager] Failed to sync repository ${repoConfig.name}:`, error.message);
      throw error;
    }
  }
}