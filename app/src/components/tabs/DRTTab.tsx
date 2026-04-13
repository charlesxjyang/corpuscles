import { useState, useMemo } from 'react';
import { AnalysisLayout } from '../AnalysisLayout';
import { PlotlyChart } from '../PlotlyChart';
import type { Dataset, AnalysisResult } from '../../types';

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'];

interface Props {
  datasets: Dataset[];
  results: AnalysisResult[];
  onAnalyze: (datasetId: string, type: string, params: Record<string, unknown>) => void;
  analyzing: boolean;
}

export function DRTTab({ datasets, results, onAnalyze, analyzing }: Props) {
  const [selectedDataset, setSelectedDataset] = useState<string>(datasets[0]?.id ?? '');
  const [method, setMethod] = useState<'simple' | 'bayesian' | 'BHT'>('simple');
  const [rbfType, setRbfType] = useState('Gaussian');
  const [derUsed, setDerUsed] = useState('1st order');
  const [cvType, setCvType] = useState('GCV');
  const [regParam, setRegParam] = useState(1e-3);
  const [coeff, setCoeff] = useState(0.5);
  const [nmcSample, setNmcSample] = useState(2000);

  const eisDatasets = datasets.filter(d => d.data.experimentType === 'eis' && d.visible);
  const drtResults = results.filter(r => (r.type === 'drt_simple' || r.type === 'drt_bayesian' || r.type === 'drt_bht') && r.status === 'completed');

  const handleRun = () => {
    if (!selectedDataset) return;
    const type = `drt_${method}` as const;
    onAnalyze(selectedDataset, type, {
      method, rbf_type: rbfType, der_used: derUsed,
      cv_type: cvType, reg_param: regParam, coeff,
      ...(method === 'bayesian' ? { NMC_sample: nmcSample } : {}),
    });
  };

  const settings = (
    <>
      <SectionHeader>Dataset</SectionHeader>
      <select value={selectedDataset} onChange={e => setSelectedDataset(e.target.value)} style={selectStyle}>
        {eisDatasets.map(ds => <option key={ds.id} value={ds.id}>{ds.filename}</option>)}
      </select>

      <SectionHeader>Method</SectionHeader>
      <select value={method} onChange={e => setMethod(e.target.value as any)} style={selectStyle}>
        <option value="simple">Tikhonov (fast)</option>
        <option value="bayesian">Bayesian (with uncertainty)</option>
        <option value="BHT">BHT (Kramers-Kronig)</option>
      </select>

      <SectionHeader>Parameters</SectionHeader>
      <Label label="RBF type">
        <select value={rbfType} onChange={e => setRbfType(e.target.value)} style={selectStyle}>
          {['Gaussian', 'C0 Matern', 'C2 Matern', 'C4 Matern', 'C6 Matern', 'Inverse Quadratic', 'Cauchy'].map(t =>
            <option key={t} value={t}>{t}</option>
          )}
        </select>
      </Label>
      <Label label="Derivative order">
        <select value={derUsed} onChange={e => setDerUsed(e.target.value)} style={selectStyle}>
          <option value="1st order">1st order</option>
          <option value="2nd order">2nd order</option>
        </select>
      </Label>
      <Label label="Regularization">
        <select value={cvType} onChange={e => setCvType(e.target.value)} style={selectStyle}>
          <option value="GCV">GCV (auto)</option>
          <option value="custom">Custom</option>
        </select>
      </Label>
      {cvType === 'custom' && (
        <Label label={`\u03bb: ${regParam.toExponential(1)}`}>
          <input type="range" min={-6} max={0} step={0.5} value={Math.log10(regParam)} onChange={e => setRegParam(10 ** Number(e.target.value))} style={{ width: '100%' }} />
        </Label>
      )}
      <Label label={`FWHM coeff: ${coeff}`}>
        <input type="range" min={0.1} max={1.0} step={0.05} value={coeff} onChange={e => setCoeff(Number(e.target.value))} style={{ width: '100%' }} />
      </Label>
      {method === 'bayesian' && (
        <Label label={`MCMC samples: ${nmcSample}`}>
          <input type="range" min={500} max={5000} step={500} value={nmcSample} onChange={e => setNmcSample(Number(e.target.value))} style={{ width: '100%' }} />
        </Label>
      )}

      <button onClick={handleRun} disabled={analyzing || !selectedDataset} style={primaryBtnStyle}>
        {analyzing ? 'Computing DRT...' : 'Run DRT'}
      </button>
      {method === 'bayesian' && (
        <div style={{ fontSize: '0.75rem', color: '#f59e0b' }}>Bayesian method may take 1-3 minutes</div>
      )}
    </>
  );

  const drtResultRows = drtResults.map(r => {
    const d = r.data as Record<string, unknown>;
    const ds = datasets.find(x => x.id === r.datasetId);
    return {
      id: r.id,
      dataset: ds?.filename ?? '?',
      method: d.method as string,
      R_inf: d.R_inf as number,
      lambda: (d.lambda_value as number) ?? null,
    };
  });

  const resultsTable = (
    <div style={{ padding: '0.5rem' }}>
      {drtResultRows.length === 0 ? (
        <div style={{ color: '#9ca3af', fontSize: '0.85rem', padding: '1rem' }}>Run DRT analysis to see results</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
              <th style={thStyle}>Dataset</th>
              <th style={thStyle}>Method</th>
              <th style={thStyle}>R_inf (\u03a9)</th>
              <th style={thStyle}>{'\u03bb'}</th>
            </tr>
          </thead>
          <tbody>
            {drtResultRows.map(row => (
              <tr key={row.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={tdStyle}>{row.dataset}</td>
                <td style={tdStyle}>{row.method}</td>
                <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{row.R_inf?.toFixed(4) ?? '-'}</td>
                <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{row.lambda?.toExponential(2) ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  const plots = <DRTPlots datasets={eisDatasets} results={drtResults} />;

  return <AnalysisLayout settings={settings} results={resultsTable} plots={plots} />;
}

function DRTPlots({ datasets, results }: { datasets: Dataset[]; results: AnalysisResult[] }) {
  const traces = useMemo(() => {
    return results.map((r, i) => {
      const d = r.data as Record<string, unknown>;
      const ds = datasets.find(x => x.id === r.datasetId);
      const tau = d.tau as number[];
      const gamma = d.gamma as number[];
      const traces: Plotly.Data[] = [{
        x: tau,
        y: gamma,
        mode: 'lines',
        name: `${ds?.filename ?? '?'} (${d.method})`,
        line: { color: COLORS[i % COLORS.length], width: 2 },
      }];
      // Add Bayesian confidence bounds
      if (d.lower_bound && d.upper_bound) {
        traces.push({
          x: [...tau, ...tau.slice().reverse()],
          y: [...(d.upper_bound as number[]), ...(d.lower_bound as number[]).slice().reverse()],
          fill: 'toself',
          fillcolor: `${COLORS[i % COLORS.length]}20`,
          line: { color: 'transparent' },
          name: `${ds?.filename ?? '?'} (bounds)`,
          showlegend: false,
        });
      }
      return traces;
    }).flat();
  }, [datasets, results]);

  if (traces.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af' }}>Run DRT to see distribution plot</div>;
  }

  return (
    <PlotlyChart
      data={traces}
      layout={{
        xaxis: { title: { text: '\u03c4 (s)' }, type: 'log' },
        yaxis: { title: { text: '\u03b3(\u03c4) (\u03a9)' } },
        margin: { l: 60, r: 20, t: 30, b: 50 },
        legend: { orientation: 'h', y: -0.2 },
      }}
      style={{ width: '100%', height: '100%', minHeight: 400 }}
    />
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h4 style={{ margin: 0, fontSize: '0.75rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</h4>;
}
function Label({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block', fontSize: '0.82rem', color: '#374151' }}><div style={{ marginBottom: '0.2rem' }}>{label}</div>{children}</label>;
}

const selectStyle: React.CSSProperties = { width: '100%', padding: '0.4rem', borderRadius: 6, border: '1px solid #d1d5db', fontSize: '0.82rem' };
const thStyle: React.CSSProperties = { textAlign: 'left', padding: '0.35rem 0.5rem', color: '#6b7280', fontSize: '0.78rem' };
const tdStyle: React.CSSProperties = { padding: '0.3rem 0.5rem' };
const primaryBtnStyle: React.CSSProperties = { width: '100%', padding: '0.5rem', borderRadius: 6, border: 'none', cursor: 'pointer', backgroundColor: '#3b82f6', color: 'white', fontWeight: 600, fontSize: '0.85rem' };
