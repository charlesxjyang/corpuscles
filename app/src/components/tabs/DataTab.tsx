import { useMemo } from 'react';
import { FileDropZone } from '../FileDropZone';
import { PlotlyChart } from '../PlotlyChart';
import type { Dataset } from '../../types';

interface Props {
  datasets: Dataset[];
  onFileDrop: (file: File) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  pyodideReady: boolean;
  parsing: boolean;
  parseCount: number;
}

export function DataTab({ datasets, onFileDrop, onToggle, onRemove, pyodideReady, parsing, parseCount }: Props) {
  const selected = datasets.find(d => d.visible);

  const settings = (
    <>
      <FileDropZone onFileDrop={onFileDrop} disabled={!pyodideReady} />
      {parsing && (
        <div style={{ fontSize: '0.85rem', color: '#3b82f6' }}>
          Parsing {parseCount} file{parseCount > 1 ? 's' : ''}...
        </div>
      )}
      <DatasetList datasets={datasets} onToggle={onToggle} onRemove={onRemove} />
    </>
  );

  const results = (
    <div style={{ padding: '0.75rem' }}>
      {selected ? (
        <MetadataTable dataset={selected} />
      ) : (
        <div style={{ color: '#9ca3af', fontSize: '0.85rem', padding: '1rem' }}>
          Load a file to see metadata
        </div>
      )}
    </div>
  );

  const plots = selected ? (
    <DataPreviewPlot datasets={datasets.filter(d => d.visible)} />
  ) : (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af' }}>
      Drop files to see preview plots
    </div>
  );

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <aside style={{ width: 280, flexShrink: 0, borderRight: '1px solid #e5e7eb', backgroundColor: 'white', overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {settings}
      </aside>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ borderBottom: '1px solid #e5e7eb', overflow: 'auto', maxHeight: '35%', backgroundColor: 'white' }}>
          {results}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0.75rem', backgroundColor: '#f8fafc' }}>
          {plots}
        </div>
      </div>
    </div>
  );
}

// ---- Sub-components ----

const COLORS = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6',
];

function DatasetList({ datasets, onToggle, onRemove }: {
  datasets: Dataset[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (datasets.length === 0) return null;
  return (
    <div>
      <h3 style={{ margin: '0 0 0.4rem', fontSize: '0.8rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Datasets ({datasets.length})
      </h3>
      {datasets.map((ds, i) => (
        <div key={ds.id} style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem',
          padding: '0.35rem 0.5rem', borderRadius: 6, marginBottom: '0.2rem',
          backgroundColor: ds.visible ? '#f0f9ff' : '#f9fafb', fontSize: '0.82rem',
        }}>
          <input type="checkbox" checked={ds.visible} onChange={() => onToggle(ds.id)} />
          <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: COLORS[i % COLORS.length], flexShrink: 0 }} />
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ds.filename}</div>
            <div style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
              {ds.data.experimentType} | {ds.data.rowCount.toLocaleString()} pts
            </div>
          </div>
          <button onClick={() => onRemove(ds.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '1rem', padding: '0 0.2rem' }}>&times;</button>
        </div>
      ))}
    </div>
  );
}

function MetadataTable({ dataset }: { dataset: Dataset }) {
  const meta = dataset.data.metadata;
  const entries = [
    ...Object.entries(meta).filter(([, v]) => v && v !== 'None'),
    ['format', dataset.data.fileType],
    ['type', dataset.data.experimentType],
    ['points', String(dataset.data.rowCount)],
    ['columns', dataset.data.columns.join(', ')],
  ];

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
      <thead>
        <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
          <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem', color: '#6b7280' }}>Property</th>
          <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem', color: '#6b7280' }}>Value</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key} style={{ borderBottom: '1px solid #f3f4f6' }}>
            <td style={{ padding: '0.25rem 0.5rem', color: '#6b7280', whiteSpace: 'nowrap' }}>{key}</td>
            <td style={{ padding: '0.25rem 0.5rem', fontFamily: 'monospace', fontSize: '0.78rem', wordBreak: 'break-all' }}>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DataPreviewPlot({ datasets }: { datasets: Dataset[] }) {
  const isEIS = datasets.some(d => d.data.experimentType === 'eis');

  const traces = useMemo(() => {
    return datasets.map((ds, i) => {
      const d = ds.data.data;
      if (isEIS && d.z_real_ohm && d.z_imag_ohm) {
        return {
          x: d.z_real_ohm,
          y: (d.z_imag_ohm as number[]).map(v => -(v as number)),
          mode: 'markers' as const,
          name: ds.filename,
          marker: { color: COLORS[i % COLORS.length], size: 5 },
        };
      }
      if (d.voltage_v) {
        const q = d.capacity_ah || d.time_s || Array.from({ length: (d.voltage_v as number[]).length }, (_, j) => j);
        return {
          x: q,
          y: d.voltage_v,
          mode: 'lines' as const,
          name: ds.filename,
          line: { color: COLORS[i % COLORS.length], width: 1.5 },
        };
      }
      return null;
    }).filter(Boolean) as Plotly.Data[];
  }, [datasets, isEIS]);

  const layout: Partial<Plotly.Layout> = isEIS
    ? { xaxis: { title: { text: "Z' (\u03a9)" }, scaleanchor: 'y' }, yaxis: { title: { text: "-Z'' (\u03a9)" } } }
    : { xaxis: { title: { text: 'Capacity (Ah)' } }, yaxis: { title: { text: 'Voltage (V)' } } };

  return <PlotlyChart data={traces} layout={layout} style={{ width: '100%', height: '100%', minHeight: 400 }} />;
}
