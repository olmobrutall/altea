import "@altea/altea/data/globals/arrayExtensions";
import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as AppContext from "@altea/altea/client/AppContext";
import { useTitle } from "@altea/altea/client/AppContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { Operations } from "@altea/altea/client/Operations";
import { useAPIWithReload, useForceUpdate } from "@altea/altea/client/Hooks";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { getOperationInfos } from "@altea/altea/client/Reflection";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { classes } from "@altea/altea/data/globals";
import { JavascriptMessage, OperationMessage } from "@altea/altea/data/uiMessages";
import { AppendixHelpEntity, AppendixHelpOperation, HelpMessage } from "../../data/Help";
import { HelpClient } from "../HelpClient";
import { EditableText } from "../Editor/EditableText";
import { EditableHtml } from "../Editor/EditableHtml";
import { Shortcut } from "./Shortcut";

// Port of Signum.Help's Pages/AppendixHelpPage.tsx — a free-standing help article: an editable title, a
// unique name (auto-derived from the title on first write) and an editable body.
//
// altea divergence: the unique name arrives as a QUERY parameter rather than an optional path segment,
// which is also what makes "new appendix" a URL with no parameter at all.
export default function AppendixHelpPage(): React.JSX.Element {

    const [searchParams] = useSearchParams();
    const uniqueName = searchParams.get("uniqueName") ?? undefined;

    const [appendix, reload] = useAPIWithReload(() => HelpClient.API.appendix(uniqueName), [uniqueName]);
    const forceUpdate = useForceUpdate();

    useTitle(HelpMessage.Help.niceToString() + (appendix ? " > " + appendix.title : ""));

    if (appendix == null)
        return <div className="container"><h1 className="display-6">{JavascriptMessage.loading.niceToString()}</h1></div>;

    const ctx = TypeContext.root(appendix, { readOnly: Navigator.isReadOnly(AppendixHelpEntity) });

    return (
        <div className="container">
            <h1 className="display-6">
                <Link to={HelpClient.Urls.indexUrl()}>{HelpMessage.Help.niceToString()}</Link>
                {" > "}
                <EditableText ctx={ctx.subCtx(a => a.title, { formSize: "lg" })}
                    defaultEditable={appendix.isNew}
                    onChange={() => {
                        // Signum: while the appendix is new, the unique name tracks the title (stripped of
                        // everything but letters and digits, because it becomes a URL and a file name).
                        if (ctx.value.isNew)
                            ctx.value.uniqueName = (ctx.value.title ?? "").replace(/[^a-zA-Z0-9]/g, "");
                        forceUpdate();
                    }} />
                <small className="ms-5 text-muted display-7">({ctx.value.culture.englishName})</small>
            </h1>

            <div className={classes("mb-2", "shortcut-container")}>
                <div>
                    <strong className="me-2">{ctx.niceName(a => a.uniqueName)}</strong>
                    <EditableText ctx={ctx.subCtx(a => a.uniqueName)} onChange={forceUpdate} defaultEditable={appendix.isNew} />
                </div>
                <Shortcut text={`[a:${ctx.value.uniqueName}]`} />
            </div>

            <EditableHtml ctx={ctx.subCtx(a => a.description)} onChange={forceUpdate} defaultEditable={appendix.isNew} />

            <div className={classes("btn-toolbar", "sf-button-bar", "mt-4")}>
                <SaveButton ctx={ctx} onSuccess={() => ctx.value.isNew
                    ? AppContext.navigate(HelpClient.Urls.appendixUrl(ctx.value.uniqueName))
                    : reload()} />
                <DeleteButton ctx={ctx} />
            </div>
        </div>
    );
}

function SaveButton({ ctx, onSuccess }: { ctx: TypeContext<AppendixHelpEntity>; onSuccess: () => void }): React.JSX.Element | null {

    const oi = getOperationInfos(AppendixHelpEntity).singleOrNull(o => o.key === AppendixHelpOperation.Save.key);
    if (oi == null)
        return null;

    function onClick(): void {
        HelpClient.API.saveAppendix(ctx.value).then(() => {
            onSuccess();
            Operations.notifySuccess();
        });
    }

    return (
        <button type="button" className="btn btn-primary" onClick={onClick}>
            <FontAwesomeIcon aria-hidden={true} icon="floppy-disk" /> {oi.niceName}
        </button>
    );
}

function DeleteButton({ ctx }: { ctx: TypeContext<AppendixHelpEntity> }): React.JSX.Element | null {

    const oi = getOperationInfos(AppendixHelpEntity).singleOrNull(o => o.key === AppendixHelpOperation.Delete.key);
    if (oi == null || ctx.value.isNew)
        return null;

    function onClick(): void {
        MessageModal.show({
            title: OperationMessage.Confirm.niceToString(),
            message: OperationMessage.PleaseConfirmYouWouldLikeToDelete0FromTheSystem.niceToString()
                .formatHtml(<strong>{ctx.value.toString()}</strong>),
            buttons: "yes_no",
            icon: "warning",
            style: "warning",
        }).then(result => {
            if (result !== "yes")
                return;

            Operations.API.deleteLite(ctx.value.toLite(), AppendixHelpOperation.Delete.key).then(() => {
                AppContext.navigate(HelpClient.Urls.indexUrl());
                Operations.notifySuccess();
            });
        });
    }

    return (
        <button type="button" className="btn btn-danger ms-4" onClick={onClick}>
            <FontAwesomeIcon aria-hidden={true} icon="trash" /> {oi.niceName}
        </button>
    );
}
