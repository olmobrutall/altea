import * as React from "react";
import { Modal, ProgressBar } from "react-bootstrap";
import { useForceUpdate, useThrottle } from "@altea/altea/client/Hooks";
import { type IModalProps, openModal } from "@altea/altea/client/Modals";
import { jsonObjectStream } from "@altea/altea/client/Operations/jsonObjectStream";
import { ServiceError } from "@altea/altea/client/Services";
import "@altea/altea/client/AppContext"; // String.prototype.formatHtml
import type { TypeInfo } from "@altea/altea/client/Reflection";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { ImportFromExcelMessage } from "../data/Excel";
import { ExcelClient } from "./ExcelClient";

// Port of Signum.Excel's ImportExcelProgressModal.tsx — the row-by-row progress of an import, read off the
// NDJSON the /api/excel/import route streams (one ImportResult per line, see ExcelImportLogic).
//
// altea divergence: `jsonObjectStream` parses each line with the entity Serializer, so `result.entity` comes
// back as a real Lite (the caller calls `.key()` on it) — see its own header.

interface ImportExcelProgressModalProps extends IModalProps<ExcelClient.ImportFromExcelReport> {
    typeInfo: TypeInfo;
    makeRequest: () => Promise<Response>;
    abortController: AbortController;
}

export function ImportExcelProgressModal(p: ImportExcelProgressModalProps): React.JSX.Element {

    const [show, setShow] = React.useState(true);
    const forceUpdate = useForceUpdate();
    const importResultsRef = React.useRef([] as ExcelClient.ImportResult[]);
    const errorRef = React.useRef(null as any);

    const [requestStarted, setRequestStarted] = React.useState<boolean>(false);
    const oldRequestStarted = useThrottle(requestStarted, 1000);

    async function consumeReader(): Promise<void> {
        setRequestStarted(true);
        const resp = await p.makeRequest();

        const generator = jsonObjectStream<ExcelClient.ImportResult | ExcelClient.ImportErrorLine>(resp.body!.getReader());
        for await (const val of generator) {
            // A failure the server could no longer report as a STATUS, because it had already begun
            // streaming (ExcelImportLogic). Raising it as a ServiceError puts it exactly where a failure
            // before the first line lands — `errorRef` → the report's `error` → the ErrorModal — so the
            // caller has one error path, not two.
            const errorLine = (val as ExcelClient.ImportErrorLine).importError;
            if (errorLine != null)
                throw new ServiceError(errorLine);

            importResultsRef.current.push(val as ExcelClient.ImportResult);
            forceUpdate();
        }
    }

    React.useEffect(() => {
        consumeReader()
            .catch(error => { errorRef.current = error; })
            .finally(() => setShow(false));
    }, []);

    function handleCancelClicked(): void {
        p.abortController.abort();
    }

    function handleOnExited(): void {
        p.onExited!({ results: importResultsRef.current.map(a => a), error: errorRef.current });
    }

    const errors = importResultsRef.current.filter(a => a.error != null);
    const totalRows = importResultsRef.current[0]?.totalRows;

    return (
        <Modal show={show} className="message-modal" backdrop="static" onExited={handleOnExited}>
            <div className="modal-header">
                <h1 className="modal-title h5">
                    {ImportFromExcelMessage.Importing0.niceToString(p.typeInfo.getNicePluralName())}
                </h1>
                <button type="button" className="btn-close" aria-label="Close" onClick={handleCancelClicked} />
            </div>
            <div className="modal-body">
                <p><strong>{totalRows}</strong> {totalRows === 1 ? p.typeInfo.getNiceName() : p.typeInfo.getNicePluralName()}</p>
                {importResultsRef.current.length === 0 && oldRequestStarted
                    ? <ProgressBar now={100} variant="info" animated striped key={1} />
                    : <ProgressBar min={0} max={totalRows} now={importResultsRef.current.length}
                        label={`[${importResultsRef.current.length}/${totalRows}]`} key={2} />}
                {errors.length > 0 &&
                    <p className="text-danger">
                        {ImportFromExcelMessage._0Errors.niceToString().forGenderAndNumber(errors.length).formatHtml(<strong>{errors.length}</strong>)}
                    </p>}
            </div>
            <div className="modal-footer">
                <button type="button" className="btn btn-tertiary sf-entity-button sf-close-button" onClick={handleCancelClicked}>
                    {JavascriptMessage.cancel.niceToString()}
                </button>
            </div>
        </Modal>
    );
}

export namespace ImportExcelProgressModal {
    export function show(abortController: AbortController, typeInfo: TypeInfo, makeRequest: () => Promise<Response>): Promise<ExcelClient.ImportFromExcelReport> {
        return openModal<ExcelClient.ImportFromExcelReport>(
            <ImportExcelProgressModal makeRequest={makeRequest} abortController={abortController} typeInfo={typeInfo} />);
    }
}
