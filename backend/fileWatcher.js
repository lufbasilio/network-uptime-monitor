import { watchFile, unwatchFile } from 'fs';

/**
 * FileWatcher monitors a log file for modifications using fs.watchFile polling.
 * Uses polling (not fs.watch) for compatibility with Raspberry Pi filesystems.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 1.4
 */
export class FileWatcher {
  constructor() {
    this._logFilePath = null;
    this._watching = false;
  }

  /**
   * Start watching the file at logFilePath.
   * Calls onChange() whenever the file is modified or created.
   *
   * @param {string} logFilePath - Absolute or relative path to the log file
   * @param {() => void} onChange - Callback invoked on file modification or creation
   */
  start(logFilePath, onChange) {
    if (this._watching) {
      this.stop();
    }

    this._logFilePath = logFilePath;
    this._watching = true;

    // fs.watchFile uses stat polling — works reliably on FAT/ext4/NFS (Req 3.3)
    // interval: 10000ms = 10 seconds (Req 3.1)
    watchFile(logFilePath, { persistent: false, interval: 10000 }, (current, previous) => {
      // Detect file creation: nlink goes from 0 to > 0 (Req 1.4)
      const wasCreated = previous.nlink === 0 && current.nlink > 0;

      // Detect modification: mtime changed and file still exists (Req 3.2)
      const wasModified = current.nlink > 0 && current.mtimeMs !== previous.mtimeMs;

      if (wasCreated || wasModified) {
        onChange();
      }
    });
  }

  /**
   * Stop watching the file and release all associated resources.
   * Requirements: 3.4
   */
  stop() {
    if (this._logFilePath && this._watching) {
      unwatchFile(this._logFilePath);
    }
    this._logFilePath = null;
    this._watching = false;
  }
}
