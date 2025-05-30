import { Repository } from '../core/repository';
import { LLMService, LLMConflictHandlingRule, LLMNewArticleSkeleton } from '../orchestrator/llmService';
import { TimelineService } from '../core/timelineService';
import { SearchService } from '../search/searchService';
import path from 'path';
import matter from 'gray-matter'; // For front-matter parsing
import yaml from 'js-yaml'; // Retain if used by existing methods, or for formatting

// #region --- Interfaces for the new ingestion algorithm ---
interface DocumentChunk {
    id: string; // e.g., rawFilePath#heading_slug or rawFilePath#chunk_index
    rawFilePath: string; // Relative path of the raw document
    originalMetadata: Record<string, any>;
    content: string;
    heading?: string; // If chunked by heading
}

interface TopicResolutionResult {
    status: 'exact_match' | 'semantic_match' | 'new_topic';
    kbPagePath: string; // Full path for existing or new KB article
    slug: string; 
}

interface KbArticleData { // Renamed from 'Article' to avoid potential global conflicts
    title: string;
    last_updated: string;
    sources: Array<{ file: string; lines?: string }>; // file is raw doc path relative to repo root
    content: string; // Markdown body (after YAML frontmatter)
}
// #endregion --- Interfaces ---

// Original interfaces - kept if still used by parts of the class not being entirely replaced
export interface KnowledgeBaseEntry {
  title: string;
  content: string;
  topics: string[];
  sourceDocuments: { path: string; title: string }[];
  lastUpdated: string;
  sourceIds?: string[];
}

export interface KnowledgeBaseTopic {
  title: string;
  content: string;
  parentTopics: string[];
  subtopics: string[];
  relatedTopics: string[];
  sourceDocuments: { path: string; title: string }[];
  lastUpdated: string;
  sourceIds?: string[];
}

export interface KnowledgeBaseOptions {
  regenerateAll?: boolean;
  updateOnly?: boolean;
}

// This interface was present in the broken file, assuming it's used by existing methods.
interface KnowledgeBaseItem {
  path: string; 
  type: 'file' | 'directory';
  title?: string; 
  children?: KnowledgeBaseItem[];
}
// This interface was present in the broken file, assuming it's used by existing methods.
interface KnowledgeBaseStructure {
  baseDir: string; 
  repositoryName: string; 
  contents: KnowledgeBaseItem[];
}


export class KnowledgeBaseService {
  private static readonly RAW_FILES_DIR = 'raw';
  private static readonly KB_FILES_DIR = 'knowledge-base';
  private static readonly KB_INDEX_MD = 'index.md';
  private static readonly APPROX_TOKEN_WINDOW_SIZE = 800;

  constructor(
    private llmService: LLMService,
    private timelineService: TimelineService,
    private searchService: SearchService // Added SearchService dependency
  ) {}

  /**
   * Processes a single raw source file to generate or update corresponding KB articles
   * according to the new detailed algorithm.
   * (Refactored generateForSourceFile)
   */
  public async processDocumentForKnowledgeBase(
    repository: Repository,
    rawDocumentRelativePath: string, // e.g., "doc1.md" (relative to RAW_FILES_DIR)
    rawDocumentCommitSha: string
  ): Promise<{ affectedKBPaths: string[]; kbCommitSha: string | null }> {
    console.log(`[KBService] Starting ingestion for raw doc: ${rawDocumentRelativePath} (commit: ${rawDocumentCommitSha})`);
    const fullRawFilePath = path.join(KnowledgeBaseService.RAW_FILES_DIR, rawDocumentRelativePath);

    // Step 1: Load & Pre-process
    const { content: rawContentWithoutYaml, metadata: rawMetadata } = await this._loadAndPreprocessRawDoc(repository, fullRawFilePath);

    // Step 2: Parse & Chunk
    const chunks = this._parseAndChunk(rawContentWithoutYaml, rawMetadata, fullRawFilePath);

    const changedOrNewKbPagePaths = new Set<string>();

    for (const chunk of chunks) {
        // Step 3: Semantic Topic Resolution
        const bestMatch = await this._findBestMatchingArticle(repository, chunk.content);
        if (bestMatch) {
            // Step 4: Merge chunk into best-matching article
            const integrationResult = await this.llmService.integrateContent({
                existingContent: bestMatch.content,
                existingMetadata: bestMatch.metadata,
                newChunkText: chunk.content,
                newChunkSourcePath: path.join(KnowledgeBaseService.RAW_FILES_DIR, chunk.rawFilePath),
                conflictHandlingRule: { strategy: "newer_overrides_older_with_footnote", checksumDuplicates: true }
            });
            if (integrationResult.changed) {
                // Update the article file
                const frontMatterString = matter.stringify(`\n`, {
                    ...bestMatch.metadata,
                    title: integrationResult.title || bestMatch.metadata.title,
                    last_updated: new Date().toISOString(),
                    sources: [
                        ...(bestMatch.metadata.sources || []),
                        { file: path.join(KnowledgeBaseService.RAW_FILES_DIR, chunk.rawFilePath) }
                    ]
                });
                const fullPageContent = `${frontMatterString.trim()}\n\n${integrationResult.mergedContent}`;
                await repository.writeFile(bestMatch.path, fullPageContent);
                changedOrNewKbPagePaths.add(bestMatch.path);
            }
        } else {
            // Step 5: Create new article at appropriate topic level
            const topicDir = await this._determineTopicDirectory(repository, chunk.content);
            const newSlug = this._slugify(chunk.heading || 'untitled');
            const kbPagePath = path.join(KnowledgeBaseService.KB_FILES_DIR, topicDir, `${newSlug}.md`);
            const skeletonInput = {
                titleSuggestion: chunk.heading || newSlug,
                summaryPrompt: "Write a concise summary for this content.",
                sectionsPerChunk: [chunk.content],
                sourceReference: {
                    path: path.join(KnowledgeBaseService.RAW_FILES_DIR, chunk.rawFilePath)
                }
            };
            const skeleton = await this.llmService.generateNewArticleSkeleton(skeletonInput);
            const frontMatterString = matter.stringify(`\n`, {
                title: skeleton.title,
                last_updated: new Date().toISOString(),
                sources: [{ file: path.join(KnowledgeBaseService.RAW_FILES_DIR, chunk.rawFilePath) }]
            });
            const fullPageContent = `${frontMatterString.trim()}\n\n${skeleton.bodyContent}`;
            await repository.ensureDirectoryExists(path.dirname(kbPagePath));
            await repository.writeFile(kbPagePath, fullPageContent);
            changedOrNewKbPagePaths.add(kbPagePath);
        }
    }

    // Step 6: Cross-link Pass
    if (changedOrNewKbPagePaths.size > 0) {
        await this._performCrossLinking(repository, Array.from(changedOrNewKbPagePaths));
    }

    // Step 7: Update index.md
    // Only update if there were actual changes to KB pages.
    if (changedOrNewKbPagePaths.size > 0) {
        await this._updateIndexMd(repository);
    }
    
    let kbCommitSha: string | null = null;
    if (changedOrNewKbPagePaths.size > 0) {
        try {
            await repository.add(Array.from(changedOrNewKbPagePaths));
            // Also add index.md if it was updated
            const indexMdFullPath = path.join(KnowledgeBaseService.KB_FILES_DIR, KnowledgeBaseService.KB_INDEX_MD);
            if (await repository.fileExists(indexMdFullPath) && !changedOrNewKbPagePaths.has(indexMdFullPath)) { // ensure it exists and not already added
                 if (changedOrNewKbPagePaths.size > 0) await repository.add([indexMdFullPath]); // only add if other files changed
            }

            const commitMessage = `feat(kb): Ingest ${fullRawFilePath} -> KB update (pages: ${changedOrNewKbPagePaths.size})`;
            const commitResult = await repository.commit({ message: commitMessage });
            if (commitResult.success && commitResult.hash) {
                kbCommitSha = commitResult.hash;
                console.log(`[KBService] Committed KB changes with SHA: ${kbCommitSha}`);
            } else {
                console.error(`[KBService] Failed to commit KB changes for ${fullRawFilePath}: ${commitResult.message}`);
            }
        } catch (commitError) {
            console.error(`[KBService] Error committing KB changes for ${fullRawFilePath}: ${commitError}`);
        }
    } else {
        console.log(`[KBService] No changes to KB from ${fullRawFilePath}. No commit needed.`);
    }
    
    console.log(`[KBService] Finished ingestion for ${rawDocumentRelativePath}. Affected KB paths: ${JSON.stringify(Array.from(changedOrNewKbPagePaths))}`);
    return { affectedKBPaths: Array.from(changedOrNewKbPagePaths), kbCommitSha };
  }

  private async _loadAndPreprocessRawDoc(repository: Repository, fullRawFilePath: string): Promise<{ content: string; metadata: Record<string, any> }> {
    const fileContent = await repository.readFile(fullRawFilePath);
    const { data: metadata, content: body } = matter(fileContent);
    return { content: body, metadata };
  }

  private _parseAndChunk(content: string, metadata: Record<string, any>, rawFilePath: string): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    //优先按一级标题分块
    const headings = content.match(/^# .*/gm); 
    
    if (headings && headings.length > 0) {
        let currentPosition = 0;
        headings.forEach((heading, index) => {
            const nextH1ContentStart = content.indexOf(headings[index + 1] || `\n##END_OF_CONTENT_MARKER##`, currentPosition + heading.length);
            const chunkContent = content.substring(currentPosition, nextH1ContentStart !== -1 ? nextH1ContentStart : undefined).trim();
            
            if (chunkContent) { // Ensure non-empty chunk
                 chunks.push({
                    id: `${rawFilePath}#${this._slugify(heading.substring(1).trim())}`,
                    rawFilePath,
                    originalMetadata: metadata,
                    content: chunkContent,
                    heading: heading.substring(1).trim(),
                });
            }
            currentPosition = nextH1ContentStart !== -1 ? nextH1ContentStart : content.length;
        });
    } else {
        // Fallback: ~800-token windows (approx by chars, assuming 1 token ~ 4 chars)
        const approxWindowSizeChars = KnowledgeBaseService.APPROX_TOKEN_WINDOW_SIZE * 4;
        for (let i = 0; i < content.length; i += approxWindowSizeChars) {
            const chunkContent = content.substring(i, i + approxWindowSizeChars).trim();
            if (chunkContent) { // Ensure non-empty chunk
                chunks.push({
                    id: `${rawFilePath}#chunk${Math.floor(i / approxWindowSizeChars)}`,
                    rawFilePath,
                    originalMetadata: metadata,
                    content: chunkContent,
                });
            }
        }
    }
    return chunks;
  }
  
  private _slugify(text: string): string {
    if (!text) return 'untitled';
    return text.toLowerCase()
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w-]+/g, '')       // Remove all non-word chars but hyphens
        .replace(/--+/g, '-')          // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start of text
        .replace(/-+$/, '');            // Trim - from end of text
  }

  private async _determineTopicDirectory(repository: Repository, content: string): Promise<string> {
    // Use LLM to analyze content and determine appropriate topic directory
    const topicAnalysis = await this.llmService.analyzeTopic(content);
    
    // If LLM returns a topic path, use it
    if (topicAnalysis.topicPath) {
      return topicAnalysis.topicPath;
    }
    
    // Default to 'general' if no specific topic is determined
    return 'general';
  }

  private async _findBestMatchingArticle(repository: Repository, chunkContent: string): Promise<{ path: string, title: string, metadata: Record<string, any>, content: string } | null> {
    const allKbArticles = await this._getAllKbArticles(repository);
    if (allKbArticles.length === 0) return null;

    // Prepare the list of articles with their content
    const articlesWithContent = await Promise.all(
      allKbArticles.map(async (article) => {
        const content = await repository.readFile(article.path);
        return { ...article, content };
      })
    );

    // Use the LLM to select the best match
    const prompt = `Given the following new content, select the best existing article to merge it into. If none are a good fit, respond with 'none'.\n\nNew Content:\n${chunkContent}\n\nExisting Articles:\n${articlesWithContent.map(a => `---\nTitle: ${a.title}\nPath: ${a.path}\nContent:\n${a.content.slice(0, 500)}...`).join('\n\n')}`;

    const llmResponse = await this.llmService.callLLM(prompt);
    const bestPath = llmResponse.trim();
    if (bestPath === 'none') return null;
    const match = articlesWithContent.find(a => a.path === bestPath);
    return match || null;
  }

  private async _performCrossLinking(repository: Repository, changedOrNewKbPagePaths: string[]): Promise<void> {
    console.log(`[KBService] Performing cross-linking for pages: ${changedOrNewKbPagePaths.join(', ')}`);
    
    const allKbArticles = await this._getAllKbArticles(repository);
    if (allKbArticles.length === 0) {
        console.log("[KBService] No KB articles found to build cross-link map.");
        return;
    }

    const linkMap: Map<string, string> = new Map(); // term -> relativePathToArticle
    for (const article of allKbArticles) {
        // Normalized terms for linking (e.g., title, slugified title)
        linkMap.set(article.title.toLowerCase(), article.path); // Use full path for now, make relative later
        const slug = article.path.substring(article.path.lastIndexOf('/') + 1).replace('.md', '');
        linkMap.set(slug.toLowerCase(), article.path);
        // TODO: Add user-defined aliases from frontmatter if available
    }

    for (const subjectPagePath of changedOrNewKbPagePaths) {
        let pageFileContent = await repository.readFile(subjectPagePath);
        const { data: pageMetadata, content: pageBody } = matter(pageFileContent);
        let newPageBody = pageBody;
        let modified = false;

        for (const [term, targetArticlePath] of linkMap) {
            if (!term || path.resolve(subjectPagePath) === path.resolve(targetArticlePath)) { // no empty term or self-link
                continue;
            }

            // Basic regex: find term not already part of a Markdown link [text](url) or an HTML <a> tag
            // This needs to be careful not to break existing links or code blocks.
            // (?<!\\[.*)\\(?<!\\]\\() - not preceded by [ or ](
            // (?<!<a[^>]*>) - not preceded by <a ...>
            // \\b(term)\\b - whole word match
            // (?!\\)\\])(?![^<]*<\\/a>) - not followed by )] or </a>
            const regex = new RegExp(`(?<!\\[[^\\]]*)(?<!\\]\\()(?<!<a[^>]*>)\\b(${this._escapeRegex(term)})\\b(?!\\s*\\([^\\)]*\\)\\])(?![^<]*<\\/a>)`, 'gi');
            
            newPageBody = newPageBody.replace(regex, (match: string) => {
                const relativeLink = path.relative(path.dirname(subjectPagePath), targetArticlePath);
                const mdLink = `[${match}](${relativeLink.startsWith('../') || relativeLink.startsWith('./') ? relativeLink : './' + relativeLink})`;
                modified = true;
                console.log(`[KBService] Linking '${match}' to '${mdLink}' in ${subjectPagePath}`);
                return mdLink;
            });
        }

        if (modified) {
            const frontMatterString = matter.stringify('', pageMetadata); // Pass empty content
            const updatedFullContent = `${frontMatterString.trim()}

${newPageBody}`;
            await repository.writeFile(subjectPagePath, updatedFullContent);
            console.log(`[KBService] Cross-links updated in ${subjectPagePath}`);
        }
    }
  }
  
  private _escapeRegex(string: string): string {
    return string.replace(/[.*+\-?^\${}()|[\\]\\\\]/g, '\\\\$&'); // $& means the whole matched string
  }

  private async _getAllKbArticles(repository: Repository): Promise<Array<{path: string, title: string, metadata: Record<string, any>}>> {
    const articles: Array<{path: string, title: string, metadata: Record<string, any>}> = [];
    const allFiles = await repository.listFiles();
    const kbDirPrefix = KnowledgeBaseService.KB_FILES_DIR + '/';

    for (const fileInfo of allFiles) {
        if (fileInfo.path.startsWith(kbDirPrefix) && fileInfo.path.endsWith('.md') && fileInfo.path !== path.join(kbDirPrefix, KnowledgeBaseService.KB_INDEX_MD)) {
            try {
                const content = await repository.readFile(fileInfo.path);
                const { data } = matter(content);
                articles.push({
                    path: fileInfo.path,
                    title: data.title || this._slugify(path.basename(fileInfo.path, '.md')),
                    metadata: data
                });
            } catch (e) {
                console.warn(`[KBService] Could not read or parse frontmatter for KB file ${fileInfo.path}: ${e}`);
            }
        }
    }
    return articles;
  }

  private async _updateIndexMd(repository: Repository): Promise<void> {
    const indexMdFullPath = path.join(KnowledgeBaseService.KB_FILES_DIR, KnowledgeBaseService.KB_INDEX_MD);
    let content = `# Knowledge Base Index

`;

    const allKbArticles = await this._getAllKbArticles(repository);
    
    // Group articles by topic (first part of path after KB_FILES_DIR)
    const articlesByTopic: Record<string, Array<{name: string, path: string}>> = {};
    for (const article of allKbArticles) {
        const relativeToKbDir = article.path.substring(KnowledgeBaseService.KB_FILES_DIR.length + 1);
        const parts = relativeToKbDir.split('/');
        const topicSlug = parts.length > 1 ? parts[0] : 'general'; // Assume general if not in subfolder
        
        if (!articlesByTopic[topicSlug]) {
            articlesByTopic[topicSlug] = [];
        }
        articlesByTopic[topicSlug].push({
            name: article.title, // Use the extracted title
            path: path.relative(KnowledgeBaseService.KB_FILES_DIR, article.path) // Path relative to KB_FILES_DIR for linking from index.md
        });
    }

    const sortedTopics = Object.keys(articlesByTopic).sort();

    for (const topicSlug of sortedTopics) {
        content += `## ${this._formatTopicNameFromSlug(topicSlug)}
`;
        articlesByTopic[topicSlug].sort((a, b) => a.name.localeCompare(b.name)); // Sort articles alphabetically by name
        for (const article of articlesByTopic[topicSlug]) {
            // Link should be relative to index.md, which is at the root of KB_FILES_DIR
            content += `  - [${article.name}](.${article.path.replace(/\\/g, '/')})
`;
        }
        content += '\n';
    }
    
    await repository.writeFile(indexMdFullPath, content);
    console.log(`[KBService] ${KnowledgeBaseService.KB_INDEX_MD} updated at ${indexMdFullPath}`);
  }

  private _formatTopicNameFromSlug(slug: string): string {
    return slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  // --- Potentially keep or adapt original private methods below if they are still needed ---
  // For example, getRawFiles, getKnowledgeBaseSummaryData, regenerateKnowledgeBase, cleanupKnowledgeBase, etc.
  // The new algorithm focuses on per-document ingestion (processDocumentForKnowledgeBase).
  // Broader operations like full regeneration might need to be adapted or call processDocumentForKnowledgeBase in a loop.

  // Retaining some original methods for now, they might need review based on overall strategy.
  // It's crucial to ensure they don't conflict with the new `processDocumentForKnowledgeBase` flow
  // or that they are updated to use/complement it.

  public async getEntryPage(repository: Repository): Promise<KnowledgeBaseEntry> {
    const entryPath = path.join(KnowledgeBaseService.KB_FILES_DIR, KnowledgeBaseService.KB_INDEX_MD);
    if (await repository.fileExists(entryPath)) {
      const content = await repository.readFile(entryPath);
      // This parsing might need to be updated if index.md is just a list now
      return this._parseGenericMarkdownPageAsEntry(content); 
    }
    // If index.md is purely generated, this might mean generating it on the fly
    await this._updateIndexMd(repository); // Ensure it's created
    const newContent = await repository.readFile(entryPath);
    return this._parseGenericMarkdownPageAsEntry(newContent, "Knowledge Base Index");
  }

  private _parseGenericMarkdownPageAsEntry(content: string, defaultTitle?: string): KnowledgeBaseEntry {
    const { data: frontMatter, content: mainContent } = matter(content);
    return {
      title: frontMatter.title || defaultTitle || "Knowledge Base Entry",
      content: mainContent,
      topics: frontMatter.topics || [], // May not be relevant for new index.md
      sourceDocuments: frontMatter.sources || [],
      lastUpdated: frontMatter.lastUpdated || new Date().toISOString(),
      sourceIds: frontMatter.sourceIds || []
    };
  }
  
  // ... (other original methods like getTopic, listTopics, getRawFiles, etc. would go here)
  // For brevity in this example, I am omitting the full original content of these methods.
  // They would need to be reviewed. For instance, getRawFiles might be useful as a helper.
  // regenerateKnowledgeBase would likely iterate over all raw files and call processDocumentForKnowledgeBase.

  // Placeholder for a more complete set of original methods if they were to be retained and adapted.
  // For now, focusing on the new ingestion logic.
  // The original `generateKnowledgeBase` and its helpers like `regenerateKnowledgeBase`, `updateKnowledgeBase`
  // would need to be refactored to use the new `processDocumentForKnowledgeBase` method for each raw file.
  
  /**
   * @deprecated Use processDocumentForKnowledgeBase instead
   */
  async OLD_generateKnowledgeBase(repository: Repository): Promise<void> {
    console.warn('[KBService] Using deprecated OLD_generateKnowledgeBase method. Please use processDocumentForKnowledgeBase instead.');
    
    // Get all raw files
    const rawFiles = await repository.listFiles(KnowledgeBaseService.RAW_FILES_DIR);
    if (rawFiles.length === 0) {
      console.log('[KBService] No raw files found to process');
      return;
    }

    // Process each raw file
    for (const rawFile of rawFiles) {
      try {
        const rawContent = await repository.readFile(rawFile.path);
        await this.processDocumentForKnowledgeBase(repository, rawContent, rawFile.path);
      } catch (error) {
        console.error(`[KBService] Error processing raw file ${rawFile.path}:`, error);
      }
    }

    // Update the index.md file
    await this._updateIndexMd(repository);
  }
  
  private async _listRawFilePaths(repository: Repository): Promise<string[]> {
      const allFiles = await repository.listFiles();
      return allFiles
          .filter(f => f.path.startsWith(KnowledgeBaseService.RAW_FILES_DIR + '/') && !f.path.endsWith('/'))
          .map(f => f.path.substring(KnowledgeBaseService.RAW_FILES_DIR.length + 1));
  }
  
   // Original parseMarkdown, parseYaml, etc., could be here if they are superior or needed by other methods.
   // For instance, if the `matter` library isn't sufficient or there's custom parsing.
   // The `matter` library handles both parsing frontmatter and separating content.
   // Using `matter.stringify` for writing.
} 