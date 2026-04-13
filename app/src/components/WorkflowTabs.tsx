import type { WorkflowTab } from '../types';

const TABS: { key: WorkflowTab; label: string; description: string }[] = [
  { key: 'data', label: 'Data Sets', description: 'Import and inspect data' },
  { key: 'kramers-kronig', label: 'Kramers-Kronig', description: 'Validate data quality' },
  { key: 'drt', label: 'DRT', description: 'Distribution of relaxation times' },
  { key: 'fitting', label: 'Fitting', description: 'Equivalent circuit fitting' },
  { key: 'plotting', label: 'Plotting', description: 'Compare and export' },
];

interface Props {
  activeTab: WorkflowTab;
  onTabChange: (tab: WorkflowTab) => void;
  hasData: boolean;
}

export function WorkflowTabs({ activeTab, onTabChange, hasData }: Props) {
  return (
    <nav style={{
      display: 'flex',
      gap: 0,
      borderBottom: '2px solid #e5e7eb',
      backgroundColor: 'white',
      paddingLeft: '1rem',
    }}>
      {TABS.map((tab, i) => {
        const isActive = activeTab === tab.key;
        const isDisabled = tab.key !== 'data' && !hasData;
        return (
          <button
            key={tab.key}
            onClick={() => !isDisabled && onTabChange(tab.key)}
            disabled={isDisabled}
            title={tab.description}
            style={{
              padding: '0.65rem 1.25rem',
              border: 'none',
              borderBottom: isActive ? '2px solid #3b82f6' : '2px solid transparent',
              marginBottom: '-2px',
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              backgroundColor: 'transparent',
              color: isActive ? '#3b82f6' : isDisabled ? '#d1d5db' : '#6b7280',
              fontWeight: isActive ? 600 : 400,
              fontSize: '0.9rem',
              transition: 'all 0.15s ease',
              position: 'relative',
            }}
          >
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}>
              <span style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                backgroundColor: isActive ? '#3b82f6' : isDisabled ? '#e5e7eb' : '#d1d5db',
                color: isActive ? 'white' : isDisabled ? '#9ca3af' : '#6b7280',
                fontSize: '0.7rem',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
              }}>
                {i + 1}
              </span>
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
