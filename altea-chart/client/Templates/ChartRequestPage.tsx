import * as React from 'react'
import { useParams } from 'react-router'
import { Finder } from '@altea/altea/client/Finder'
import { useAPI } from '@altea/altea/client/Hooks'
import { SubTokensOptions } from '@altea/altea/data/dynamicQuery/tokens/queryToken'
import type { QueryToken } from '@altea/altea/data/dynamicQuery/tokens/queryToken'
import { QueryTokenEmbedded } from '@altea/altea-user-assets/data/Queries'
import { ChartRequestModel } from '../../data/ChartRequest'
import { ChartColumnEmbedded } from '../../data/ChartColumn'
import { D3ChartScript } from '../../data/ChartScript'
import { ChartClient } from '../ChartClient'
import ChartRenderer from './ChartRenderer'

// Minimal ChartRequestPage (MVP). Signum's full interactive editor (ChartRequestView + ChartBuilder + the
// per-token/-parameter line editors) is a further slice; for now this auto-builds a Columns chart for the
// route's query — grouping by `?token=` (default "Entity") with a Count aggregate — and renders it, so the
// whole pipeline (scripts endpoint → request → executeQuery → toChartResult → D3 render) is exercised.
export default function ChartRequestPage(): React.JSX.Element {
  const params = useParams();
  const queryName = params.queryName!;
  const keyTokenString = new URLSearchParams(window.location.search).get("token") ?? "Entity";

  const built = useAPI(async () => {
    const opts = SubTokensOptions.CanElement | SubTokensOptions.CanAggregate;
    const keyToken = await Finder.parseSingleToken(queryName, keyTokenString, opts);
    const valueToken = await Finder.parseSingleToken(queryName, "Count", opts);

    const mkCol = (t: QueryToken): ChartColumnEmbedded => {
      const qte = new QueryTokenEmbedded();
      qte.tokenString = t.fullKey();
      qte.token = t;
      const col = new ChartColumnEmbedded();
      col.token = qte;
      return col;
    };

    const cr = new ChartRequestModel();
    cr.queryKey = queryName;
    cr.chartScript = D3ChartScript.Columns;
    cr.filterOptions = [];
    cr.columns = [mkCol(keyToken), mkCol(valueToken)];

    const cs = await ChartClient.getChartScript(D3ChartScript.Columns);
    ChartClient.synchronizeColumns(cr, cs);
    return { cr, cs };
  }, [queryName, keyTokenString]);

  const data = useAPI(async () => {
    if (built == null) return undefined;
    const result = await ChartClient.API.executeChart(built.cr, built.cs);
    return result.chartTable;
  }, [built]);

  if (built == null)
    return <div className="m-3">Loading chart…</div>;

  return (
    <div className="m-3">
      <h4>{queryName}</h4>
      <ChartRenderer chartRequest={built.cr} data={data} loading={data == null} minHeight={400} />
    </div>
  );
}
