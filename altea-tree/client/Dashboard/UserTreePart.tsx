import * as React from "react";
import { useAPI } from "@altea/altea/client/Hooks";
import { getOperationInfos } from "@altea/altea/client/Reflection";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { Lite } from "@altea/altea/data/lite";
import type { PanelPartContentProps } from "@altea/altea-dashboard/client/DashboardClient";
import { UserQueriesClient } from "@altea/altea-user-queries/client/UserQueriesClient";
import { TreeOperation, type TreeEntity, type UserTreePartEntity } from "../../data/Tree";
import type { TreeClient } from "../TreeClient";
import { TreeViewer } from "../TreeViewer";

// Port of Signum.Tree's Dashboard/View/UserTreePart.tsx — a dashboard panel showing a tree, scoped by the
// filters of a stored user query.
//
// ALTEA: Signum reads the tree TYPE out of the QueryDescription
// (`getTypeInfos(qd.columns["Entity"].type).single()`); altea has none — and does not need one here,
// because a tree's query IS its type, so the user query's own query key is the type name.
export default function UserTreePart(p: PanelPartContentProps<UserTreePartEntity>): React.JSX.Element {

    const fo = useAPI(() => UserQueriesClient.Converter.toFindOptions(p.content.userQuery, p.entity),
        [p.content.userQuery, p.entity, ...p.deps ?? []]);

    if (!fo)
        return <span>{JavascriptMessage.loading.niceToString()}</span>;

    const typeName = fo.queryName as string;

    const to: TreeClient.TreeOptions = {
        typeName,
        filterOptions: fo.filterOptions,
        columnOptions: fo.columnOptions,
        columnOptionsMode: fo.columnOptionsMode,
    };

    return (
        <TreeViewer
            key={typeName}
            treeOptions={to}
            defaultSelectedLite={p.entity as Lite<TreeEntity>}
            initialShowFilters={false}
            allowMove={getOperationInfos(typeName).some(o => o.key === TreeOperation.Move.key)}
            showExpandCollapseButtons={true}
            deps={p.deps} />
    );
}
