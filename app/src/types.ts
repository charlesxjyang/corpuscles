// ---- Data types ----

export interface ParsedData {
  columns: string[];
  data: Record<string, (number | string | null)[]>;
  fileType: string;
  experimentType: string;
  metadata: Record<string, string>;
  rowCount: number;
}

export interface Dataset {
  id: string;
  filename: string;
  data: ParsedData;
  color: string;
  visible: boolean;
  masked: Set<number>; // indices of masked (excluded) data points
}

export interface Project {
  id: string;
  name: string;
  datasets: Dataset[];
  results: AnalysisResult[];
}

// ---- Analysis types ----

export type AnalysisType =
  | 'circuit_fit'
  | 'kramers_kronig'
  | 'drt_simple'
  | 'drt_bayesian'
  | 'drt_bht'
  | 'drt_peak'
  | 'dqdv'
  | 'capacity_per_cycle'
  | 'capacity_fade';

export interface AnalysisResult {
  id: string;
  datasetId: string;
  type: AnalysisType;
  params: Record<string, unknown>;
  data: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  timestamp: number;
}

// ---- Workflow tabs ----

export type WorkflowTab =
  | 'data'
  | 'kramers-kronig'
  | 'drt'
  | 'fitting'
  | 'plotting';

// ---- Worker communication ----

export type WorkerCommand =
  | { type: 'init' }
  | { type: 'parse'; id: string; filename: string; buffer: ArrayBuffer }
  | { type: 'analyze'; id: string; command: string; params: Record<string, unknown> };

export type WorkerResponse =
  | { type: 'init_done' }
  | { type: 'init_progress'; message: string }
  | { type: 'parse_done'; id: string; result: ParsedData }
  | { type: 'analyze_done'; id: string; result: AnalysisResult }
  | { type: 'error'; id?: string; message: string };
