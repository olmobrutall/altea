import * as React from "react";
import { Button } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as AppContext from "@altea/altea/client/AppContext";
import type SearchControlLoaded from "@altea/altea/client/SearchControl/SearchControlLoaded";
import { TreeMessage } from "../data/Tree";
import { TreeClient } from "./TreeClient";

// Port of Signum.Tree's TreeButton.tsx — the "sitemap" button a tree type's search control grows, which
// carries the current filters and columns over to the tree view.
//
// ALTEA: the search control has no `queryDescription` prop (see CLAUDE.md), so the query's ROOT TOKEN is
// what `toTreeOptions` needs — and it is already on the control's props.
export interface TreeButtonProps {
    searchControl: SearchControlLoaded;
}

export default function TreeButton(p: TreeButtonProps): React.JSX.Element {

    function handleClick(e: React.MouseEvent): void {
        const fo = p.searchControl.props.findOptions;

        const top: TreeClient.TreeOptionsParsed = {
            typeName: fo.queryKey,
            filterOptions: fo.filterOptions,
            columnOptions: fo.columnOptions,
        };

        const path = TreeClient.treePath(TreeClient.toTreeOptions(top, p.searchControl.props.queryToken));

        if (p.searchControl.props.avoidChangeUrl)
            window.open(AppContext.toAbsoluteUrl(path));
        else
            AppContext.pushOrOpenInTab(path, e);
    }

    const label = p.searchControl.props.largeToolbarButtons === true ? " " + TreeMessage.Tree.niceToString() : undefined;

    return (
        <Button onClick={handleClick} variant="light" title={TreeMessage.Tree.niceToString()}>
            <FontAwesomeIcon icon="sitemap" />&nbsp;{label}
        </Button>
    );
}
