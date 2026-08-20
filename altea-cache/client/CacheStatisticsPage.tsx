import * as React from 'react'
import { Tab, Tabs } from 'react-bootstrap'
import { useAPIWithReload } from '@altea/altea/client/Hooks'
import { CacheMessage } from '../data/CacheMessage'
import type { CacheStateTS, CacheTableTS } from '../data/CacheState'
import { CacheClient } from './CacheClient'

// Port of Signum's CacheStatisticsPage (Signum.Caching/CacheStatisticsPage.tsx): the cached tables and
// global lazies with their hit / invalidation / load statistics, plus Enable / Disable / Clear.
// altea divergences: plain `<table>` (altea has no AccessibleTable component yet) and no
// "Invalidation exceptions" tab — that tab searches ExceptionEntity by `controllerName`, which altea's
// broadcast transports do not write (a failed broadcast is swallowed by design, see SimpleHttpBroadcast).
export default function CacheStatisticsPage(): React.JSX.Element {

    const [state, reloadState] = useAPIWithReload(() => CacheClient.API.view(), [], { avoidReset: true });

    if (state == null)
        return <div className="m-3"><h1 className="h2">{CacheMessage.Loading.niceToString()}…</h1></div>;

    return (
        <div className="m-3">
            <h1 className="h2">{CacheMessage.CacheStatistics.niceToString()}</h1>
            <div className="btn-toolbar gap-2">
                {state.isEnabled
                    ? <button type="button" onClick={() => void CacheClient.API.disable().then(() => reloadState())}
                        className="sf-button btn btn-tertiary" style={{ color: "var(--bs-danger)" }}>
                        {CacheMessage.Disable.niceToString()}
                    </button>
                    : <button type="button" onClick={() => void CacheClient.API.enable().then(() => reloadState())}
                        className="sf-button btn btn-tertiary" style={{ color: "var(--bs-success)" }}>
                        {CacheMessage.Enable.niceToString()}
                    </button>}
                <button type="button" onClick={() => void CacheClient.API.clear().then(() => reloadState())}
                    className="sf-button btn btn-tertiary" style={{ color: "var(--bs-primary)" }}>
                    {CacheMessage.Clear.niceToString()}
                </button>
            </div>
            <div className="m-2">
                <strong>{CacheMessage.ServerBroadcast.niceToString()}:</strong> <code>{state.serverBroadcast ?? "—"}</code>
                <br />
                <strong>{CacheMessage.SqlDependency.niceToString()}:</strong> <code>{state.sqlDependency.toString()}</code>
            </div>
            <Tabs id="cacheTabs">
                <Tab title={CacheMessage.Tables.niceToString()} eventKey="table">
                    {renderTables(state)}
                </Tab>
                <Tab title={CacheMessage.Lazies.niceToString()} eventKey="lazy">
                    {renderLazies(state)}
                </Tab>
            </Tabs>
        </div>
    );

    function renderTables(state: CacheStateTS): React.JSX.Element {
        return (
            <table className="table table-sm" aria-label={CacheMessage.TableStats.niceToString()}>
                <thead>
                    <tr>
                        <th>{CacheMessage.Table.niceToString()}</th>
                        <th>{CacheMessage.Type.niceToString()}</th>
                        <th>{CacheMessage.Count.niceToString()}</th>
                        <th>{CacheMessage.Hits.niceToString()}</th>
                        <th>{CacheMessage.Invalidations.niceToString()}</th>
                        <th>{CacheMessage.Loads.niceToString()}</th>
                        <th>{CacheMessage.LoadTime.niceToString()}</th>
                    </tr>
                </thead>
                <tbody>
                    {state.tables.flatMap(t => renderTableRows(t, 0))}
                </tbody>
            </table>
        );
    }

    // One row per table, its sub-tables indented and progressively faded (Signum's RenderTree).
    function renderTableRows(table: CacheTableTS, depth: number): React.JSX.Element[] {
        const opacity = depth === 0 ? 1 : depth === 1 ? .7 : depth === 2 ? .5 : depth === 3 ? .4 : .3;
        const rows = [
            <tr key={`${depth}-${table.tableName}-${table.typeName}`} style={{ opacity }}>
                <td title={table.columns == null ? undefined : `cached columns: ${table.columns.join(", ")}`}>
                    {" → ".repeat(depth) + table.tableName}
                    {/* A trimmed lite table holds only the display columns — show which, since that is the
                        guarantee that keeps a Transactional type out of memory. */}
                    {table.columns != null && <small className="text-body-secondary"> ({table.columns.join(", ")})</small>}
                </td>
                <td>{table.typeName}</td>
                <td>{table.count != null ? table.count.toString() : `-- ${CacheMessage.NotLoaded.niceToString()} --`}</td>
                <td>{table.hits}</td>
                <td>{table.invalidations}</td>
                <td>{table.loads}</td>
                <td>{table.sumLoadTime}</td>
            </tr>,
        ];
        for (const st of table.subTables ?? [])
            rows.push(...renderTableRows(st, depth + 1));
        return rows;
    }

    function renderLazies(state: CacheStateTS): React.JSX.Element {
        return (
            <table className="table table-sm" aria-label={CacheMessage.LazyStats.niceToString()}>
                <thead>
                    <tr>
                        <th>{CacheMessage.Type.niceToString()}</th>
                        <th>{CacheMessage.Hits.niceToString()}</th>
                        <th>{CacheMessage.Invalidations.niceToString()}</th>
                        <th>{CacheMessage.Loads.niceToString()}</th>
                        <th>{CacheMessage.LoadTime.niceToString()}</th>
                    </tr>
                </thead>
                <tbody>
                    {state.lazies.map((lazy, i) => <tr key={i}>
                        <td>{lazy.typeName}</td>
                        <td>{lazy.hits}</td>
                        <td>{lazy.invalidations}</td>
                        <td>{lazy.loads}</td>
                        <td>{lazy.sumLoadTime}</td>
                    </tr>)}
                </tbody>
            </table>
        );
    }
}
