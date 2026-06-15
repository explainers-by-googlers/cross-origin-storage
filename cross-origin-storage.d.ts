/**
 * Represents the dictionary for hash algorithm and value.
 */
interface CrossOriginStorageRequestFileHandleHash {
  value: string;
  algorithm: string;
}

/**
 * Represents the options for requesting a file handle.
 */
interface CrossOriginStorageRequestFileHandleOptions {
  create?: boolean;
  origins?: string[] | string;
}

/**
 * The CrossOriginStorageManager interface.
 * [SecureContext]
 */
interface CrossOriginStorageManager {
  requestFileHandle(
    hash: CrossOriginStorageRequestFileHandleHash,
    options?: CrossOriginStorageRequestFileHandleOptions,
  ): Promise<FileSystemFileHandle>;
}

/**
 * Augment the standard Navigator interface.
 */
interface Navigator {
  readonly crossOriginStorage: CrossOriginStorageManager;
}

/**
 * Augment the standard WorkerNavigator interface.
 */
interface WorkerNavigator {
  readonly crossOriginStorage: CrossOriginStorageManager;
}
