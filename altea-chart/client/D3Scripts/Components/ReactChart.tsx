import * as React from 'react'
import { classes } from '@altea/altea/data/globals/index';
import type { ChartRow, ChartScriptProps, ChartTable } from '../../ChartClient';
import { useThrottle, useSize, areEqualDeps } from '@altea/altea/client/Hooks';
import { ChartRequestModel } from '../../../data/ChartRequest';
import type { DashboardFilter } from '../../DashboardFilterStub';

// Copy-and-fix of Signum.Chart/D3Scripts/Components/ReactChart.tsx. Fixes: @framework/* → altea paths,
// ../../Signum.Chart → ../../../data/ChartRequest, DashboardFilter → local stub, and Signum's
// `Record<ChartParameter, string>` (enum-keyed) → `Record<string, string>` (parameter name → value).

export interface ReactChartProps {
  chartRequest: ChartRequestModel,
  data?: ChartTable;
  parameters: Record<string, string>;
  loading: boolean;
  sizeDeps?: React.DependencyList;
  onReload: (() => void) | undefined;
  onDrillDown: (row: ChartRow, e: React.MouseEvent | MouseEvent) => void;
  onBackgroundClick?: (e: React.MouseEvent) => void;
  onRenderChart: (data: ChartScriptProps) => React.ReactNode;
  dashboardFilter?: DashboardFilter;
  minHeight: number | null;
}


function ReactChart(p: ReactChartProps): React.JSX.Element {

  const isSimple = p.data == null || p.data.rows.length < ReactChart.Options.maxRowsForAnimation;
  const oldData = useThrottle(p.data, 200, { enabled: isSimple });
  const initialLoad = oldData == null && p.data != null && isSimple;

  const memo = React.useMemo(() => new MemoRepository(), [p.chartRequest, p.chartRequest.chartScript]);

  const { size, setContainer } = useSize({ deps: p.sizeDeps });

  return (
    <div className={classes("sf-chart-container", isSimple ? "sf-chart-animable" : "")} style={{ minHeight: (p.minHeight ?? 300) + "px" }} ref={setContainer} onClick={p.onBackgroundClick}>
      {size &&
        p.onRenderChart({
          chartRequest: p.chartRequest,
          data: p.data,
          parameters: p.parameters,
          loading: p.loading,
          onDrillDown: p.onDrillDown,
          onReload: p.onReload,
          height: size.height,
          width: size.width,
          initialLoad: initialLoad,
          memo: memo,
          dashboardFilter: p.dashboardFilter
        })
      }
    </div>
  );
}

namespace ReactChart {
  export const Options = { maxRowsForAnimation: 500 };
}

export default ReactChart;

export class MemoRepository {
  cache: Map<string, { val: unknown, deps: unknown[] }> = new Map();

  memo<T>(name: string, deps: unknown[], factory: () => T): T {
    var box = this.cache.get(name);
    if (box == null || !areEqualDeps(box.deps, deps)) {
      box = {
        val: factory(),
        deps: deps,
      };
      this.cache.set(name, box);
    }

    return box.val as T;
  }
}
