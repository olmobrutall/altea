import * as React from 'react'
import { Tab, Tabs } from 'react-bootstrap'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { classes } from '@altea/altea/data/globals/index'
import { Finder } from '@altea/altea/client/Finder'
import { TypeContext } from '@altea/altea/client/TypeContext'
import { getQueryNiceName } from '@altea/altea/client/Reflection'
import FilterBuilder from '@altea/altea/client/SearchControl/FilterBuilder'
import PinnedFilterBuilder from '@altea/altea/client/SearchControl/PinnedFilterBuilder'
import { ChartRequestModel } from '../../data/ChartRequest'
import type { IChartBase } from '../../data/ChartRequest'
import { ChartMessage } from '../../data/ChartMessage'
import ChartBuilder from './ChartBuilder'
import ChartRenderer from './ChartRenderer'
import "../Chart.css"
import { ChartClient } from '../ChartClient'
import { useForceUpdate, useAPI } from '@altea/altea/client/Hooks'
import { AutoFocus } from '@altea/altea/client/Components/AutoFocus'
import { SubTokensOptions } from '@altea/altea/data/dynamicQuery/tokens/queryToken'
import type { QueryToken } from '@altea/altea/data/dynamicQuery/tokens/queryToken'

// Partial port of Signum.Chart/Templates/ChartRequestView.tsx — the editor shell: filters + ChartBuilder +
// the Chart tab + the Draw/settings toolbar. altea divergences: no QueryDescription (FilterBuilder takes
// the query ROOT token from Finder.getQueryRoot); TypeContext.root(cr) replaces Signum's PropertyRoute.root
// + ReadonlyBinding. Deferred: UserChart, the Data tab (ChartTable), ChartTimeSeries, the fullscreen
// (Encoder) button, and Navigator.validateEntity (Draw executes directly; server errors surface normally).

interface ChartRequestViewProps {
  chartRequest: ChartRequestModel;
  onChange?: (cr: ChartRequestModel) => void;
  searchOnLoad?: boolean;
}

export default function ChartRequestView(p: ChartRequestViewProps): React.JSX.Element | null {
  const forceUpdate = useForceUpdate();
  const lastToken = React.useRef<QueryToken | undefined>(undefined);
  const [showChartSettings, setShowChartSettings] = React.useState(true);
  const [result, setResult] = React.useState<{ chartResult: ChartClient.API.ExecuteChartResult; chartRequest: ChartRequestModel } | undefined>(undefined);
  const [loading, setLoading] = React.useState(false);

  const cr = p.chartRequest;
  const queryRoot = useAPI(() => Finder.getQueryRoot(cr.queryKey), [cr.queryKey]);

  React.useEffect(() => {
    if (p.searchOnLoad && queryRoot != null)
      handleDraw();
  }, [queryRoot != null]);

  function removeObsoleteOrders() {
    cr.columns.filter(a => a.token == null).forEach(a => { a.orderByIndex = null; a.orderByType = null; });
  }

  function handleDraw() {
    removeObsoleteOrders();
    setLoading(true);
    ChartClient.getChartScript(cr.chartScript)
      .then(cs => ChartClient.API.executeChart(cr, cs))
      .then(rt => { setResult({ chartResult: rt, chartRequest: cr }); setLoading(false); p.onChange?.(cr); })
      .catch(e => { setLoading(false); throw e; });
  }

  if (queryRoot == null)
    return null;

  const tc = TypeContext.root(cr) as TypeContext<IChartBase>;
  const validResult = result && result.chartRequest == cr ? result : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
      <h1 className="h2">
        <span className="sf-entity-title">{getQueryNiceName(cr.queryKey)}</span>
      </h1>
      <div>
        {showChartSettings ?
          <FilterBuilder filterOptions={cr.filterOptions} queryToken={queryRoot}
            subTokensOptions={SubTokensOptions.CanAggregate | SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement}
            lastToken={lastToken.current} onTokenChanged={t => lastToken.current = t} showPinnedFiltersOptionsButton={true} /> :
          <AutoFocus>
            <PinnedFilterBuilder
              queryToken={queryRoot}
              filterOptions={cr.filterOptions}
              onFiltersChanged={() => handleDraw()} />
          </AutoFocus>
        }
      </div>
      <div className="sf-control-container">
        {showChartSettings &&
          <ChartBuilder queryKey={cr.queryKey} ctx={tc}
            onInvalidate={() => { setResult(undefined); forceUpdate(); }}
            onRedraw={() => { forceUpdate(); p.onChange?.(cr); }}
            onTokenChange={() => { removeObsoleteOrders(); forceUpdate(); }}
            onOrderChanged={() => { if (validResult) handleDraw(); else forceUpdate(); }}
          />}
      </div>
      <div className="sf-query-button-bar btn-toolbar my-2 bg-body rounded shadow-sm p-2">
        <button
          className={classes("sf-query-button btn", showChartSettings && "active", "btn-tertiary")}
          onClick={() => setShowChartSettings(!showChartSettings)}
          title={showChartSettings ? ChartMessage.HideChartSettings.niceToString() : ChartMessage.ShowChartSettings.niceToString()}>
          <FontAwesomeIcon aria-hidden={true} icon="sliders" />
        </button>
        <button type="submit" className="sf-query-button sf-chart-draw btn btn-primary" onClick={handleDraw}>{ChartMessage.DrawChart.niceToString()}</button>
      </div>
      <div className="sf-chart-tab-container">
        <Tabs id="chartResultTabs" key={showChartSettings + ""}>
          <Tab eventKey="chart" title={ChartMessage.Chart.niceToString()}>
            <ChartRenderer chartRequest={cr} loading={loading} data={validResult?.chartResult.chartTable} minHeight={null} />
          </Tab>
        </Tabs>
      </div>
    </div>
  );
}
