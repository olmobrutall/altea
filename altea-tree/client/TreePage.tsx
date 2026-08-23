import * as React from "react";
import { useLocation, useParams } from "react-router";
import * as AppContext from "@altea/altea/client/AppContext";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { QueryString } from "@altea/altea/client/QueryString";
import { getTypeInfo, getQueryNiceName, getOperationInfos } from "@altea/altea/client/Reflection";
import { FrameMessage } from "@altea/altea/data/uiMessages";
import { TreeOperation } from "../data/Tree";
import { TreeClient } from "./TreeClient";
import { TreeViewer } from "./TreeViewer";

// Port of Signum.Tree's TreePage.tsx — `/tree/:typeName`, the standalone counterpart of `/find/:queryName`.
export default function TreePage(): React.JSX.Element {

    const params = useParams() as { typeName: string };
    const location = useLocation();

    useTitleOf(params.typeName);

    const to = TreeClient.parseTreeOptionsPath(params.typeName, QueryString.parse(location.search) as Record<string, string>);

    const treeViewRef = React.useRef<TreeViewer>(null);

    function changeUrl(): void {
        const newPath = treeViewRef.current!.getCurrentUrl();

        if (location.pathname + location.search !== newPath)
            AppContext.navigate(newPath, { replace: true });
    }

    const ti = getTypeInfo(params.typeName);

    return (
        <div id="divSearchPage">
            <h2>
                <span className="sf-entity-title">{ti.getNicePluralName()}</span>
                &nbsp;
                <LinkButton className="sf-popup-fullscreen"
                    title={FrameMessage.Fullscreen.niceToString()}
                    onClick={e => treeViewRef.current!.handleFullScreenClick(e)}>
                    <span className="fa fa-external-link" />
                </LinkButton>
            </h2>
            <TreeViewer ref={treeViewRef}
                key={params.typeName}
                treeOptions={to}
                initialShowFilters={true}
                allowMove={getOperationInfos(params.typeName).some(o => o.key === TreeOperation.Move.key)}
                showToolbar={true}
                showExpandCollapseButtons={true}
                onSearch={() => changeUrl()} />
        </div>
    );
}

function useTitleOf(typeName: string): void {
    AppContext.useTitle(getQueryNiceName(typeName), [typeName]);
}
