import * as React from 'react'
import "../Chart.css"
import { ChartClient } from '../ChartClient';
import type { ChartRow, ChartScriptProps, ChartTable } from '../ChartClient';
import type { ChartRequestModel } from '../../data/ChartRequest';
import { ErrorBoundary } from '@altea/altea/client/Components';
import ReactChart from '../D3Scripts/Components/ReactChart';
import { useAPI } from '@altea/altea/client/Hooks';
import { Navigator } from '@altea/altea/client/Navigator';
import { Finder } from '@altea/altea/client/Finder';
import { toAbsoluteUrl } from '@altea/altea/client/AppContext';
import type { DashboardFilter } from '../DashboardFilterStub';

// Partial port of Signum.Chart/Templates/ChartRenderer.tsx — resolves the chart's renderer component +
// script (by symbol) and paints it via ReactChart. Clicking a chart mark drills down (handleDrillDown):
// a row backed by a single entity opens that entity; otherwise it explores the underlying query filtered by
// the row's key columns (ChartClient.extractFindOptions). altea divergences (MVP): Signum's
// FullscreenComponent wrapper, the UserChart cross-filter (onDrilldownUserChart), and autoRefresh are deferred.
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
          onDrillDown={p.onDrillDown ?? ((r, e) => handleDrillDown(r, e, p.chartRequest, p.onReload as (() => void) | undefined))}
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

// Copy-and-fix of Signum's ChartRenderer.handleDrillDown (minus the UserChart cross-filter). Ctrl / middle
// click opens in a new tab. A row backed by a single entity (r.entity, non-grouped charts) views that
// entity; otherwise explore the underlying query filtered by the row's key columns.
export function handleDrillDown(r: ChartRow, e: React.MouseEvent | MouseEvent, cr: ChartRequestModel, onReload?: () => void): void {

  e.stopPropagation();
  const newWindow = (e as MouseEvent).ctrlKey || (e as MouseEvent).button == 1;

  if (r.entity) {
    if (newWindow)
      window.open(toAbsoluteUrl(Navigator.navigateRoute(r.entity)));
    else
      Navigator.view(r.entity).then(() => onReload?.());
  } else {
    const fo = ChartClient.extractFindOptions(cr, r);
    if (newWindow)
      window.open(toAbsoluteUrl(Finder.findOptionsPath(fo)));
    else
      Finder.explore(fo).then(() => onReload?.());
  }
}
