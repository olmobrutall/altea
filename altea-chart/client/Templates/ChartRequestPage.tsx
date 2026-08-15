import * as React from 'react'
import { useParams } from 'react-router'
import { Finder } from '@altea/altea/client/Finder'
import { useAPI } from '@altea/altea/client/Hooks'
import { SubTokensOptions, getSubTokens } from '@altea/altea/data/dynamicQuery/tokens/queryToken'
import type { QueryToken } from '@altea/altea/data/dynamicQuery/tokens/queryToken'
import { QueryTokenEmbedded } from '@altea/altea-user-assets/data/Queries'
import { ChartRequestModel } from '../../data/ChartRequest'
import { ChartColumnEmbedded } from '../../data/ChartColumn'
import { D3ChartScript } from '../../data/ChartScript'
import { ChartClient } from '../ChartClient'
import ChartRequestView from './ChartRequestView'

// ChartRequestPage — the /chart/:queryName route. Builds an initial ChartRequestModel for the query (a
// Columns chart grouped by `?token=` — default: the first meaningful categorical column — with a Count
// aggregate) and hands it to the interactive editor (ChartRequestView), which draws on load and lets the
// user change the chart type, bind tokens, edit parameters, and add filters. (Signum reaches this page via
// the Decoder from the URL query string; that round-trip is deferred — the initial model is built here.)
export default function ChartRequestPage(): React.JSX.Element {
  const params = useParams();
  const queryName = params.queryName!;
  const keyTokenParam = new URLSearchParams(window.location.search).get("token");

  const built = useAPI(async () => {
    const opts = SubTokensOptions.CanElement | SubTokensOptions.CanAggregate;
    // Key = the `?token=` column if given, else a sensible default from the query's columns: prefer a
    // categorical column (entity / enum / string) for a meaningful grouping, else the first non-Id
    // groupable column, else any groupable one.
    let keyToken: QueryToken;
    if (keyTokenParam != null) {
      keyToken = await Finder.parseSingleToken(queryName, keyTokenParam, opts);
    } else {
      const cols = await getSubTokens(await Finder.getQueryRoot(queryName), SubTokensOptions.CanElement);
      const groupable = cols.filter(t => t.isGroupable);
      // Prefer an entity-reference or enum column (low-cardinality, meaningful group key); avoid the unique
      // Id / ToStr columns; else any groupable column.
      keyToken = groupable.find(t => t.filterType == "Lite" || t.filterType == "Enum")
        ?? groupable.find(t => t.key != "Id" && t.key != "ToStr")
        ?? groupable[0];
    }
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
    return cr;
  }, [queryName, keyTokenParam]);

  if (built == null)
    return <div className="m-3">Loading chart…</div>;

  return (
    <div className="m-3">
      <ChartRequestView chartRequest={built} searchOnLoad />
    </div>
  );
}
