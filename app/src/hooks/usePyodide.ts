import { useState, useEffect, useRef, useCallback } from 'react';
import type { ParsedData, AnalysisResult, WorkerCommand, WorkerResponse } from '../types';

type Resolver = {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
};

export function usePyodide() {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<Map<string, Resolver>>(new Map());
  const idCounter = useRef(0);

  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/pyodide-worker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init_done':
          setReady(true);
          setLoading(false);
          setLoadingMessage('');
          break;
        case 'init_progress':
          setLoadingMessage(msg.message);
          break;
        case 'parse_done': {
          const resolver = pendingRef.current.get(msg.id);
          if (resolver) {
            resolver.resolve(msg.result);
            pendingRef.current.delete(msg.id);
          }
          break;
        }
        case 'analyze_done': {
          const resolver = pendingRef.current.get(msg.id);
          if (resolver) {
            resolver.resolve(msg.result);
            pendingRef.current.delete(msg.id);
          }
          break;
        }
        case 'error': {
          if (msg.id) {
            const resolver = pendingRef.current.get(msg.id);
            if (resolver) {
              resolver.reject(new Error(msg.message));
              pendingRef.current.delete(msg.id);
            }
          } else {
            setError(msg.message);
            setLoading(false);
          }
          break;
        }
      }
    };

    worker.onerror = (err) => {
      setError(err.message);
      setLoading(false);
    };

    // Initialize Pyodide
    setLoading(true);
    setLoadingMessage('Starting Python runtime...');
    worker.postMessage({ type: 'init' } as WorkerCommand);

    return () => {
      worker.terminate();
    };
  }, []);

  const sendCommand = useCallback((cmd: WorkerCommand): Promise<any> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error('Worker not initialized'));
        return;
      }
      if ('id' in cmd && cmd.id) {
        pendingRef.current.set(cmd.id, { resolve, reject });
      }
      if (cmd.type === 'parse') {
        workerRef.current.postMessage(cmd, [cmd.buffer]);
      } else {
        workerRef.current.postMessage(cmd);
      }
    });
  }, []);

  const parseFile = useCallback(
    async (filename: string, buffer: ArrayBuffer): Promise<ParsedData> => {
      const id = `parse_${++idCounter.current}`;
      return sendCommand({ type: 'parse', id, filename, buffer });
    },
    [sendCommand]
  );

  const analyze = useCallback(
    async (command: string, params: Record<string, unknown>): Promise<AnalysisResult> => {
      const id = `analyze_${++idCounter.current}`;
      return sendCommand({ type: 'analyze', id, command, params });
    },
    [sendCommand]
  );

  return { ready, loading, loadingMessage, error, parseFile, analyze };
}
