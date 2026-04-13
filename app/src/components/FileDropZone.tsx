import { useCallback, useState } from 'react';

const SUPPORTED_EXTENSIONS = new Set([
  'mpr', 'mpt', 'nda', 'ndax', 'dta', 'txt', 'csv', 'tsv',
]);

function isSupportedFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_EXTENSIONS.has(ext) && !file.name.startsWith('.');
}

interface Props {
  onFileDrop: (file: File) => void;
  disabled?: boolean;
}

export function FileDropZone({ onFileDrop, disabled }: Props) {
  const [dragging, setDragging] = useState(false);

  const processFiles = useCallback(
    (files: FileList | File[]) => {
      if (disabled) return;
      const arr = Array.from(files).filter(isSupportedFile);
      for (const file of arr) {
        onFileDrop(file);
      }
    },
    [onFileDrop, disabled]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setDragging(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragging(false);
      if (disabled) return;

      // Handle both files and directory drops
      const items = e.dataTransfer.items;
      if (items) {
        const filePromises: Promise<File | null>[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const entry = item.webkitGetAsEntry?.();
          if (entry) {
            if (entry.isDirectory) {
              filePromises.push(...readDirectoryRecursive(entry as FileSystemDirectoryEntry));
            } else {
              filePromises.push(
                new Promise<File | null>(resolve => {
                  (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
                })
              );
            }
          }
        }
        const files = (await Promise.all(filePromises)).filter(Boolean) as File[];
        const supported = files.filter(isSupportedFile);
        for (const file of supported) {
          onFileDrop(file);
        }
      } else {
        processFiles(e.dataTransfer.files);
      }
    },
    [onFileDrop, disabled, processFiles]
  );

  const handleFileClick = useCallback(() => {
    if (disabled) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.mpr,.mpt,.nda,.ndax,.DTA,.dta,.txt,.csv,.tsv';
    input.onchange = () => {
      if (input.files) processFiles(input.files);
    };
    input.click();
  }, [processFiles, disabled]);

  const handleFolderClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.onchange = () => {
      if (input.files) processFiles(input.files);
    };
    input.click();
  }, [processFiles, disabled]);

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleFileClick}
      style={{
        border: `2px dashed ${dragging ? '#3b82f6' : '#6b7280'}`,
        borderRadius: 12,
        padding: '1.5rem',
        textAlign: 'center',
        cursor: disabled ? 'wait' : 'pointer',
        backgroundColor: dragging ? '#eff6ff' : '#f9fafb',
        transition: 'all 0.2s ease',
        minHeight: 100,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.4rem',
      }}
    >
      <div style={{ fontWeight: 600, color: '#374151', fontSize: '0.95rem' }}>
        {disabled ? 'Loading Python runtime...' : 'Drop files or folders here'}
      </div>
      <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>
        .mpr .nda .ndax .DTA .csv .txt
      </div>
      {!disabled && (
        <button
          onClick={handleFolderClick}
          style={{
            marginTop: '0.25rem',
            padding: '0.3rem 0.75rem',
            borderRadius: 6,
            border: '1px solid #d1d5db',
            cursor: 'pointer',
            backgroundColor: 'white',
            fontSize: '0.8rem',
            color: '#4b5563',
          }}
        >
          Open Folder
        </button>
      )}
    </div>
  );
}

function readDirectoryRecursive(dirEntry: FileSystemDirectoryEntry): Promise<File | null>[] {
  const promises: Promise<File | null>[] = [];
  const reader = dirEntry.createReader();

  const readBatch = (): Promise<void> =>
    new Promise(resolve => {
      reader.readEntries(entries => {
        if (entries.length === 0) {
          resolve();
          return;
        }
        for (const entry of entries) {
          if (entry.isFile) {
            promises.push(
              new Promise<File | null>(res => {
                (entry as FileSystemFileEntry).file(res, () => res(null));
              })
            );
          } else if (entry.isDirectory) {
            promises.push(...readDirectoryRecursive(entry as FileSystemDirectoryEntry));
          }
        }
        // readEntries may return results in batches
        readBatch().then(resolve);
      });
    });

  promises.push(
    readBatch().then(() => null) // sentinel to ensure batch reading completes
  );
  return promises;
}
