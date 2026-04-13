import { useState, useCallback } from 'react';
import { usePyodide } from './hooks/usePyodide';
import { WorkflowTabs } from './components/WorkflowTabs';
import { DataTab } from './components/tabs/DataTab';
import { KramersKronigTab } from './components/tabs/KramersKronigTab';
import { DRTTab } from './components/tabs/DRTTab';
import { FittingTab } from './components/tabs/FittingTab';
import { PlottingTab } from './components/tabs/PlottingTab';
import type { Dataset, AnalysisResult, WorkflowTab } from './types';

const COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6',
];

function App() {
  const { ready, loading, loadingMessage, error, parseFile, analyze } = usePyodide();
  const [activeTab, setActiveTab] = useState<WorkflowTab>('data');
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[]>([]);
  const [parseQueue, setParseQueue] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  const handleFileDrop = useCallback(
    async (file: File) => {
      if (!ready) return;
      setParseQueue(q => q + 1);
      setParseError(null);
      try {
        const buffer = await file.arrayBuffer();
        const data = await parseFile(file.name, buffer);
        const id = `ds_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setDatasets(prev => [
          ...prev,
          {
            id,
            filename: file.name,
            data,
            color: COLORS[prev.length % COLORS.length],
            visible: true,
            masked: new Set(),
          },
        ]);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : String(err));
      } finally {
        setParseQueue(q => q - 1);
      }
    },
    [ready, parseFile]
  );

  const handleToggle = useCallback((id: string) => {
    setDatasets(prev => prev.map(d => d.id === id ? { ...d, visible: !d.visible } : d));
  }, []);

  const handleRemove = useCallback((id: string) => {
    setDatasets(prev => prev.filter(d => d.id !== id));
    setAnalysisResults(prev => prev.filter(r => r.datasetId !== id));
  }, []);

  const handleAnalyze = useCallback(
    async (datasetId: string, type: string, params: Record<string, unknown>) => {
      setAnalyzing(true);
      const ds = datasets.find(d => d.id === datasetId);
      if (!ds) { setAnalyzing(false); return; }

      try {
        // Build analysis params with data from dataset
        const d = ds.data.data;
        let fullParams = { ...params };

        // Inject data arrays based on analysis type
        if (['circuit_fit', 'kramers_kronig', 'drt_simple', 'drt_bayesian', 'drt_bht'].includes(type)) {
          fullParams = {
            ...fullParams,
            frequency: d.frequency_hz,
            z_real: d.z_real_ohm,
            z_imag: d.z_imag_ohm,
          };
        }
        if (type === 'dqdv') {
          fullParams = { ...fullParams, voltage: d.voltage_v, capacity: d.capacity_ah };
        }
        if (type === 'capacity_per_cycle') {
          fullParams = { ...fullParams, data: d };
        }

        const result = await analyze(type, fullParams);
        const analysisResult: AnalysisResult = {
          id: `ar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          datasetId,
          type: type as AnalysisResult['type'],
          params,
          data: result.data as Record<string, unknown>,
          status: 'completed',
          timestamp: Date.now(),
        };
        setAnalysisResults(prev => [...prev, analysisResult]);
      } catch (err) {
        const analysisResult: AnalysisResult = {
          id: `ar_${Date.now()}`,
          datasetId,
          type: type as AnalysisResult['type'],
          params,
          data: {},
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        setAnalysisResults(prev => [...prev, analysisResult]);
        setParseError(err instanceof Error ? err.message : String(err));
      } finally {
        setAnalyzing(false);
      }
    },
    [datasets, analyze]
  );

  const parsing = parseQueue > 0;
  const hasData = datasets.length > 0;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      backgroundColor: '#f8fafc',
    }}>
      {/* Header */}
      <header style={{
        padding: '0.5rem 1.25rem',
        backgroundColor: 'white',
        borderBottom: '1px solid #e5e7eb',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        flexShrink: 0,
      }}>
        <h1 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#1e293b' }}>
          Corpuscles
        </h1>
        <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
          Electrochemical Impedance Analysis
        </span>
        <div style={{ flex: 1 }} />
        {loading && <StatusBadge color="#3b82f6">{loadingMessage || 'Loading...'}</StatusBadge>}
        {ready && !parsing && !analyzing && <StatusBadge color="#10b981">Ready</StatusBadge>}
        {parsing && <StatusBadge color="#3b82f6">Parsing {parseQueue} file{parseQueue > 1 ? 's' : ''}...</StatusBadge>}
        {analyzing && <StatusBadge color="#f59e0b">Analyzing...</StatusBadge>}
      </header>

      {/* Workflow tabs */}
      <WorkflowTabs activeTab={activeTab} onTabChange={setActiveTab} hasData={hasData} />

      {/* Error banner */}
      {(parseError || error) && (
        <div style={{
          padding: '0.4rem 1.25rem',
          backgroundColor: '#fef2f2',
          borderBottom: '1px solid #fecaca',
          fontSize: '0.82rem',
          color: '#dc2626',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}>
          <span>{parseError || error}</span>
          <button onClick={() => setParseError(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#dc2626', fontWeight: 700 }}>&times;</button>
        </div>
      )}

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === 'data' && (
          <DataTab
            datasets={datasets}
            onFileDrop={handleFileDrop}
            onToggle={handleToggle}
            onRemove={handleRemove}
            pyodideReady={ready}
            parsing={parsing}
            parseCount={parseQueue}
          />
        )}
        {activeTab === 'kramers-kronig' && (
          <KramersKronigTab
            datasets={datasets}
            results={analysisResults}
            onAnalyze={handleAnalyze}
            analyzing={analyzing}
          />
        )}
        {activeTab === 'drt' && (
          <DRTTab
            datasets={datasets}
            results={analysisResults}
            onAnalyze={handleAnalyze}
            analyzing={analyzing}
          />
        )}
        {activeTab === 'fitting' && (
          <FittingTab
            datasets={datasets}
            results={analysisResults}
            onAnalyze={handleAnalyze}
            analyzing={analyzing}
          />
        )}
        {activeTab === 'plotting' && (
          <PlottingTab
            datasets={datasets}
            results={analysisResults}
          />
        )}
      </div>

      {/* Footer */}
      <footer style={{
        padding: '0.3rem 1.25rem',
        borderTop: '1px solid #e5e7eb',
        backgroundColor: 'white',
        fontSize: '0.72rem',
        color: '#9ca3af',
        display: 'flex',
        gap: '1rem',
        flexShrink: 0,
      }}>
        <span>All data stays in your browser. Nothing uploaded.</span>
        <span>{datasets.length} dataset{datasets.length !== 1 ? 's' : ''}</span>
        <span>{analysisResults.filter(r => r.status === 'completed').length} result{analysisResults.filter(r => r.status === 'completed').length !== 1 ? 's' : ''}</span>
      </footer>
    </div>
  );
}

function StatusBadge({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: '0.75rem',
      color,
      display: 'flex',
      alignItems: 'center',
      gap: '0.3rem',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: color }} />
      {children}
    </span>
  );
}

export default App;
