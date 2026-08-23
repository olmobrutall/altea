import "@altea/altea/data/globals/arrayExtensions";
import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import { Operations } from "@altea/altea/client/Operations";
import { useAPIWithReload, useForceUpdate } from "@altea/altea/client/Hooks";
import { useTitle } from "@altea/altea/client/AppContext";
import { TypeContext } from "@altea/altea/client/TypeContext";
import { tryGetTypeInfo, getOperationInfos } from "@altea/altea/client/Reflection";
import { classes } from "@altea/altea/data/globals";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { HelpMessage, NamespaceHelpEntity, NamespaceHelpOperation } from "../../data/Help";
import { HelpClient } from "../HelpClient";
import { EditableText } from "../Editor/EditableText";
import { EditableHtml } from "../Editor/EditableHtml";
import { Shortcut } from "./Shortcut";

// Port of Signum.Help's Pages/NamespaceHelpPage.tsx — one module's page: an editable title, an editable
// description, and the list of its types.
//
// altea divergence: the namespace arrives as a QUERY parameter, not a path segment (an altea namespace
// contains slashes — see HelpClient).
export default function NamespaceHelpPage(): React.JSX.Element {

    const [searchParams] = useSearchParams();
    const namespace = searchParams.get("namespace") ?? "";

    const [nh, reload] = useAPIWithReload(() => HelpClient.API.namespaceHelp(namespace), [namespace]);
    const forceUpdate = useForceUpdate();

    useTitle(HelpMessage.Help.niceToString() + (nh ? " > " + nh.title : ""));

    if (nh == null)
        return <div className="container"><h1 className="display-6">{JavascriptMessage.loading.niceToString()}</h1></div>;

    const ctx = TypeContext.root(nh.entity, { readOnly: Navigator.isReadOnly(NamespaceHelpEntity) });

    return (
        <div className="container">
            <div className={classes("mb-2", "shortcut-container")}>
                <h1 className="display-6">
                    <Link to={HelpClient.Urls.indexUrl()}>{HelpMessage.Help.niceToString()}</Link>
                    {" > "}
                    <EditableText ctx={ctx.subCtx(a => a.title, { formSize: "lg" })} defaultText={nh.title} onChange={forceUpdate} />
                    <small className="ms-5 text-muted display-7">({ctx.value.culture.englishName})</small>
                </h1>
                <Shortcut text={`[n:${ctx.value.name}]`} />
            </div>

            <EditableHtml ctx={ctx.subCtx(a => a.description)} onChange={forceUpdate} />

            <div className={classes("btn-toolbar", "sf-button-bar", "mt-4")}>
                {ctx.value.isDirty() && <SaveButton ctx={ctx} onSuccess={reload} />}
            </div>

            <h2 className="display-7 mt-4">{HelpMessage.Types.niceToString()}</h2>
            <ul className="mt-4">
                {nh.allowedTypes.map(t =>
                    <li key={t.cleanName}>
                        <Link to={HelpClient.Urls.typeUrl(t.cleanName)}>
                            {tryGetTypeInfo(t.cleanName)?.getNiceName() ?? t.cleanName}
                        </Link>
                    </li>)}
            </ul>
        </div>
    );
}

function SaveButton({ ctx, onSuccess }: { ctx: TypeContext<NamespaceHelpEntity>; onSuccess: () => void }): React.JSX.Element | null {

    // ALTEA: operations live on the per-request metadata blob, so the "is this operation available"
    // question is asked of `getOperationInfos` rather than Signum's TypeInfo.operations.
    const oi = getOperationInfos(NamespaceHelpEntity).singleOrNull(o => o.key === NamespaceHelpOperation.Save.key);
    if (oi == null)
        return null;

    function onClick(): void {
        HelpClient.API.saveNamespace(ctx.value).then(() => {
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
