import { useState, useMemo } from 'react';
import { AnalysisLayout } from '../AnalysisLayout';
import { PlotlyChart } from '../PlotlyChart';
import type { Dataset, AnalysisResult } from '../../types';

interface Props {
  datasets: Dataset[];
  results: AnalysisResult[];
  onAnalyze: (datasetId: string, type: string, params: Record<string, unknown>) => void;
  analyzing: boolean;
}

export function KramersKronigTab({ datasets, results, onAnalyze, analyzing }: Props) {
  const [selectedDataset, setSelectedDataset] = useState<string>(datasets[0]?.id ?? '');
  const [muCutoff, setMuCutoff] = useState(0.85);
  const [maxM, setMaxM] = useState(50);

  const eisDatasets = datasets.filter(d => d.data.experimentType === 'eis' && d.visible);
  const kkResults = results.filter(r => r.type === 'kramers_kronig' && r.status === 'completed');

  const handleRun = () => {
    if (!selectedDataset) return;
    onAnalyze(selectedDataset, 'kramers_kronig', { c: muCutoff, max_M: maxM });
  };

  const handleRunAll = () => {
    eisDatasets.forEach(ds => {
      onAnalyze(ds.id, 'kramers_kronig', { c: muCutoff, max_M: maxM });
    });
  };

  const settings = (
    <>
      <SectionHeader>Dataset</SectionHeader>
      <select
        value={selectedDataset}
        onChange={e => setSelectedDataset(e.target.value)}
        style={selectStyle}
      >
        {eisDatasets.map(ds => (
          <option key={ds.id} value={ds.id}>{ds.filename}</option>
        ))}
      </select>

      <SectionHeader>Settings</SectionHeader>
      <Label label={`\u00b5 cutoff: ${muCutoff}`}>
        <input type="range" min={0.5} max={0.99} step={0.01} value={muCutoff} onChange={e => setMuCutoff(Number(e.target.value))} style={{ width: '100%' }} />
      </Label>
      <Label label={`Max RC elements: ${maxM}`}>
        <input type="range" min={10} max={100} step={5} value={maxM} onChange={e => setMaxM(Number(e.target.value))} style={{ width: '100%' }} />
      </Label>

      <button onClick={handleRun} disabled={analyzing || !selectedDataset} style={primaryBtnStyle}>
        {analyzing ? 'Running...' : 'Run KK Test'}
      </button>
      <button onClick={handleRunAll} disabled={analyzing || eisDatasets.length === 0} style={secondaryBtnStyle}>
        Run All ({eisDatasets.length})
      </button>
    </>
  );

  const resultRows = kkResults.map(r => {
    const d = r.data as Record<string, unknown>;
    const ds = datasets.find(x => x.id === r.datasetId);
    return {
      dataset: ds?.filename ?? '?',
      M: d.M as number,
      mu: d.mu as number,
      valid: d.valid as boolean,
      id: r.id,
    };
  });

  const resultsTable = (
    <div style={{ padding: '0.5rem' }}>
      {resultRows.length === 0 ? (
        <div style={{ color: '#9ca3af', fontSize: '0.85rem', padding: '1rem' }}>
          Run Kramers-Kronig test to validate data quality
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
              <th style={thStyle}>Dataset</th>
              <th style={thStyle}>RC Elements (M)</th>
              <th style={thStyle}>{'\u00b5'}</th>
              <th style={thStyle}>Valid</th>
            </tr>
          </thead>
          <tbody>
            {resultRows.map(row => (
              <tr key={row.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={tdStyle}>{row.dataset}</td>
                <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{row.M}</td>
                <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{row.mu.toFixed(4)}</td>
                <td style={tdStyle}>
                  <span style={{ color: row.valid ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                    {row.valid ? 'PASS' : 'FAIL'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  const plots = <KKPlots datasets={eisDatasets} results={kkResults} />;

  return <AnalysisLayout settings={settings} results={resultsTable} plots={plots} />;
}

function KKPlots({ datasets, results }: { datasets: Dataset[]; results: AnalysisResult[] }) {
  const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'];

  const { nyquistTraces, residualTraces } = useMemo(() => {
    const nyquist: Plotly.Data[] = [];
    const residual: Plotly.Data[] = [];

    datasets.forEach((ds, i) => {
      const d = ds.data.data;
      if (!d.z_real_ohm || !d.z_imag_ohm) return;
      nyquist.push({
        x: d.z_real_ohm,
        y: (d.z_imag_ohm as number[]).map(v => -(v as number)),
        mode: 'markers',
        name: ds.filename,
        marker: { color: COLORS[i % COLORS.length], size: 5 },
      });

      const kkResult = results.find(r => r.datasetId === ds.id);
      if (kkResult) {
        const rd = kkResult.data as Record<string, unknown>;
        nyquist.push({
          x: rd.z_fit_real as number[],
          y: (rd.z_fit_imag as number[]).map(v => -(v as number)),
          mode: 'lines',
          name: `KK fit (${ds.filename})`,
          line: { color: COLORS[i % COLORS.length], dash: 'dash', width: 2 },
        });
        const freq = d.frequency_hz as number[];
        residual.push({
          x: freq,
          y: rd.resids_real as number[],
          mode: 'lines+markers',
          name: `Re residual (${ds.filename})`,
          marker: { color: COLORS[i % COLORS.length], size: 3 },
          line: { color: COLORS[i % COLORS.length] },
        });
        residual.push({
          x: freq,
          y: rd.resids_imag as number[],
          mode: 'lines+markers',
          name: `Im residual (${ds.filename})`,
          marker: { color: COLORS[i % COLORS.length], size: 3, symbol: 'triangle-up' },
          line: { color: COLORS[i % COLORS.length], dash: 'dash' },
        });
      }
    });
    return { nyquistTraces: nyquist, residualTraces: residual };
  }, [datasets, results]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <PlotlyChart
        data={nyquistTraces}
        layout={{
          xaxis: { title: { text: "Z' (\u03a9)" }, scaleanchor: 'y' },
          yaxis: { title: { text: "-Z'' (\u03a9)" } },
          margin: { l: 60, r: 20, t: 30, b: 50 },
          legend: { orientation: 'h', y: -0.2 },
        }}
        style={{ width: '100%', height: 350 }}
      />
      {residualTraces.length > 0 && (
        <PlotlyChart
          data={residualTraces}
          layout={{
            xaxis: { title: { text: 'Frequency (Hz)' }, type: 'log' },
            yaxis: { title: { text: 'Residual (%)' } },
            margin: { l: 60, r: 20, t: 10, b: 50 },
            legend: { orientation: 'h', y: -0.25 },
            shapes: [{ type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 0, y1: 0, line: { color: '#9ca3af', dash: 'dot' } }],
          }}
          style={{ width: '100%', height: 250 }}
        />
      )}
    </div>
  );
}

// ---- Shared small components ----

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h4 style={{ margin: 0, fontSize: '0.75rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</h4>;
}

function Label({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: '0.82rem', color: '#374151' }}>
      <div style={{ marginBottom: '0.2rem' }}>{label}</div>
      {children}
    </label>
  );
}

const selectStyle: React.CSSProperties = { width: '100%', padding: '0.4rem', borderRadius: 6, border: '1px solid #d1d5db', fontSize: '0.82rem' };
const thStyle: React.CSSProperties = { textAlign: 'left', padding: '0.35rem 0.5rem', color: '#6b7280', fontSize: '0.78rem' };
const tdStyle: React.CSSProperties = { padding: '0.3rem 0.5rem' };
const primaryBtnStyle: React.CSSProperties = { width: '100%', padding: '0.5rem', borderRadius: 6, border: 'none', cursor: 'pointer', backgroundColor: '#3b82f6', color: 'white', fontWeight: 600, fontSize: '0.85rem' };
const secondaryBtnStyle: React.CSSProperties = { width: '100%', padding: '0.4rem', borderRadius: 6, border: '1px solid #d1d5db', cursor: 'pointer', backgroundColor: 'white', color: '#374151', fontSize: '0.82rem' };
