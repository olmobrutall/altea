import * as React from 'react'
import { useParams, useLocation } from 'react-router'
import { Finder } from '@altea/altea/client/Finder'
import * as AppContext from '@altea/altea/client/AppContext'
import { QueryString } from '@altea/altea/client/QueryString'
import { SubTokensOptions, getSubTokens } from '@altea/altea/data/dynamicQuery/tokens/queryToken'
import type { QueryToken } from '@altea/altea/data/dynamicQuery/tokens/queryToken'
import { Lite } from '@altea/altea/data/lite'
import { QueryTokenEmbedded } from '@altea/altea-user-assets/data/Queries'
import { ChartRequestModel } from '../../data/ChartRequest'
import type { UserChartEntity } from '../../data/UserChart'
import { ChartColumnEmbedded } from '../../data/ChartColumn'
import { D3ChartScript } from '../../data/ChartScript'
import { ChartClient } from '../ChartClient'
import ChartRequestView from './ChartRequestView'

// ChartRequestPage — the /chart/:queryName route. Keeps the chart <-> URL in sync (Signum's
// ChartRequestPage): the request is decoded FROM the URL (Encoder/Decoder), and every change in the editor
// re-encodes the request and REPLACEs the address bar — so the chart is bookmarkable/shareable and
// back/forward work. The location effect only re-decodes when the URL genuinely differs from the current
// request's encoded path (an external URL change), so onChange's own replace doesn't rebuild the editor.
export default function ChartRequestPage(): React.JSX.Element {
  const params = useParams();
  const location = useLocation();
  const queryName = params.queryName!;

  const [cr, setCr] = React.useState<ChartRequestModel | undefined>(undefined);
  // The saved UserChart the current request is associated with (from the `userChart=` URL param, or set by
  // the UserChartMenu on create/select). Threaded into the encoded path so it round-trips.
  const [userChart, setUserChart] = React.useState<Lite<UserChartEntity> | undefined>(undefined);

  React.useEffect(() => {
    const newPath = location.pathname + location.search;
    // The current request's own encoded path — if the URL already matches it (e.g. we just replaced it from
    // onChange, or the editor mutated `cr` in place), there is nothing to reload.
    const oldPathPromise: Promise<string | undefined> = cr ? ChartClient.Encoder.chartPathPromise(cr, userChart) : Promise.resolve(undefined);
    oldPathPromise.then(oldPath => {
      if (oldPath != newPath) {
        buildRequest(queryName, location.search).then(setCr);
        const ucKey = QueryString.parse(location.search).userChart as string | undefined;
        setUserChart(ucKey ? (Lite.parse(ucKey) as Lite<UserChartEntity>) : undefined);
      }
    });
    // `cr` is intentionally NOT a dep: onChange mutates the SAME instance + replaces the URL, so the effect
    // (re-run by the search change) sees oldPath == newPath and skips — no rebuild/reset of the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search, queryName]);

  // Editor changed the chart (draw / token / order / parameter, or the UserChartMenu applied/created one) →
  // reflect it in the URL (replace, so the editing session is one history entry).
  function handleChange(changed: ChartRequestModel, uc: Lite<UserChartEntity> | undefined): void {
    setCr(changed);
    setUserChart(uc);
    ChartClient.Encoder.chartPathPromise(changed, uc)
      .then(path => AppContext.navigate(path, { replace: true }));
  }

  if (cr == null)
    return <div className="m-3">Loading chart…</div>;

  return (
    <div className="m-3">
      <ChartRequestView chartRequest={cr} userChart={userChart} searchOnLoad onChange={handleChange} />
    </div>
  );
}

// Build the ChartRequestModel for the current URL: an encoded chart (script / column0 present) is
// reconstructed via the Decoder; otherwise a sensible default (a Columns chart grouped by `?token=` — or
// the first meaningful categorical column — with a Count aggregate).
async function buildRequest(queryName: string, search: string): Promise<ChartRequestModel> {
  const query = QueryString.parse(search);
  if (query.column0 != null || query.script != null)
    return await ChartClient.Decoder.parseChartRequest(queryName, query);

  const keyTokenParam = query.token as string | undefined;
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
}
