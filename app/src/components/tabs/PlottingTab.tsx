import { useState, useMemo } from 'react';
import { PlotlyChart } from '../PlotlyChart';
import type { Dataset, AnalysisResult } from '../../types';

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6'];

type PlotType = 'nyquist' | 'bode_mag' | 'bode_phase' | 'drt' | 'residuals';

interface PlotSeries {
  id: string;
  label: string;
  source: 'dataset' | 'fit' | 'kk' | 'drt';
  datasetId: string;
  resultId?: string;
  enabled: boolean;
}

interface Props {
  datasets: Dataset[];
  results: AnalysisResult[];
}

export function PlottingTab({ datasets, results }: Props) {
  const [plotType, setPlotType] = useState<PlotType>('nyquist');

  // Build list of all plottable series
  const allSeries = useMemo(() => {
    const series: PlotSeries[] = [];
    datasets.filter(d => d.visible).forEach(ds => {
      if (ds.data.experimentType === 'eis') {
        series.push({ id: `data_${ds.id}`, label: ds.filename, source: 'dataset', datasetId: ds.id, enabled: true });
      }
    });
    results.filter(r => r.status === 'completed').forEach(r => {
      const ds = datasets.find(d => d.id === r.datasetId);
      const name = ds?.filename ?? '?';
      if (r.type === 'circuit_fit') {
        const d = r.data as Record<string, unknown>;
        series.push({ id: `fit_${r.id}`, label: `Fit: ${d.circuit_string} (${name})`, source: 'fit', datasetId: r.datasetId, resultId: r.id, enabled: true });
      }
      if (r.type === 'kramers_kronig') {
        series.push({ id: `kk_${r.id}`, label: `KK (${name})`, source: 'kk', datasetId: r.datasetId, resultId: r.id, enabled: true });
      }
      if (r.type.startsWith('drt_')) {
        const d = r.data as Record<string, unknown>;
        series.push({ id: `drt_${r.id}`, label: `DRT ${d.method} (${name})`, source: 'drt', datasetId: r.datasetId, resultId: r.id, enabled: true });
      }
    });
    return series;
  }, [datasets, results]);

  const [enabledSeries, setEnabledSeries] = useState<Set<string>>(new Set(allSeries.map(s => s.id)));

  const toggleSeries = (id: string) => {
    setEnabledSeries(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const activeSeries = allSeries.filter(s => enabledSeries.has(s.id));

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Left: series selection */}
      <aside style={{ width: 300, flexShrink: 0, borderRight: '1px solid #e5e7eb', backgroundColor: 'white', overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <h4 style={{ margin: 0, fontSize: '0.75rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Plot Type</h4>
        <select value={plotType} onChange={e => setPlotType(e.target.value as PlotType)} style={selectStyle}>
          <option value="nyquist">Nyquist</option>
          <option value="bode_mag">Bode (magnitude)</option>
          <option value="bode_phase">Bode (phase)</option>
          <option value="drt">DRT overlay</option>
          <option value="residuals">Residuals</option>
        </select>

        <h4 style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Series</h4>
        {allSeries.map((s, i) => (
          <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={enabledSeries.has(s.id)} onChange={() => toggleSeries(s.id)} />
            <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: COLORS[i % COLORS.length], flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
          </label>
        ))}

        {allSeries.length === 0 && (
          <div style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Load data and run analyses to add series</div>
        )}
      </aside>

      {/* Right: plot */}
      <div style={{ flex: 1, padding: '0.75rem', backgroundColor: '#f8fafc', overflow: 'auto' }}>
        <ComposedPlot
          plotType={plotType}
          series={activeSeries}
          datasets={datasets}
          results={results}
        />
      </div>
    </div>
  );
}

function ComposedPlot({ plotType, series, datasets, results }: {
  plotType: PlotType;
  series: PlotSeries[];
  datasets: Dataset[];
  results: AnalysisResult[];
}) {
  const traces = useMemo(() => {
    const t: Plotly.Data[] = [];

    series.forEach((s, i) => {
      const color = COLORS[i % COLORS.length];
      const ds = datasets.find(d => d.id === s.datasetId);
      if (!ds) return;
      const dd = ds.data.data;

      if (plotType === 'nyquist') {
        if (s.source === 'dataset' && dd.z_real_ohm && dd.z_imag_ohm) {
          t.push({
            x: dd.z_real_ohm,
            y: (dd.z_imag_ohm as number[]).map(v => -(v as number)),
            mode: 'markers', name: s.label, marker: { color, size: 5 },
          });
        }
        if ((s.source === 'fit' || s.source === 'kk') && s.resultId) {
          const r = results.find(x => x.id === s.resultId);
          if (r) {
            const rd = r.data as Record<string, unknown>;
            t.push({
              x: rd.z_fit_real as number[],
              y: (rd.z_fit_imag as number[]).map(v => -(v as number)),
              mode: 'lines', name: s.label, line: { color, width: 2, dash: 'dash' },
            });
          }
        }
      }

      if (plotType === 'bode_mag' || plotType === 'bode_phase') {
        if (s.source === 'dataset' && dd.frequency_hz && dd.z_real_ohm && dd.z_imag_ohm) {
          const freq = dd.frequency_hz as number[];
          const zr = dd.z_real_ohm as number[];
          const zi = dd.z_imag_ohm as number[];
          const y = plotType === 'bode_mag'
            ? zr.map((r, j) => Math.sqrt(r * r + zi[j] * zi[j]))
            : zr.map((r, j) => Math.atan2(zi[j], r) * 180 / Math.PI);
          t.push({
            x: freq, y, mode: 'lines+markers', name: s.label,
            marker: { color, size: 3 }, line: { color },
          });
        }
      }

      if (plotType === 'drt' && s.source === 'drt' && s.resultId) {
        const r = results.find(x => x.id === s.resultId);
        if (r) {
          const rd = r.data as Record<string, unknown>;
          t.push({
            x: rd.tau as number[],
            y: rd.gamma as number[],
            mode: 'lines', name: s.label, line: { color, width: 2 },
          });
        }
      }
    });

    return t;
  }, [plotType, series, datasets, results]);

  const layoutMap: Record<PlotType, Partial<Plotly.Layout>> = {
    nyquist: { xaxis: { title: { text: "Z' (\u03a9)" }, scaleanchor: 'y' }, yaxis: { title: { text: "-Z'' (\u03a9)" } } },
    bode_mag: { xaxis: { title: { text: 'Frequency (Hz)' }, type: 'log' }, yaxis: { title: { text: '|Z| (\u03a9)' }, type: 'log' } },
    bode_phase: { xaxis: { title: { text: 'Frequency (Hz)' }, type: 'log' }, yaxis: { title: { text: 'Phase (\u00b0)' } } },
    drt: { xaxis: { title: { text: '\u03c4 (s)' }, type: 'log' }, yaxis: { title: { text: '\u03b3(\u03c4) (\u03a9)' } } },
    residuals: { xaxis: { title: { text: 'Frequency (Hz)' }, type: 'log' }, yaxis: { title: { text: 'Residual (%)' } } },
  };

  if (traces.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af' }}>Select series to plot</div>;
  }

  return (
    <PlotlyChart
      data={traces}
      layout={{
        ...layoutMap[plotType],
        margin: { l: 60, r: 20, t: 30, b: 50 },
        legend: { orientation: 'h', y: -0.15 },
      }}
      style={{ width: '100%', height: '100%', minHeight: 500 }}
    />
  );
}

const selectStyle: React.CSSProperties = { width: '100%', padding: '0.4rem', borderRadius: 6, border: '1px solid #d1d5db', fontSize: '0.82rem' };
