import * as React from 'react'
import "../Chart.css"
import { ChartClient } from '../ChartClient';
import type { ChartRow, ChartScriptProps, ChartTable } from '../ChartClient';
import type { ChartRequestModel } from '../../data/ChartRequest';
import { ErrorBoundary } from '@altea/altea/client/Components';
import ReactChart from '../D3Scripts/Components/ReactChart';
import { useAPI } from '@altea/altea/client/Hooks';
import type { DashboardFilter } from '../DashboardFilterStub';

// Partial port of Signum.Chart/Templates/ChartRenderer.tsx — resolves the chart's renderer component +
// script (by symbol) and paints it via ReactChart. altea divergences (MVP): Signum's FullscreenComponent
// wrapper, UserChart drill-down (handleDrillDown → onDrilldownUserChart), and autoRefresh are deferred; a
// drill-down with no handler is a no-op.
export interface ChartRendererProps {
  chartRequest: ChartRequestModel;
  loading: boolean;
  data?: ChartTable;
  onReload?: (e?: React.MouseEvent<any>) => void;
  dashboardFilter?: DashboardFilter;
  onDrillDown?: (row: ChartRow, e: React.MouseEvent | MouseEvent) => void;
  onBackgroundClick?: (e: React.MouseEvent) => void;
  minHeight: number | null;
}

export default function ChartRenderer(p: ChartRendererProps): React.JSX.Element {
  const cs = useAPI(async () => {
    const chartScript = await ChartClient.getChartScript(p.chartRequest.chartScript);
    const chartComponentModule = await ChartClient.getRegisteredChartScriptComponent(p.chartRequest.chartScript)();
    return { chartComponent: chartComponentModule.default, chartScript };
  }, [p.chartRequest.chartScript]);

  var parameters = cs && ChartClient.API.getParameterWithDefault(p.chartRequest, cs.chartScript);

  return (
    <ErrorBoundary deps={[p.data]}>
      {cs && parameters &&
        <ReactChart
          chartRequest={p.chartRequest}
          data={p.data}
          dashboardFilter={p.dashboardFilter}
          loading={p.loading}
          onDrillDown={p.onDrillDown ?? (() => { })}
          onBackgroundClick={p.onBackgroundClick}
          parameters={parameters}
          onReload={p.onReload as (() => void) | undefined}
          onRenderChart={cs.chartComponent as ((p: ChartScriptProps) => React.ReactNode)}
          minHeight={p.minHeight}
        />
      }
    </ErrorBoundary>
  );
}
