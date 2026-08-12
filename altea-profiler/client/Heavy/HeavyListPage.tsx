import * as React from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import * as AppContext from '@altea/altea/client/AppContext'
import { ProfilerClient } from '../ProfilerClient'
import "./Profiler.css"
import { useAPIWithReload, useInterval, useSize } from '@altea/altea/client/Hooks'
import { useTitle } from '@altea/altea/client/AppContext'
import { classes } from '@altea/altea/data/globals'
import { HeavyProfilerMessage } from '../../data/ProfilerMessages'
import { scaleLinear } from '../d3Scale'

// Port of Signum's HeavyListPage (Signum.Profiler/Heavy/HeavyListPage.tsx). The Heavy-profiler landing
// page: record on/off, the root-span flame list, and XML download/upload for comparing runs.
export default function HeavyList(): React.JSX.Element {

    const [ignoreProfilerHeavyEntries, setIgnoreProfilerHeavyEntries] = React.useState<boolean>(true)

    const [enabled, reloadEnabled] = useAPIWithReload(() => ProfilerClient.API.Heavy.isEnabled(), [], { avoidReset: true });
    const [entries, reloadEntries] = useAPIWithReload(() => ProfilerClient.API.Heavy.entries(ignoreProfilerHeavyEntries), [], { avoidReset: true });

    const [fileToUpload, setFileToUpload] = React.useState<File | undefined>(undefined);
    const [fileVer, setFileVer] = React.useState<number>(0)

    const tick = useInterval(enabled ? 500 : null, 0, a => a + 1);

    React.useEffect(() => {
        reloadEnabled();
        reloadEntries();
    }, [tick]);

    useTitle("Heavy Profiler");

    function handleClear() {
        ProfilerClient.API.Heavy.clear()
            .then(() => reloadEntries());
    }

    function handleUpdate() {
        reloadEntries();
        reloadEnabled();
    }

    function handleSetEnabled(value: boolean) {
        ProfilerClient.API.Heavy.setEnabled(value)
            .then(() => { reloadEntries(); reloadEnabled(); });
    }

    function handleDownload() {
        ProfilerClient.API.Heavy.download(undefined);
    }

    function handleInputChange(e: React.FormEvent<HTMLInputElement>) {
        const f = e.currentTarget.files![0];
        setFileToUpload(f);
    }

    function handleUpload() {
        const fileReader = new FileReader();
        fileReader.onerror = e => { window.setTimeout(() => { throw (e as any).error; }, 0); };
        fileReader.onload = e => {
            const content = ((e.target as any).result as string).after("base64,");
            const fileName = fileToUpload!.name;

            ProfilerClient.API.Heavy.upload({ fileName, content })
                .then(() => {
                    setFileToUpload(undefined);
                    setFileVer(fileVer + 1);
                    reloadEntries();
                });
        };
        fileReader.readAsDataURL(fileToUpload!);
    }

    const { size, setContainer } = useSize();

    if (entries == undefined)
        return <h1 className="display-6 h3">{HeavyProfilerMessage.HeavyProfilerLoading.niceToString()}</h1>;

    return (
        <div>
            <h1 className="display-6 h2">{HeavyProfilerMessage.HeavyProfiler.niceToString()}</h1>
            <br />
            <div className="btn-toolbar" style={{ float: "right" }}>
                <input key={fileVer} type="file" className="form-control" onChange={handleInputChange} style={{ display: "inline", float: "left", width: "inherit" }} />
                <button type="button" onClick={handleUpload} className="btn btn-info" aria-disabled={!fileToUpload} disabled={!fileToUpload}><FontAwesomeIcon aria-hidden={true} icon="cloud-arrow-up" /> {HeavyProfilerMessage.Upload.niceToString()}</button>
            </div>
            <div className="btn-toolbar">
                <button type="button" className={classes("btn", enabled ? "btn-outline-danger" : "btn-tertiary")} onClick={() => handleSetEnabled(!enabled)}><FontAwesomeIcon icon={["fas", "circle"]} /> {HeavyProfilerMessage.Record.niceToString()}</button>
                <button type="button" onClick={handleUpdate} className="btn btn-tertiary"><FontAwesomeIcon aria-hidden={true} icon="refresh" /> {HeavyProfilerMessage.Update.niceToString()}</button>
                <button type="button" onClick={handleClear} className="btn btn-tertiary"><FontAwesomeIcon aria-hidden={true} icon="trash" /> {HeavyProfilerMessage.Clear.niceToString()}</button>
                <button type="button" onClick={handleDownload} className="btn btn-tertiary btn-outline-info"><FontAwesomeIcon aria-hidden={true} icon="cloud-arrow-down" /> {HeavyProfilerMessage.Download.niceToString()}</button>
            </div>
            <label>
                <input type="checkbox" className="form-check-input me-1" checked={ignoreProfilerHeavyEntries} onChange={e => setIgnoreProfilerHeavyEntries(e.currentTarget.checked)} />
                {HeavyProfilerMessage.IgnoreHeavyProfilerEntries.niceToString()}
            </label>
            <br />
            <p className="help-block">{HeavyProfilerMessage.UploadPreviousRunsToComparePerformance.niceToString()}</p>
            <p className="help-block">{HeavyProfilerMessage.EnableTheProfilerWithTheDebuggerWith0AndSaveTheResultsWith1.niceToString("HeavyProfiler.setEnabled(true)", "HeavyProfiler.exportXml()")}</p>
            <br />
            <h2 className="h3">{HeavyProfilerMessage.Entries.niceToString()}</h2>
            <div className="sf-profiler-chart" ref={setContainer}>
                {size && <EntryListPath entries={entries} width={size.width} />}
            </div>
        </div>
    );
}

function EntryListPath({ width, entries }: { width: number, entries: ProfilerClient.HeavyProfilerEntry[] }) {

    const data = entries;

    const fontSize = 12;
    const fontPadding = 4;
    const characterWidth = 7;
    const labelWidth = 60 * characterWidth; // Max characters: 100
    const rightMargin = 10 * characterWidth; // Approximate elapsed time length: 10

    const height = (fontSize + (2 * fontPadding)) * (data.length);

    const minStart = data.map(a => a.beforeStart).min()!;
    const maxEnd = data.map(a => a.end).max()!;

    const x = scaleLinear([minStart, maxEnd], [labelWidth + 3, width - rightMargin]);
    const y = scaleLinear([0, data.length], [0, height - 1]);

    const entryHeight = y(1);

    function handleOnClick(e: React.MouseEvent, v: ProfilerClient.HeavyProfilerEntry) {
        const url = "/profiler/heavy/entry/" + v.fullIndex;
        if (e.ctrlKey)
            window.open(AppContext.toAbsoluteUrl(url));
        else
            AppContext.navigate(url);
    }

    return (
        <svg width={width + "px"} height={height + "px"}>
            {data.map((v, i) => {
                const isPH = v.kind.startsWith("Web.API") && v.additionalData != null && v.additionalData.includes("/api/profilerHeavy/");
                return (<g className="entry" data-full-key={v.fullIndex} key={v.fullIndex} role="button" tabIndex={0} cursor="pointer" opacity={isPH ? 0.5 : undefined}
                    onClick={e => handleOnClick(e, v)}>
                    <rect className="left-background" x={0} y={y(i)} width={labelWidth} height={entryHeight} fill="#ddd" stroke="#fff" />
                    <text className="label label-left" y={y(i)} dy={fontPadding + fontSize} fill="#000">{v.kind + " " + v.additionalData}</text>
                    <rect className="right-background" x={labelWidth} y={y(i)} width={width - labelWidth} height={entryHeight} fill="#fff" stroke="#ddd" />
                    <rect className="shape" x={x(v.start)} y={y(i)} width={x(v.end) - x(v.start)} height={entryHeight} fill={v.color} />
                    <text className="label label-right" x={x(v.end) + 3} y={y(i)} dy={fontPadding + fontSize} fill='#000'>{v.elapsed}</text>
                    <title>{v.elapsed + " - " + v.additionalData}</title>
                </g>)
            })}
        </svg>
    );
}
