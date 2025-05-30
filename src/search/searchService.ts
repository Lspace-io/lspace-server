import { RepositoryManager } from '../core/repositoryManager';
import { Repository } from '../core/repository';
import path from 'path';
import fs from 'fs';

interface SearchResult {
  repositoryId: string;
  path: string;
  title?: string;
  excerpt?: string;
  score: number;
  lastModified?: Date;
}

interface SearchOptions {
  repositoryId?: string;
  limit?: number;
  offset?: number;
}

/**
 * SearchService provides functionality for searching across repositories
 */
export class SearchService {
  private repositoryManager: RepositoryManager;
  private indexCache: Map<string, IndexEntry[]> = new Map();
  
  constructor(repositoryManager: RepositoryManager) {
    this.repositoryManager = repositoryManager;
  }
  
  /**
   * Initialize the search index for all repositories
   */
  async initializeIndex(): Promise<void> {
    const repositories = this.repositoryManager.listRepositories();
    
    for (const repo of repositories) {
      await this.updateIndex(repo.id);
    }
  }
  
  /**
   * Update the search index for a specific repository
   * @param repositoryId Repository ID
   */
  async updateIndex(repositoryId: string): Promise<void> {
    const repository = this.repositoryManager.getRepository(repositoryId);
    
    // Get all files in the repository
    const files = await repository.listFiles();
    
    // Clear existing index for this repository
    this.indexCache.delete(repositoryId);
    
    // Only index markdown and text files
    const indexableFiles = files.filter(file => 
      file.type === 'file' && 
      (file.path.endsWith('.md') || 
       file.path.endsWith('.txt') ||
       file.path.endsWith('.json'))
    );
    
    // Build index entries
    const indexEntries: IndexEntry[] = [];
    
    for (const file of indexableFiles) {
      try {
        const content = await repository.readFile(file.path);
        
        // Extract title (first heading for markdown)
        let title = path.basename(file.path);
        if (file.path.endsWith('.md')) {
          const headingMatch = content.match(/^#\s+(.+)$/m);
          if (headingMatch && headingMatch[1]) {
            title = headingMatch[1].trim();
          }
        }
        
        // Create index entry
        const entry: IndexEntry = {
          path: file.path,
          title,
          content,
          lastModified: file.lastModified
        };
        
        indexEntries.push(entry);
      } catch (error) {
        // Skip files that can't be read
        console.warn(`Error indexing file ${file.path}: ${error}`);
      }
    }
    
    // Store the index
    this.indexCache.set(repositoryId, indexEntries);
  }
  
  /**
   * Perform a keyword search across all repositories
   * @param query Search query
   * @param options Search options
   * @returns Search results
   */
  async keywordSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    // Normalize query
    const normalizedQuery = query.toLowerCase().trim();
    const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
    
    if (queryTerms.length === 0) {
      return [];
    }
    
    // Get repositories to search
    const repoIds = options.repositoryId 
      ? [options.repositoryId] 
      : this.repositoryManager.listRepositories().map(r => r.id);
    
    const results: SearchResult[] = [];
    
    // Search each repository
    for (const repoId of repoIds) {
      // Get index entries for this repository
      let entries = this.indexCache.get(repoId);
      
      // If no entries cached, update the index
      if (!entries || entries.length === 0) {
        await this.updateIndex(repoId);
        entries = this.indexCache.get(repoId) || [];
      }
      
      // Search the entries
      for (const entry of entries) {
        const score = this.calculateScore(entry, queryTerms);
        
        if (score > 0) {
          // Create excerpt
          const excerpt = this.createExcerpt(entry.content, queryTerms[0]);
          
          results.push({
            repositoryId: repoId,
            path: entry.path,
            title: entry.title,
            excerpt,
            score,
            lastModified: entry.lastModified
          });
        }
      }
    }
    
    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    
    // Apply limit and offset
    const offset = options.offset || 0;
    const limit = options.limit || results.length;
    
    return results.slice(offset, offset + limit);
  }
  
  /**
   * Find files related to a given file
   * @param repositoryId Repository ID
   * @param filePath File path
   * @param limit Maximum number of results
   * @returns Related files
   */
  async findRelatedFiles(
    repositoryId: string, 
    filePath: string, 
    limit: number = 5
  ): Promise<SearchResult[]> {
    try {
      // Get the repository
      const repository = this.repositoryManager.getRepository(repositoryId);
      
      // Get the content of the file
      const content = await repository.readFile(filePath);
      
      // Extract keywords from content
      const keywords = this.extractKeywords(content);
      
      // Perform a search with these keywords
      const results = await this.keywordSearch(keywords.join(' '), {
        limit: limit + 1 // +1 because the file itself will be in the results
      });
      
      // Filter out the original file
      return results.filter(result => 
        !(result.repositoryId === repositoryId && result.path === filePath)
      );
    } catch (error) {
      console.error(`Error finding related files: ${error}`);
      return [];
    }
  }
  
  /**
   * Calculate a relevance score for an entry against query terms
   * @param entry Index entry
   * @param queryTerms Query terms
   * @returns Score (0 if no match)
   */
  private calculateScore(entry: IndexEntry, queryTerms: string[]): number {
    const content = entry.content.toLowerCase();
    const title = entry.title.toLowerCase();
    
    let score = 0;
    
    // Check each query term
    for (const term of queryTerms) {
      // Title matches are worth more
      if (title.includes(term)) {
        score += 10;
      }
      
      // Content matches
      if (content.includes(term)) {
        // Count occurrences
        const occurrences = (content.match(new RegExp(term, 'g')) || []).length;
        score += occurrences;
      }
    }
    
    return score;
  }
  
  /**
   * Create a text excerpt highlighting the query match
   * @param content Full content
   * @param query Query term to highlight
   * @returns Excerpt with match context
   */
  private createExcerpt(content: string, query: string): string {
    const lowerContent = content.toLowerCase();
    const index = lowerContent.indexOf(query);
    
    if (index === -1) {
      // Just return the beginning of the content
      return content.substring(0, 100) + '...';
    }
    
    // Get context around the match
    const start = Math.max(0, index - 40);
    const end = Math.min(content.length, index + query.length + 40);
    
    return (start > 0 ? '...' : '') + 
           content.substring(start, end) + 
           (end < content.length ? '...' : '');
  }
  
  /**
   * Extract significant keywords from content
   * @param content Content to analyze
   * @returns Array of keywords
   */
  private extractKeywords(content: string): string[] {
    // Split content into words
    const words = content.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    
    // Count word frequencies
    const wordCounts = new Map<string, number>();
    for (const word of words) {
      // Skip stop words
      if (this.isStopWord(word)) continue;
      
      // Skip short words
      if (word.length < 3) continue;
      
      // Count word
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
    
    // Convert to array and sort by frequency
    const sortedWords = [...wordCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word);
    
    // Return top keywords (up to 10)
    return sortedWords.slice(0, 10);
  }
  
  /**
   * Check if a word is a common stop word
   * @param word Word to check
   * @returns True if it's a stop word
   */
  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
      'at', 'from', 'by', 'on', 'off', 'for', 'in', 'out', 'over', 'to',
      'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should',
      'can', 'could', 'may', 'might', 'must', 'this', 'that', 'these', 'those',
      'i', 'you', 'he', 'she', 'it', 'we', 'they'
    ]);
    
    return stopWords.has(word);
  }
}

/**
 * Index entry for a document
 */
interface IndexEntry {
  path: string;
  title: string;
  content: string;
  lastModified?: Date;
}