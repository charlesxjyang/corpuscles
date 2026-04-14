import { useState, useMemo } from 'react';
import { AnalysisLayout } from '../AnalysisLayout';
import { PlotlyChart } from '../PlotlyChart';
import type { Dataset, AnalysisResult } from '../../types';

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'];

const PRESET_CIRCUITS = [
  { label: 'Auto (best fit)', value: '__auto__', guess: [] },
  { label: 'Randles + CPE', value: 'R0-p(R1,CPE1)-W1', guess: [] },
  { label: 'R-CPE', value: 'R0-p(R1,CPE1)', guess: [] },
  { label: 'Randles', value: 'R0-p(R1,C1)-W1', guess: [] },
  { label: 'R-RC', value: 'R0-p(R1,C1)', guess: [] },
  { label: 'R-RC-RC', value: 'R0-p(R1,C1)-p(R2,C2)', guess: [] },
  { label: 'Custom', value: '__custom__', guess: [] },
];

interface Props {
  datasets: Dataset[];
  results: AnalysisResult[];
  onAnalyze: (datasetId: string, type: string, params: Record<string, unknown>) => void;
  analyzing: boolean;
}

export function FittingTab({ datasets, results, onAnalyze, analyzing }: Props) {
  const [selectedDataset, setSelectedDataset] = useState<string>(datasets[0]?.id ?? '');
  const [presetIdx, setPresetIdx] = useState(0);
  const [circuitString, setCircuitString] = useState('');
  const [initialGuess, setInitialGuess] = useState('');
  const [globalOpt, setGlobalOpt] = useState(false);

  const isAuto = PRESET_CIRCUITS[presetIdx].value === '__auto__';
  const isCustom = PRESET_CIRCUITS[presetIdx].value === '__custom__';

  const eisDatasets = datasets.filter(d => d.data.experimentType === 'eis' && d.visible);
  const fitResults = results.filter(r => r.type === 'circuit_fit' && r.status === 'completed');

  const handlePresetChange = (idx: number) => {
    setPresetIdx(idx);
    const p = PRESET_CIRCUITS[idx];
    if (p.value !== '__auto__' && p.value !== '__custom__') {
      setCircuitString(p.value);
    }
  };

  const handleRun = () => {
    if (!selectedDataset) return;
    const guess = initialGuess.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    const fitParams: Record<string, unknown> = {
      auto_fit: isAuto,
      global_opt: globalOpt,
    };
    if (!isAuto) {
      fitParams.circuit_string = isCustom ? circuitString : PRESET_CIRCUITS[presetIdx].value;
      if (guess.length > 0) fitParams.initial_guess = guess;
    }
    onAnalyze(selectedDataset, 'circuit_fit', fitParams);
  };

  const settings = (
    <>
      <SectionHeader>Dataset</SectionHeader>
      <select value={selectedDataset} onChange={e => setSelectedDataset(e.target.value)} style={selectStyle}>
        {eisDatasets.map(ds => <option key={ds.id} value={ds.id}>{ds.filename}</option>)}
      </select>

      <SectionHeader>Circuit</SectionHeader>
      <Label label="Mode">
        <select value={presetIdx} onChange={e => handlePresetChange(Number(e.target.value))} style={selectStyle}>
          {PRESET_CIRCUITS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
        </select>
      </Label>
      {isAuto && (
        <div style={{ fontSize: '0.75rem', color: '#6b7280', padding: '0.3rem', backgroundColor: '#f0f9ff', borderRadius: 4 }}>
          Tries R-CPE, Randles, Randles+CPE, R-RC, R-RC-RC and picks the best fit automatically.
        </div>
      )}
      {!isAuto && (
        <>
          <Label label="Circuit string (CDC)">
            <input
              type="text"
              value={isCustom ? circuitString : PRESET_CIRCUITS[presetIdx].value}
              onChange={e => setCircuitString(e.target.value)}
              readOnly={!isCustom}
              placeholder="R0-p(R1,CPE1)-W1"
              style={{ ...selectStyle, fontFamily: 'monospace', backgroundColor: isCustom ? 'white' : '#f3f4f6' }}
            />
          </Label>
          <div style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
            Elements: R, C, L, W, Wo, Ws, CPE, Zarc, TLMQ
            <br />Series: - &nbsp; Parallel: p(X,Y)
          </div>
          <Label label="Initial guess (leave blank for auto)">
            <input
              type="text"
              value={initialGuess}
              onChange={e => setInitialGuess(e.target.value)}
              placeholder="auto-estimated from data"
              style={{ ...selectStyle, fontFamily: 'monospace', fontSize: '0.78rem' }}
            />
          </Label>
        </>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: '#374151' }}>
        <input type="checkbox" checked={globalOpt} onChange={e => setGlobalOpt(e.target.checked)} />
        Global optimization (slower, avoids local minima)
      </label>

      <button onClick={handleRun} disabled={analyzing || !selectedDataset} style={primaryBtnStyle}>
        {analyzing ? 'Fitting...' : 'Fit Circuit'}
      </button>
    </>
  );

  const latestFit = fitResults[fitResults.length - 1];
  const resultsTable = (
    <div style={{ padding: '0.5rem' }}>
      {!latestFit ? (
        <div style={{ color: '#9ca3af', fontSize: '0.85rem', padding: '1rem' }}>Define a circuit and run fitting</div>
      ) : (
        <FitParamsTable result={latestFit} datasets={datasets} />
      )}
    </div>
  );

  const plots = <FittingPlots datasets={eisDatasets} results={fitResults} />;

  return <AnalysisLayout settings={settings} results={resultsTable} plots={plots} />;
}

function FitParamsTable({ result, datasets }: { result: AnalysisResult; datasets: Dataset[] }) {
  const d = result.data as Record<string, unknown>;
  const ds = datasets.find(x => x.id === result.datasetId);
  const names = d.param_names as string[];
  const units = d.param_units as string[];
  const values = d.param_values as number[];
  const conf = d.param_conf as number[] | null;

  return (
    <div>
      <div style={{ fontSize: '0.78rem', color: '#6b7280', marginBottom: '0.3rem' }}>
        {ds?.filename} | <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{d.circuit_string as string}</span>
        {d.auto_fit ? ' (auto-selected)' : ''} | RMSE: {((d.residual_rmse as number) * 100).toFixed(1)}%
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
            <th style={thStyle}>Parameter</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>Value</th>
            <th style={thStyle}>Unit</th>
            {conf && <th style={{ ...thStyle, textAlign: 'right' }}>1\u03c3 conf</th>}
          </tr>
        </thead>
        <tbody>
          {names.map((name, i) => (
            <tr key={name} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ ...tdStyle, fontWeight: 500 }}>{name}</td>
              <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace' }}>{values[i].toExponential(4)}</td>
              <td style={{ ...tdStyle, color: '#6b7280' }}>{units[i]}</td>
              {conf && <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'monospace', color: '#9ca3af' }}>{conf[i]?.toExponential(2) ?? '-'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FittingPlots({ datasets, results }: { datasets: Dataset[]; results: AnalysisResult[] }) {
  const traces = useMemo(() => {
    const t: Plotly.Data[] = [];
    datasets.forEach((ds, i) => {
      const d = ds.data.data;
      if (!d.z_real_ohm || !d.z_imag_ohm) return;
      t.push({
        x: d.z_real_ohm,
        y: (d.z_imag_ohm as number[]).map(v => -(v as number)),
        mode: 'markers',
        name: ds.filename,
        marker: { color: COLORS[i % COLORS.length], size: 5 },
      });
    });
    results.forEach((r, i) => {
      const d = r.data as Record<string, unknown>;
      const ds = datasets.find(x => x.id === r.datasetId);
      t.push({
        x: d.z_fit_real as number[],
        y: (d.z_fit_imag as number[]).map(v => -(v as number)),
        mode: 'lines',
        name: `Fit: ${d.circuit_string} (${ds?.filename ?? '?'})`,
        line: { color: COLORS[i % COLORS.length], width: 2, dash: 'dash' },
      });
    });
    return t;
  }, [datasets, results]);

  if (traces.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af' }}>Load EIS data and fit a circuit</div>;
  }

  return (
    <PlotlyChart
      data={traces}
      layout={{
        xaxis: { title: { text: "Z' (\u03a9)" }, scaleanchor: 'y' },
        yaxis: { title: { text: "-Z'' (\u03a9)" } },
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
