export type FileChangeOperation = 'add' | 'modify' | 'delete';

export interface FileChangeInfo {
  path: string;
  status: FileChangeOperation;
}

// Add other common types here as needed in the future 