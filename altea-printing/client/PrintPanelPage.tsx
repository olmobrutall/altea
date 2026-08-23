import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import SearchControl from "@altea/altea/client/SearchControl/SearchControl";
import SearchValueLine from "@altea/altea/client/SearchControl/SearchValueLine";
import type { SearchValueController } from "@altea/altea/client/SearchControl/SearchValue";
import { StyleContext } from "@altea/altea/client/TypeContext";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { Navigator } from "@altea/altea/client/Navigator";
import { useAPI } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { FileTypeSymbol } from "@altea/altea-files/data/Files";
import { ProcessEntity } from "@altea/altea-processes/data/Processes";
import { PrintLineEntity, PrintLineState, PrintPackageEntity } from "../data/Printing";
import { PrintClient } from "./PrintClient";

// Port of Signum.Printing's PrintPanelPage.tsx — one counter per file type waiting to print, each with a
// print button that packages that type and queues the process, plus the print processes below.
//
// ALTEA: Signum uses `LinkButton` here without importing it (its page does not compile as written); the
// import is added. The file type's label is Signum's `getToString(fileType).after(".")` — a symbol key is
// `Container.Member`, and the member alone is what a human reads.
export default function PrintPanelPage(): React.JSX.Element {

    const stats = useAPI(() => PrintClient.API.getStats(), []);
    const ctx = new StyleContext(undefined, undefined);

    function handlePrintClick(e: React.MouseEvent, fileType: FileTypeSymbol, vsc: SearchValueController): void {
        e.preventDefault();
        PrintClient.API.createPrintProcess(fileType)
            .then(p => p && Navigator.view(p))
            .then(() => vsc.refreshValue());
    }

    function renderPrintButton(vsc: SearchValueController, fileType: FileTypeSymbol): React.ReactNode {
        if (vsc.value == undefined || vsc.value === 0)
            return undefined;

        return (
            <LinkButton className="sf-line-button" title="Print" onClick={e => handlePrintClick(e, fileType, vsc)}>
                <FontAwesomeIcon icon="print" />
            </LinkButton>
        );
    }

    return (
        <div>
            <h2>PrintPanel</h2>
            <div>
                <fieldset>
                    <legend>Ready To Print</legend>
                    {stats == undefined ? JavascriptMessage.loading.niceToString() :
                        stats.map((s, i) =>
                            <SearchValueLine ctx={ctx} key={i} initialValue={s.count}
                                label={memberOf(s.fileType.key)}
                                extraButtons={vsc => renderPrintButton(vsc, s.fileType)}
                                findOptions={PrintLineEntity.findOptions(token => ({
                                    filterOptions: [
                                        token(l => l.state).filter("EqualTo", PrintLineState.ReadyToPrint),
                                        token(l => l.file.fileType).filter("EqualTo", s.fileType),
                                    ],
                                }))} />)}
                </fieldset>
            </div>

            <h3>{ProcessEntity.nicePluralName()}</h3>
            <SearchControl findOptions={ProcessEntity.findOptions(token => ({
                filterOptions: [token(p => p.data).cast(PrintPackageEntity).filter("DistinctTo", undefined)],
                pagination: { elementsPerPage: 10, mode: "Paginate", currentPage: 1 },
            }))} />
        </div>
    );
}

/** `"PrintFileType.Invoice"` → `"Invoice"` (Signum's `getToString(fileType).after(".")`). */
function memberOf(key: string): string {
    const i = key.indexOf(".");
    return i < 0 ? key : key.slice(i + 1);
}
