import * as React from "react";
import QueryTokenBuilder from "@altea/altea/client/SearchControl/QueryTokenBuilder";
import MessageModal from "@altea/altea/client/Modals/MessageModal";
import { useAPI } from "@altea/altea/client/Hooks";
import { QueryToken, SubTokensOptions } from "@altea/altea/client/QueryToken";
import { TemplateMessage, TemplateTokenMessage, type GlobalVariableTS } from "../data/Templating";
import { TemplatingClient } from "./TemplatingClient";

// Port of Signum.Templating's TemplateControls.tsx — the toolbar above a template's text: pick a QUERY
// token (or a GLOBAL variable), then click Insert / if / foreach / any to get the snippet to paste.
//
// altea divergences, documented inline:
//  - Signum used `AutoLineModal.show({ type: {name: "string" }, initialValue, … })` to hand the snippet to
//    the user in a selectable text box; altea has no AutoLineModal, so the snippet goes into a
//    `MessageModal` (pre-selected, in a <code> block) — same "Ctrl+C, ESC" flow.
//  - `hasAnyOrAll(token)` is `token.hasAnyOrAll()` in altea (the has* checks live ON the token).
//  - `token.type.isCollection` → `token.type.array`.

export interface TemplateControlsProps {
    queryKey: string | null | undefined;
    forHtml: boolean;
    widgetButtons?: React.ReactElement;
}

type CurrentToken =
    | { type: "Query"; token?: QueryToken }
    | { type: "Global"; expression?: GlobalVariableTS };

export default function TemplateControls(p: TemplateControlsProps): React.JSX.Element {

    const [currentToken, setCurrentToken] = React.useState<CurrentToken>({ type: p.queryKey ? "Query" : "Global" });

    React.useEffect(() => {
        setCurrentToken({ type: p.queryKey ? "Query" : "Global" });
    }, [p.queryKey]);

    function renderButton(text: string, canClick: string | undefined, buildPattern: (key: string) => string): React.JSX.Element {
        return <input type="button" disabled={!!canClick} className="btn btn-tertiary btn-sm sf-button"
            title={canClick} value={text}
            onClick={() => {
                const key = currentToken.type === "Query"
                    ? (currentToken.token ? currentToken.token.fullKey() : "")
                    : (currentToken.expression ? "g:" + currentToken.expression.key : "");

                const snippet = buildPattern(key);

                void MessageModal.show({
                    title: TemplateMessage.Template.niceToString(),
                    message: <div>
                        <pre className="user-select-all"><code>{snippet}</code></pre>
                        <p className="text-muted">{TemplateMessage.CopyToClipboard.niceToString()}</p>
                    </div>,
                    buttons: "ok",
                    shouldSelect: true,
                });
            }} />;
    }

    function tokenHasAnyOrAll(): boolean {
        return currentToken.type === "Query" && (currentToken.token?.hasAnyOrAll() ?? false);
    }

    function tokenIsCollection(): boolean {
        return currentToken.type === "Query"
            ? currentToken.token?.type.array === true
            : currentToken.expression?.isCollection === true;
    }

    function canElement(): string | undefined {
        if (tokenIsCollection())
            return TemplateTokenMessage.YouCannotAddIfBlocksOnCollectionFields.niceToString();
        if (tokenHasAnyOrAll())
            return TemplateTokenMessage.YouCannotAddBlocksWithAllOrAny.niceToString();
        return undefined;
    }

    function canIf(): string | undefined {
        return canElement();
    }

    function canForeach(): string | undefined {
        if (tokenIsCollection())
            return TemplateTokenMessage.YouHaveToAddTheElementTokenToUseForeachOnCollectionFields.niceToString();
        if (tokenHasAnyOrAll())
            return TemplateTokenMessage.YouCannotAddBlocksWithAllOrAny.niceToString();
        return undefined;
    }

    const ct = currentToken;

    return (
        <div className="d-flex">
            <select className="form-select form-select-sm w-auto" value={ct.type}
                onChange={e => setCurrentToken({ type: e.currentTarget.value as "Query" | "Global" })}>
                {p.queryKey && <option value="Query">Query</option>}
                <option value="Global">Global</option>
            </select>
            <span className="mx-1">:</span>
            <span className="rw-widget-sm">
                {ct.type === "Query"
                    ? (p.queryKey && <QueryTokenBuilder queryToken={ct.token} queryKey={p.queryKey}
                        onTokenChange={t => setCurrentToken({ type: "Query", token: t ?? undefined })}
                        subTokenOptions={SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement}
                        readOnly={false} />)
                    : <GlobalVariables selected={ct.expression}
                        onTokenChange={t => setCurrentToken({ type: "Global", expression: t ?? undefined })} />}
            </span>
            <div className="btn-group" style={{ marginLeft: "10px" }}>
                {renderButton(TemplateTokenMessage.Insert.niceToString(), canElement(), token => `@[${token}]`)}
                {renderButton("if", canIf(), token => p.forHtml
                    ? `<!--@if[${token}]--> <!--@else--> <!--@endif-->`
                    : `@if[${token}] @else @endif`)}
                {renderButton("foreach", canForeach(), token => p.forHtml
                    ? `<!--@foreach[${token}]--> <!--@endforeach-->`
                    : `@foreach[${token}] @endforeach`)}
                {renderButton("any", canElement(), token => p.forHtml
                    ? `<!--@any[${token}]--> <!--@notany--> <!--@endany-->`
                    : `@any[${token}] @notany @endany`)}
            </div>
            {p.widgetButtons}
        </div>
    );
}

function GlobalVariables(p: { onTokenChange: (newToken: GlobalVariableTS | undefined) => void; selected: GlobalVariableTS | undefined }): React.JSX.Element {

    const variableList = useAPI(() => TemplatingClient.API.getGlobalVariables(), []);

    return (
        <select id="variables" className="form-select form-select-sm w-auto" value={p.selected?.key ?? ""}
            onChange={e => p.onTokenChange(variableList?.find(a => a.key === e.currentTarget.value))}>
            {p.selected == null && <option value=""> - </option>}
            {variableList?.map((v, i) => <option key={i} value={v.key}>{v.key}</option>)}
        </select>
    );
}
