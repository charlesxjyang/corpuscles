import type { ReactNode } from 'react';

interface Props {
  settings: ReactNode;
  results: ReactNode;
  plots: ReactNode;
  settingsWidth?: number;
}

export function AnalysisLayout({
  settings,
  results,
  plots,
  settingsWidth = 280,
}: Props) {
  return (
    <div style={{
      display: 'flex',
      flex: 1,
      minHeight: 0,
      height: '100%',
    }}>
      {/* Settings panel (left) */}
      <aside style={{
        width: settingsWidth,
        flexShrink: 0,
        borderRight: '1px solid #e5e7eb',
        backgroundColor: 'white',
        overflowY: 'auto',
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      }}>
        {settings}
      </aside>

      {/* Main area: results table (top) + plots (bottom) */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'auto',
      }}>
        {/* Results table */}
        <div style={{
          borderBottom: '1px solid #e5e7eb',
          overflow: 'auto',
          maxHeight: '35%',
          backgroundColor: 'white',
        }}>
          {results}
        </div>

        {/* Plots */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: '0.75rem',
          backgroundColor: '#f8fafc',
        }}>
          {plots}
        </div>
      </div>
    </div>
  );
}
