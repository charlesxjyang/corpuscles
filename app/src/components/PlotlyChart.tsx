import { useEffect, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';

interface Props {
  data: Plotly.Data[];
  layout?: Partial<Plotly.Layout>;
  config?: Partial<Plotly.Config>;
  style?: React.CSSProperties;
}

export function PlotlyChart({ data, layout = {}, config = {}, style }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;

    const mergedLayout: Partial<Plotly.Layout> = {
      autosize: true,
      margin: { l: 60, r: 40, t: 30, b: 50 },
      legend: { orientation: 'h', y: -0.15 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: '#fefefe',
      font: { family: 'system-ui, -apple-system, sans-serif' },
      ...layout,
    };

    const mergedConfig: Partial<Plotly.Config> = {
      responsive: true,
      displayModeBar: true,
      displaylogo: false,
      ...config,
    };

    Plotly.react(ref.current, data, mergedLayout, mergedConfig);

    return () => {
      if (ref.current) {
        Plotly.purge(ref.current);
      }
    };
  }, [data, layout, config]);

  return <div ref={ref} style={style} />;
}
