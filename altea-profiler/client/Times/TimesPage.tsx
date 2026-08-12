import * as React from 'react'
import { ProfilerClient } from '../ProfilerClient'
import "./Times.css"
import { Tab, Tabs } from 'react-bootstrap';
import { useAPIWithReload } from '@altea/altea/client/Hooks';
import { useTitle } from '@altea/altea/client/AppContext';
import { toNumberFormat } from '@altea/altea/client/numberFormat';
import { TimeMessage } from '../../data/ProfilerMessages';
import { AccessibleTable } from '@altea/altea/client/Basics/AccessibleTable';

// Port of Signum's TimesPage (Signum.Profiler/Times/TimesPage.tsx). The ProfilerTimes admin page: per-action
// request-time statistics (count / min / avg / max×3 / last / total), as bars and as a heat-mapped table.
// Divergences: luxon → small local date/duration helpers; Signum's Color.lerp → an inline RGB mix; the
// user is a plain string the server already stamped (not a Lite → no getToString); numbers via "N0".
export default function TimesPage(): React.JSX.Element {

    const [times, reloadTimes] = useAPIWithReload(() => ProfilerClient.API.Times.fetchInfo(), []);
    useTitle("Times state");

    function handleClear() {
        ProfilerClient.API.Times.clear().then(() => reloadTimes());
    }

    if (times == undefined)
        return <h1 className="h3">{TimeMessage.TimesLoading.niceToString()}</h1>;

    return (
        <div>
            <h1 className="display-6 h3">{TimeMessage.Times.niceToString()}</h1>
            <div className="btn-toolbar">
                <button type="button" onClick={() => reloadTimes()} className="btn btn-tertiary">{TimeMessage.Reload.niceToString()}</button>
                <button type="button" onClick={handleClear} className="btn btn-warning">{TimeMessage.Clear.niceToString()}</button>
            </div>
            <br />
            <Tabs id="timeMachineTabs">
                <Tab eventKey="bars" title={TimeMessage.Bars.niceToString()}>
                    <TimesBars times={times} />
                </Tab>
                <Tab eventKey="table" title={TimeMessage.Table.niceToString()}>
                    <TimesTable times={times} />
                </Tab>
            </Tabs>
        </div>
    );
}

// ---- small local substitutes for luxon / Color -------------------------------------------------

const nf = toNumberFormat("N0");

// Short "x ago" relative label from an ISO date (the subset of luxon DateTime.toRelative the page uses).
function relative(iso: string): string {
    const then = new Date(iso).getTime();
    let s = Math.round((Date.now() - then) / 1000);
    if (s < 60) return `${s} sec ago`;
    let m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    let h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
}

// Mix `from`→`to` by fraction f, returning an rgb() string (the analog of Signum's Color.lerp).
type RGB = [number, number, number];
const WHITE: RGB = [255, 255, 255];
function mix(from: RGB, to: RGB, f: number): string {
    const c = (i: number) => Math.round(from[i] * (1 - f) + to[i] * f);
    return `rgb(${c(0)}, ${c(1)}, ${c(2)})`;
}

function TimesBars({ times }: { times: ProfilerClient.TimeTrackerEntry[] }) {

    function formatMilis(milis: number) {
        return <span>{nf.format(milis)} ms</span>;
    }
    const maxWidth = 600;

    const maxDuration = times.map(a => a.max.duration).max()!;
    const maxTotal = times.map(a => a.totalDuration).max()!;
    const ratio = maxWidth / (maxDuration || 1);

    function drawLineRowDiv(label: string, time: ProfilerClient.TimeTrackerTime, className: string) {
        if (!time) return null;
        return (
            <div className="stat-row" key={label}>
                <div className="stat-cell label">{label}</div>
                <div className="stat-cell leftBorder" title={`${time.date} (${relative(time.date)})\n${time.url ?? ""}\n${time.user ?? ""}`}>
                    <span className={className} style={{ width: (time.duration * ratio) + "px", marginTop: "8px" }}></span>
                    &nbsp;{formatMilis(time.duration)} ({relative(time.date)})
                </div>
            </div>
        );
    }

    return (
        <AccessibleTable
            aria-label={TimeMessage.TimesOverview.niceToString()}
            className="table"
            multiselectable={false}>
            <tbody>
                {times.orderByDescending(a => a.totalDuration).map((pair, i) =>
                    <tr className="st-tt-entry" key={i}>
                        <td>
                            <div>
                                <span className="processName"> {pair.identifier.tryBefore(' ') ?? pair.identifier}</span>
                                {pair.identifier.tryAfter(' ') != undefined && <span className="sf-tt-entityname"> {pair.identifier.after(' ')} </span>}
                            </div>
                            <div>
                                <span className="numTimes">{TimeMessage.Executed.niceToString()} {pair.count} {pair.count == 1 ? "time" : "times"} {TimeMessage.Total.niceToString()} {formatMilis(pair.totalDuration)}</span>
                            </div>
                            <div className="sum" style={{ width: (100 * pair.totalDuration / maxTotal) + "%" }}></div>
                        </td>
                        <td>
                            <div className="stat-table" role="group" aria-label={TimeMessage.TimeStatistics.niceToString()}>
                                {drawLineRowDiv("Last", pair.last, "last")}
                                {drawLineRowDiv("Max", pair.max, "max")}
                                {pair.max2 && drawLineRowDiv("Max 2", pair.max2, "max")}
                                {pair.max3 && drawLineRowDiv("Max 3", pair.max3, "max")}
                                <div className="stat-row">
                                    <div className="stat-cell label">{TimeMessage.Average.niceToString()}</div>
                                    <div className="stat-cell leftBorder">
                                        <span className="med" style={{ width: (pair.averageDuration * ratio) + "px", marginTop: "8px" }}></span>
                                        &nbsp;{formatMilis(pair.averageDuration)}
                                    </div>
                                </div>
                                {drawLineRowDiv("Min", pair.min, "min")}
                            </div>
                        </td>
                    </tr>
                )}
            </tbody>
        </AccessibleTable>
    );
}

function TimesTable({ times }: { times: ProfilerClient.TimeTrackerEntry[] }) {

    const blue: RGB = [41, 128, 185];
    const red: RGB = [192, 57, 43];
    const violet: RGB = [108, 52, 131];
    const getColorCount = (f: number) => mix(WHITE, blue, f);
    const getColorMax = (f: number) => mix(WHITE, red, f);
    const getColorTotal = (f: number) => mix(WHITE, violet, f);

    const max = {
        count: times.max(a => a.count)!,
        duration: times.map(a => a.max.duration).max()!,
        totalDuration: times.max(a => a.totalDuration)!,
    };

    function cell(time: ProfilerClient.TimeTrackerTime | undefined) {
        if (time == null)
            return <td>{TimeMessage.NoDuration.niceToString()}</td>;
        return (
            <td style={{ textAlign: "right", background: getColorMax(time.duration / (max.duration || 1)) }}
                title={`${time.date} (${relative(time.date)})\n${time.url ?? ""}\n${time.user ?? ""}`}>
                {nf.format(time.duration)} ms
            </td>
        );
    }

    return (
        <AccessibleTable
            aria-label={TimeMessage.TimesOverview.niceToString()}
            className="table table-nonfluid"
            multiselectable={false}>
            <thead>
                <tr>
                    <th>{TimeMessage.Name.niceToString()}</th>
                    <th>{TimeMessage.Entity.niceToString()}</th>
                    <th>{TimeMessage.Count.niceToString()}</th>
                    <th>{TimeMessage.Min.niceToString()}</th>
                    <th>{TimeMessage.Average.niceToString()}</th>
                    <th>{`${TimeMessage.Max.niceToString()} 3`}</th>
                    <th>{`${TimeMessage.Max.niceToString()} 2`}</th>
                    <th>{TimeMessage.Max.niceToString()}</th>
                    <th>{TimeMessage.Last.niceToString()}</th>
                    <th>{TimeMessage.Total.niceToString()}</th>
                </tr>
            </thead>
            <tbody>
                {times.orderByDescending(a => a.totalDuration).map((pair, i) =>
                    <tr key={i}>
                        <td><span className="processName"> {pair.identifier.tryBefore(' ') ?? pair.identifier}</span></td>
                        <td>{pair.identifier.tryAfter(' ') && <span className="sf-tt-entityname">{pair.identifier.tryAfter(' ')}</span>}</td>
                        <td style={{ textAlign: "end", background: getColorCount(pair.count / (max.count || 1)) }}>{pair.count}</td>
                        {cell(pair.min)}
                        <td style={{ textAlign: "end", background: getColorMax(pair.averageDuration / (max.duration || 1)) }}>{nf.format(pair.averageDuration)} ms</td>
                        {cell(pair.max3)}
                        {cell(pair.max2)}
                        {cell(pair.max)}
                        {cell(pair.last)}
                        <td style={{ textAlign: "end", background: getColorTotal(pair.totalDuration / (max.totalDuration || 1)) }}>{nf.format(pair.totalDuration)} ms</td>
                    </tr>
                )}
            </tbody>
        </AccessibleTable>
    );
}
