/**
 * Represents an entry in the timeline, tracking operations within a repository.
 * This corresponds to timeline.json schema v2.
 */
export interface TimelineEntry {
  /**
   * Unique identifier for the timeline entry (UUID).
   * Primary key.
   */
  id: string;

  /**
   * Timestamp of when the event occurred, in ISO-8601 UTC format.
   */
  timestamp: string;

  /**
   * Indicates who or what initiated the operation.
   */
  actor: "user" | "system";

  /**
   * The type of operation performed.
   * - add: A new source file was introduced.
   * - update: An existing source file or its corresponding KB pages were updated.
   * - delete: A source file was deleted.
   * - regen: A full regeneration of the knowledge base was triggered.
   * - error: An error occurred during an operation.
   */
  operation: "add" | "update" | "delete" | "regen" | "error";

  /**
   * Path to the source file that this entry primarily concerns.
   * e.g., "raw/meetings/2025-05-13.md" (relative to the repository root).
   * For "regen" or "error" operations not tied to a single source, this might be a system path or null.
   */
  sourcePath: string | null; // Allowing null for operations like a general regen not tied to one file

  /**
   * The short Git commit SHA associated with this timeline event.
   * This commit includes changes to raw files, KB pages, and timeline.json itself.
   */
  commit: string;

  /**
   * Array of paths to knowledge-base pages that were created, updated, or affected
   * by this operation (relative to the repository root, e.g., "knowledge-base/topic/concept.md").
   */
  affectedKB: string[];

  /**
   * Flag indicating if the operation touched a large number of files (e.g., > N files),
   * often true for "regen" operations.
   */
  bulk: boolean;

  /**
   * Optional field for additional metadata.
   * Can store things like tags, a superseded status, original v1 fields during migration,
   * error details, or reasons for regeneration.
   */
  meta?: Record<string, any>;
} 