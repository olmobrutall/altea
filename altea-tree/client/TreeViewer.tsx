import "@altea/altea/data/globals/arrayExtensions";
import * as React from "react";
import { Dropdown, OverlayTrigger, Tooltip } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as AppContext from "@altea/altea/client/AppContext";
import { Navigator } from "@altea/altea/client/Navigator";
import { Finder } from "@altea/altea/client/Finder";
import { Operations } from "@altea/altea/client/Operations";
import * as Hooks from "@altea/altea/client/Hooks";
import FilterBuilder from "@altea/altea/client/SearchControl/FilterBuilder";
import ContextMenu, { getMouseEventPosition, type ContextMenuPosition } from "@altea/altea/client/SearchControl/ContextMenu";
import {
    renderContextualItems,
    type ContextualItemsContext, type ContextualMenuItem, type SearchableMenuItem,
} from "@altea/altea/client/SearchControl/ContextualItems";
import type { ColumnParsed } from "@altea/altea/client/SearchControl/SearchControlLoaded";
import type { ISimpleFilterBuilder } from "@altea/altea/client/SearchControl/SearchControl";
import { SubTokensOptions, type QueryToken } from "@altea/altea/client/QueryToken";
import { tryGetTypeInfo, getOperationInfos } from "@altea/altea/client/Reflection";
import type { FilterOptionParsed } from "@altea/altea/client/FindOptions";
import type { QueryRequest } from "@altea/altea/data/dynamicQuery/queryRequest";
import { classes } from "@altea/altea/data/globals";
import type { Entity } from "@altea/altea/data/entity";
import type { Lite } from "@altea/altea/data/lite";
import { EntityControlMessage, JavascriptMessage, SearchMessage } from "@altea/altea/data/uiMessages";
import {
    InsertPlace, MoveTreeModel, TreeMessage, TreeOperation, TreeViewerMessage,
    type TreeEntity, type TreeNode, type TreeNodeState,
} from "../data/Tree";
import { TreeClient } from "./TreeClient";
import "./TreeViewer.css";

// Port of Signum.Tree's TreeViewer.tsx — the tree itself: a filter builder, a toolbar, a table of nodes
// with expand / collapse, a context menu of the type's contextual operations, and drag-and-drop move/copy.
//
// Kept as a CLASS component, as Signum has it: the node rows call back into the viewer for almost
// everything (`tv.handleDragStart`, `tv.state.draggedOver`), and the page and the modal hold a ref to it to
// drive `handleFullScreenClick`. A hooks rewrite would have to invent a context for all of that.
//
// altea divergences:
//  - **`QueryDescription` → the query's ROOT TOKEN** (see TreeClient) — `queryToken` in the state, and it
//    is what FilterBuilder takes.
//  - **`componentWillMount` / `componentWillReceiveProps` are gone** (removed from React): the first load
//    happens in `componentDidMount` and the props diff in `componentDidUpdate`, which is the same
//    substitution altea-workflow's bpmn designer made.
//  - `getTypeInfo(x).members["Name"].niceName` → `ti.fields["name"].niceToString()`.
//  - `tryGetOperationInfo(symbol, type)` → `getOperationInfos(type).some(...)` (operations live on the
//    per-role metadata blob).
//  - `hasToArray(token)` is a METHOD on altea's QueryToken.
//  - the DisabledMixin styling stays (the `tree-disabled` class), but `node.disabled` is always false —
//    the mixin is not ported (see server/TreeLogic).

interface TreeViewerProps {
    treeOptions: TreeClient.TreeOptions;
    defaultSelectedLite?: Lite<TreeEntity>;
    showContextMenu?: boolean | "Basic";
    allowMove?: boolean;
    avoidChangeUrl?: boolean;
    onDoubleClick?: (selectedNode: TreeNode, e: React.MouseEvent) => void;
    onSelectedNode?: (selectedNode: TreeNode | undefined) => void;
    onSearch?: (top: TreeClient.TreeOptionsParsed) => void;
    initialShowFilters?: boolean;
    showToolbar?: boolean;
    showExpandCollapseButtons?: boolean;
    deps?: React.DependencyList;
}

export type DraggedPosition = "Top" | "Bottom" | "Middle";

export interface DraggedOver {
    node: TreeNode;
    position: DraggedPosition;
}

interface VisibleColumn extends ColumnParsed {
    columnIndex: number;
}

interface TreeViewerState {
    treeNodes?: TreeNode[];
    resultColumns?: string[];
    selectedNode?: TreeNode;
    treeOptionsParsed?: TreeClient.TreeOptionsParsed;
    queryToken?: QueryToken;
    simpleFilterBuilder?: React.ReactElement;
    showFilters?: boolean;

    isSelectOpen: boolean;

    draggedNode?: TreeNode;
    draggedKind?: "Move" | "Copy";
    draggedOver?: DraggedOver;

    currentMenuItems?: ContextualMenuItem[];
    contextualMenu?: {
        position: ContextMenuPosition;
        showSearchBox?: boolean;
        filter?: string;
    };
}

export class TreeViewer extends React.Component<TreeViewerProps, TreeViewerState> {

    static maxToArrayElements = 100;

    constructor(props: TreeViewerProps) {
        super(props);
        this.state = {
            showFilters: props.initialShowFilters,
            isSelectOpen: false,
        };
    }

    override componentDidMount(): void {
        this.initialize(this.props.treeOptions);
    }

    override componentDidUpdate(prevProps: TreeViewerProps): void {
        const path = TreeClient.treePath(this.props.treeOptions);

        if (path === TreeClient.treePath(prevProps.treeOptions)) {
            if (!Hooks.areEqualDeps(prevProps.deps ?? [], this.props.deps ?? []))
                this.search(false);
            return;
        }

        if (this.state.treeOptionsParsed && this.state.queryToken
            && path === TreeClient.treePath(TreeClient.toTreeOptions(this.state.treeOptionsParsed, this.state.queryToken)))
            return;

        this.setState({
            showFilters: this.props.initialShowFilters,
            isSelectOpen: false,
            treeNodes: undefined,
            selectedNode: undefined,
        }, () => this.initialize(this.props.treeOptions));
    }

    initialize(to: TreeClient.TreeOptions): void {
        Finder.getQueryRoot(to.typeName).then(queryToken => {
            this.setState({ queryToken }, () =>
                TreeClient.parseTreeOptions(to, queryToken).then(top => {
                    this.setState({ treeOptionsParsed: top }, () => {
                        const qs = Finder.getSettings(to.typeName);
                        const sfb = qs?.simpleFilterBuilder?.({
                            queryToken,
                            initialFilterOptions: top.filterOptions,
                            search: () => this.search(true),
                        });

                        this.setState({ simpleFilterBuilder: sfb, showFilters: sfb ? false : this.state.showFilters });
                        this.search(true, false, true);
                    });
                }));
        });
    }

    selectNode(node: TreeNode | undefined): void {
        // `currentMenuItems` are the CONTEXTUAL items rendered for one specific lite, so they must not
        // outlive the selection. Signum keeps them (only `handleContextOnHide`, the right-click path,
        // clears them) and `handleSelectedToggle` reloads them only when they are undefined — so in Signum
        // picking a second node and reopening the "Selected" dropdown runs the operations of the FIRST one.
        // That is not cosmetic: it deletes the wrong subtree.
        this.setState({ selectedNode: node, currentMenuItems: undefined });
        this.props.onSelectedNode?.(node);
    }

    getCurrentUrl(): string {
        return TreeClient.treePath(TreeClient.toTreeOptions(this.state.treeOptionsParsed!, this.state.queryToken!));
    }

    handleFullScreenClick = (ev: React.MouseEvent): void => {
        const path = this.getCurrentUrl();

        if (ev.ctrlKey || ev.button === 1)
            window.open(AppContext.toAbsoluteUrl(path));
        else
            AppContext.navigate(path);
    };

    // ---- search ----------------------------------------------------------------------------------

    getQueryRequest(avoidHiddenColumns?: boolean): QueryRequest {
        const fo = TreeClient.toFindOptionsParsed(this.state.treeOptionsParsed!);
        const qs = Finder.getSettings(this.props.treeOptions.typeName);
        return Finder.getQueryRequest(fo, qs, avoidHiddenColumns);
    }

    search(clearExpanded: boolean, loadDescendants = false, considerDefaultSelectedLite = false): void {
        if (!this.state.treeOptionsParsed || !this.state.queryToken)
            return;

        const defaultSelectedLite = considerDefaultSelectedLite ? this.props.defaultSelectedLite : undefined;

        this.getFilterOptionsWithSFB().then(filters => {
            const expandedNodes = clearExpanded || !this.state.treeNodes ? [] :
                this.state.treeNodes.flatMap(allNodes).filter(a => a.nodeState === "Expanded").map(a => a.lite);

            const userFilters = Finder.toFilterRequests(filters.filter(fo => fo.frozen !== true));
            const frozenFilters = Finder.toFilterRequests(filters.filter(fo => fo.frozen === true));

            const columns = this.getQueryRequest(true).columns;

            // No filter at all → show the ROOTS. ALTEA: `level` is a stored column (see data/Tree.ts), so
            // this is an ordinary integer filter; Signum's is the same token backed by an expression.
            if (userFilters.length === 0)
                userFilters.push({ token: "level", operation: "EqualTo", value: 1 } as never);

            return TreeClient.API.findNodes(this.props.treeOptions.typeName, {
                userFilters, frozenFilters, columns, expandedNodes, loadDescendants,
            });
        }).then(response => {
            if (response == undefined)
                return;

            const nodes = response.nodes;
            const selectedLite = this.state.selectedNode?.lite;

            let newSelected = selectedLite == undefined ? null
                : nodes.flatMap(allNodes).filter(a => a.lite.is(selectedLite)).singleOrNull();

            if (newSelected == null && defaultSelectedLite != undefined)
                newSelected = nodes.flatMap(allNodes).filter(a => a.lite.is(defaultSelectedLite)).singleOrNull();

            this.setState({ treeNodes: nodes, resultColumns: response.columns, selectedNode: newSelected ?? undefined });

            this.props.onSearch?.(this.state.treeOptionsParsed!);

            if (defaultSelectedLite != undefined && newSelected != null)
                this.selectNode(newSelected);
        });
    }

    handleSearchSubmit = (e: React.FormEvent): void => {
        e.preventDefault();
        e.stopPropagation();
        this.search(true);
    };

    simpleFilterBuilderInstance?: ISimpleFilterBuilder;

    getFilterOptionsWithSFB(): Promise<FilterOptionParsed[]> {
        const fos = this.state.treeOptionsParsed!.filterOptions;

        if (this.simpleFilterBuilderInstance?.getFilters == undefined)
            return Promise.resolve(fos);

        const filters = this.simpleFilterBuilderInstance.getFilters();

        return Finder.parseFilterOptions(filters, false, this.state.queryToken!).then(newFos => {
            const top = this.state.treeOptionsParsed!;
            top.filterOptions = newFos;
            this.setState({ treeOptionsParsed: top });
            return newFos;
        });
    }

    // ---- nodes -----------------------------------------------------------------------------------

    handleNodeIconClick = (n: TreeNode): void => {
        if (n.nodeState === "Collapsed" || n.nodeState === "Filtered") {
            n.nodeState = "Expanded";
            this.search(false);
        } else if (n.nodeState === "Expanded") {
            n.nodeState = "Collapsed";
            allNodes(n).forEach(c => { c.nodeState = "Collapsed"; });
            this.forceUpdate();
        }
    };

    handleNodeTextClick = (n: TreeNode): void => this.selectNode(n);

    handleNodeTextDoubleClick = (n: TreeNode, e: React.MouseEvent): void => {
        if (this.props.onDoubleClick)
            this.props.onDoubleClick(n, e);
        else
            this.handleView();
    };

    handleView = (): void => {
        Navigator.view(this.state.selectedNode!.lite).then(() => this.search(false));
    };

    findParent(childNode: TreeNode): TreeNode | null {
        return this.state.treeNodes!.flatMap(allNodes).filter(n => n.loadedChildren.includes(childNode)).singleOrNull();
    }

    // ---- add -------------------------------------------------------------------------------------

    handleAddRoot = (): void => {
        Operations.API.construct(this.props.treeOptions.typeName, TreeOperation.CreateRoot)
            .then(ep => ep && Navigator.view(ep, { requiresSaveOperation: true }))
            .then(te => te && this.appendNode(te as TreeEntity, node => {
                this.state.treeNodes!.push(node);
                this.forceUpdate();
            }));
    };

    handleAddChildren = (): void => {
        const parent = this.state.selectedNode!;
        Operations.API.constructFromLite(parent.lite, TreeOperation.CreateChild)
            .then(ep => ep && Navigator.view(ep, { requiresSaveOperation: true }))
            .then(te => te && this.appendNode(te as TreeEntity, node => {
                parent.loadedChildren.push(node);
                parent.childrenCount = (Number(parent.childrenCount) + 1) as typeof parent.childrenCount;
                TreeClient.fixState(parent);
                this.selectNode(node);
            }));
    };

    handleAddSibling = (): void => {
        const sibling = this.state.selectedNode!;
        Operations.API.constructFromLite(sibling.lite, TreeOperation.CreateNextSibling)
            .then(ep => ep && Navigator.view(ep, { requiresSaveOperation: true }))
            .then(te => te && this.appendNode(te as TreeEntity, node => {
                const parent = this.findParent(sibling);
                const array = parent ? parent.loadedChildren : this.state.treeNodes!;
                array.insertAt(array.indexOf(sibling) + 1, node);
                this.selectNode(node);
            }));
    };

    /** Fetch the freshly saved entity's node (with its column values) and splice it in. */
    private appendNode(entity: TreeEntity, place: (node: TreeNode) => void): void {
        const columns = this.getQueryRequest(true).columns;

        TreeClient.API.getNode(this.props.treeOptions.typeName, { lite: entity.toLite(), columns })
            .then(node => {
                place(node);
                this.forceUpdate();
            });
    }

    handleCopyClick = (): void => {
        if (!navigator.clipboard || !window.isSecureContext || this.state.selectedNode == undefined)
            return;

        navigator.clipboard.writeText(this.state.selectedNode.lite.key());
    };

    // ---- context menu ----------------------------------------------------------------------------

    handleNodeTextContextMenu = (n: TreeNode, e: React.MouseEvent): void => {
        e.preventDefault();
        e.stopPropagation();

        this.setState({
            selectedNode: n,
            contextualMenu: { position: getMouseEventPosition(e as never, document.querySelector(".tree-container tbody")) },
        }, () => this.loadMenuItems());
    };

    loadMenuItems(): void {
        if (this.props.showContextMenu === "Basic") {
            this.setState({ currentMenuItems: [] });
            return;
        }

        const options: ContextualItemsContext<Entity> = {
            lites: [this.state.selectedNode!.lite as Lite<Entity>],
            queryToken: this.state.queryToken!,
            markRows: () => this.search(false),
            container: this,
        } as unknown as ContextualItemsContext<Entity>;

        renderContextualItems(options).then(menuPack => this.setState({
            currentMenuItems: menuPack.items,
            contextualMenu: this.state.contextualMenu && { ...this.state.contextualMenu, showSearchBox: menuPack.showSearch },
        }));
    }

    handleContextOnHide = (): void => this.setState({ contextualMenu: undefined, currentMenuItems: undefined });

    renderMenuItems(): ContextualMenuItem[] {
        const type = this.props.treeOptions.typeName;
        const has = (key: string): boolean => getOperationInfos(type).some(o => o.key === key);

        const menuItems = [
            Navigator.isViewable(type, { isSearch: "main" }) &&
            <Dropdown.Item onClick={this.handleView}>
                <FontAwesomeIcon icon="arrow-right" />&nbsp;{EntityControlMessage.View.niceToString()}
            </Dropdown.Item>,

            has(TreeOperation.CreateChild.key) &&
            <Dropdown.Item onClick={this.handleAddChildren}>
                <FontAwesomeIcon icon="square-caret-right" />&nbsp;{TreeViewerMessage.AddChild.niceToString()}
            </Dropdown.Item>,

            has(TreeOperation.CreateNextSibling.key) &&
            <Dropdown.Item onClick={this.handleAddSibling}>
                <FontAwesomeIcon icon="square-caret-down" />&nbsp;{TreeViewerMessage.AddSibling.niceToString()}
            </Dropdown.Item>,

            <Dropdown.Item onClick={this.handleCopyClick}>
                <FontAwesomeIcon icon="copy" />&nbsp;{SearchMessage.Copy.niceToString()}
            </Dropdown.Item>,
        ].filter(a => a !== false) as ContextualMenuItem[];

        if (this.state.currentMenuItems == undefined) {
            menuItems.push(<Dropdown.Header>{JavascriptMessage.loading.niceToString()}</Dropdown.Header>);
            return menuItems;
        }

        if (menuItems.length && this.state.currentMenuItems.length)
            menuItems.push(<Dropdown.Divider />);

        const filter = this.state.contextualMenu?.filter;
        const filtered = filter
            ? this.state.currentMenuItems.filter(mi => {
                const full = (mi as SearchableMenuItem).fullText;
                return full == undefined || full.toLowerCase().includes(filter.toLowerCase());
            })
            : this.state.currentMenuItems;

        menuItems.push(...filtered.map(mi => (mi as SearchableMenuItem).menu ?? mi));

        return menuItems;
    }

    renderContextualMenu(): React.ReactElement | null {
        const cm = this.state.contextualMenu!;
        if (!this.state.selectedNode)
            return null;

        const menuItems = this.renderMenuItems();

        return (
            <ContextMenu id="table-context-menu" position={cm.position} onHide={this.handleContextOnHide} itemsCount={menuItems.length}>
                {cm.showSearchBox &&
                    <input type="search"
                        className="form-control form-control-sm dropdown-item"
                        value={cm.filter ?? ""}
                        placeholder={SearchMessage.Search.niceToString()}
                        onChange={e => this.setState({ contextualMenu: { ...cm, filter: e.currentTarget.value } })} />}
                <div style={{ position: "relative", maxHeight: "calc(100vh - 400px)", overflowY: "auto" }}>
                    {menuItems.map((mi, i) => React.cloneElement((mi as SearchableMenuItem).menu ?? mi as React.ReactElement, { key: i }))}
                </div>
            </ContextMenu>
        );
    }

    // ---- toolbar ---------------------------------------------------------------------------------

    handleExpandAll = (): void => this.search(true, true, true);
    handleCollapseAll = (): void => this.search(true, false, true);

    handleSelectedToggle = (): void => {
        if (!this.state.isSelectOpen && this.state.currentMenuItems == undefined)
            this.loadMenuItems();

        this.setState({ isSelectOpen: !this.state.isSelectOpen });
    };

    handleExplore = (e: React.MouseEvent): void => {
        const fo = Finder.toFindOptions(TreeClient.toFindOptionsParsed(this.state.treeOptionsParsed!), this.state.queryToken!, false);
        const path = Finder.findOptionsPath(fo);

        if (this.props.avoidChangeUrl)
            window.open(AppContext.toAbsoluteUrl(path));
        else
            AppContext.pushOrOpenInTab(path, e);
    };

    handleToggleFilters = (): void => {
        this.getFilterOptionsWithSFB().then(() => {
            this.simpleFilterBuilderInstance = undefined;
            this.setState({ simpleFilterBuilder: undefined, showFilters: !this.state.showFilters });
        });
    };

    // ---- drag and drop ---------------------------------------------------------------------------

    handleDragStart = (node: TreeNode, e: React.DragEvent): void => {
        e.dataTransfer.setData("text", "start"); // cannot be an empty string
        const isCopy = e.ctrlKey || e.shiftKey || e.altKey;
        e.dataTransfer.effectAllowed = isCopy ? "copy" : "move";
        this.setState({ draggedNode: node, draggedKind: isCopy ? "Copy" : "Move" });
    };

    handleDragOver = (node: TreeNode, e: React.DragEvent): void => {
        e.preventDefault();

        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const newPosition = getOffset((e.nativeEvent as DragEvent).pageY, rect, 7);
        const over = this.state.draggedOver;

        if (over == undefined || over.node !== node || over.position !== newPosition)
            this.setState({ draggedOver: { node, position: newPosition } });
    };

    handleDragEnd = (): void => this.setState({ draggedNode: undefined, draggedOver: undefined, draggedKind: undefined });

    handleDrop = (node: TreeNode): void => {
        const dragged = this.state.draggedNode!;
        const over = this.state.draggedOver!;

        if (dragged === over.node)
            return;

        const nodeParent = this.findParent(over.node);
        const ts = TreeClient.settings[this.props.treeOptions.typeName];

        if (ts?.dragTargetIsValid)
            ts.dragTargetIsValid(dragged, over.position === "Middle" ? over.node : nodeParent)
                .then(valid => valid && this.moveOrCopyOperation(nodeParent, dragged, over));
        else
            this.moveOrCopyOperation(nodeParent, dragged, over);
    };

    moveOrCopyOperation(nodeParent: TreeNode | null, dragged: TreeNode, over: DraggedOver): void {
        const partial: Partial<MoveTreeModel> =
            over.position === "Middle" ? { newParent: over.node.lite, insertPlace: InsertPlace.LastNode } :
                over.position === "Top" ? { newParent: nodeParent?.lite ?? null, insertPlace: InsertPlace.Before, sibling: over.node.lite } :
                    { newParent: nodeParent?.lite ?? null, insertPlace: InsertPlace.After, sibling: over.node.lite };

        const toExpand = over.position === "Middle" ? over.node : nodeParent;

        const done = (): void => {
            this.setState({ draggedNode: undefined, draggedOver: undefined, draggedKind: undefined, selectedNode: dragged }, () => {
                if (toExpand)
                    toExpand.nodeState = "Expanded";
                this.search(false);
            });
        };

        if (this.state.draggedKind === "Move") {
            Operations.API.executeLite(dragged.lite, TreeOperation.Move, MoveTreeModel.create(partial)).then(done);
            return;
        }

        const s = TreeClient.settings[this.props.treeOptions.typeName];
        const promise = s?.createCopyModel
            ? s.createCopyModel(dragged.lite, partial)
            : Promise.resolve(MoveTreeModel.create(partial));

        promise.then(model => model && Operations.API.constructFromLite(dragged.lite, TreeOperation.Copy, model).then(done));
    }

    // ---- render ----------------------------------------------------------------------------------

    getVisibleColumns(): VisibleColumn[] {
        if (!this.state.resultColumns)
            return [];

        const qs = Finder.getSettings(this.props.treeOptions.typeName);
        const resultColumns = this.state.resultColumns;

        return this.state.treeOptionsParsed!.columnOptions
            .map((co, i) => ({ co, i }))
            // The three columns the tree already renders as its own first column.
            .filter(({ co }) => co.hiddenColumn !== true
                && co.token?.fullKey() !== "id"
                && co.token?.fullKey() !== "name"
                && co.token?.fullKey() !== "fullName"
                && resultColumns.some(rc => rc === co.token?.fullKey()))
            .map(({ co, i }) => ({
                column: co,
                columnIndex: i,
                hasToArray: co.token?.hasToArray(),
                cellFormatter: co.token && Finder.getCellFormatter(qs, co.token, undefined),
                resultIndex: co.token == undefined ? -1 : resultColumns.indexOf(co.token.fullKey()),
            } as VisibleColumn));
    }

    renderSearch(): React.ReactElement {
        const s = this.state;

        const sfb = s.simpleFilterBuilder && React.cloneElement(s.simpleFilterBuilder, {
            ref: (e: ISimpleFilterBuilder) => { this.simpleFilterBuilderInstance = e; },
        } as never);

        return (
            <form onSubmit={this.handleSearchSubmit}>
                {s.treeOptionsParsed && s.queryToken && (s.showFilters
                    ? <FilterBuilder
                        queryToken={s.queryToken}
                        filterOptions={s.treeOptionsParsed.filterOptions}
                        subTokensOptions={SubTokensOptions.CanAnyAll} />
                    : sfb && <div className="simple-filter-builder">{sfb}</div>)}
            </form>
        );
    }

    renderToolbar(): React.ReactElement {
        const s = this.state;
        const selected = s.selectedNode;
        const menuItems = this.renderMenuItems();
        const type = this.props.treeOptions.typeName;

        return (
            <div className="btn-toolbar">
                <a className={classes("sf-query-button", "sf-filters-header", "btn", "btn-light", s.showFilters && "active")}
                    onClick={this.handleToggleFilters}
                    title={SearchMessage.Filters.niceToString()}>
                    <FontAwesomeIcon icon="filter" />
                </a>
                <button className="btn btn-primary" onClick={this.handleSearchSubmit}>{TreeViewerMessage.Search.niceToString()}</button>

                {this.props.showExpandCollapseButtons && <>
                    <button className="btn btn-light" onClick={this.handleExpandAll} disabled={s.treeNodes == undefined}>
                        {TreeViewerMessage.ExpandAll.niceToString()}
                    </button>
                    <button className="btn btn-light" onClick={this.handleCollapseAll} disabled={s.treeNodes == undefined}>
                        {TreeViewerMessage.CollapseAll.niceToString()}
                    </button>
                </>}

                {getOperationInfos(type).some(o => o.key === TreeOperation.CreateRoot.key) &&
                    <button className="btn btn-light" onClick={this.handleAddRoot} disabled={s.treeNodes == undefined}>
                        <FontAwesomeIcon icon="star" />&nbsp;{TreeViewerMessage.AddRoot.niceToString()}
                    </button>}

                <Dropdown onToggle={this.handleSelectedToggle} show={s.isSelectOpen}>
                    <Dropdown.Toggle id="selectedButton" className="sf-query-button sf-tm-selected" disabled={selected == undefined} variant="light">
                        {`${JavascriptMessage.Selected.niceToString()} (${selected ? selected.lite.toString() : TreeViewerMessage.None.niceToString()})`}
                    </Dropdown.Toggle>
                    <Dropdown.Menu>
                        {menuItems.length === 0
                            ? <Dropdown.Item className="sf-search-ctxitem-no-results">{JavascriptMessage.noActionsFound.niceToString()}</Dropdown.Item>
                            : menuItems.map((mi, i) => React.cloneElement((mi as SearchableMenuItem).menu ?? mi as React.ReactElement, { key: i }))}
                    </Dropdown.Menu>
                </Dropdown>

                <button className="btn btn-light" onClick={this.handleExplore}>
                    <FontAwesomeIcon icon="magnifying-glass" />&nbsp;{TreeMessage.ListView.niceToString()}
                </button>
            </div>
        );
    }

    renderExpandCollapseButtons(): React.ReactElement {
        const disabled = this.state.treeNodes == undefined;

        return (
            <div className="btn-toolbar">
                <button className="btn btn-sm btn-light" onClick={this.handleExpandAll} disabled={disabled} title={TreeViewerMessage.ExpandAll.niceToString()}>
                    <FontAwesomeIcon icon="plus" />
                </button>
                <button className="btn btn-sm btn-light" onClick={this.handleCollapseAll} disabled={disabled} title={TreeViewerMessage.CollapseAll.niceToString()}>
                    <FontAwesomeIcon icon="minus" />
                </button>
            </div>
        );
    }

    renderHeaders(visibleColumns: VisibleColumn[]): React.ReactElement {
        const ti = tryGetTypeInfo(this.props.treeOptions.typeName);

        return (
            <tr>
                <th className="noOrder" data-column-name="name">
                    {ti?.fields["name"]?.niceToString() ?? TreeMessage.Tree.niceToString()}
                </th>
                {visibleColumns.map(({ column: co, columnIndex: ci }, i) =>
                    <th key={i}
                        className={classes(co.hiddenColumn && "sf-hidden-column", "noOrder")}
                        data-column-name={co.token?.fullKey()}
                        data-column-index={ci}>
                        {co.displayName}
                    </th>)}
            </tr>
        );
    }

    override render(): React.ReactElement {
        const visibleColumns = this.getVisibleColumns();

        return (
            <div>
                {this.renderSearch()}

                {this.props.showToolbar && <><br />{this.renderToolbar()}<br /></>}
                {!this.props.showToolbar && this.props.showExpandCollapseButtons && this.renderExpandCollapseButtons()}

                <div className="tree-container sf-scroll-table-container table-responsive">
                    <table className="sf-search-results table table-hover table-sm">
                        <thead>{this.renderHeaders(visibleColumns)}</thead>
                        <tbody>
                            {this.state.treeNodes == undefined
                                ? <tr><td>{JavascriptMessage.loading.niceToString()}</td></tr>
                                : this.state.treeNodes.map((node, i) =>
                                    <TreeNodeControl key={i} treeViewer={this} treeNode={node} columns={visibleColumns}
                                        dropDisabled={node === this.state.draggedNode} />)}
                        </tbody>
                    </table>
                </div>

                {this.state.contextualMenu && this.renderContextualMenu()}
            </div>
        );
    }
}

function getOffset(pageY: number, rect: DOMRect, margin: number): DraggedPosition {
    const height = Math.round(rect.height / 5) * 5;
    const offsetY = pageY - rect.top;

    if (offsetY < margin)
        return "Top";
    if (offsetY > height - margin)
        return "Bottom";
    return "Middle";
}

export function allNodes(node: TreeNode): TreeNode[] {
    return [node, ...(node.loadedChildren ?? []).flatMap(allNodes)];
}

interface TreeNodeControlProps {
    treeViewer: TreeViewer;
    treeNode: TreeNode;
    columns: VisibleColumn[];
    dropDisabled: boolean;
}

class TreeNodeControl extends React.Component<TreeNodeControlProps> {

    renderIcon(nodeState: TreeNodeState): React.ReactElement {
        const node = this.props.treeNode;
        const tv = this.props.treeViewer;

        switch (nodeState) {
            case "Collapsed":
                return <span onClick={() => tv.handleNodeIconClick(node)} className="tree-icon">
                    <FontAwesomeIcon icon={["far", "square-plus"]} title={TreeViewerMessage.Expand.niceToString()} />
                </span>;
            case "Expanded":
                return <span onClick={() => tv.handleNodeIconClick(node)} className="tree-icon">
                    <FontAwesomeIcon icon={["far", "square-minus"]} title={TreeViewerMessage.Collapse.niceToString()} />
                </span>;
            case "Filtered":
                // "There is more under here than the search matched."
                return <span onClick={() => tv.handleNodeIconClick(node)} className="tree-icon fa-layers fa-fw">
                    <FontAwesomeIcon icon="square" title={TreeViewerMessage.Expand.niceToString()} />
                    <FontAwesomeIcon icon="filter" inverse transform="shrink-2" />
                </span>;
            default:
                return <span className="place-holder" />;
        }
    }

    getDragAndDropStyle(): React.CSSProperties | undefined {
        const node = this.props.treeNode;
        const s = this.props.treeViewer.state;

        if (s.draggedNode == undefined)
            return undefined;

        if (node === s.draggedNode)
            return { opacity: 0.5 };

        const over = s.draggedOver;
        if (over == undefined || node !== over.node)
            return undefined;

        const color = this.props.dropDisabled ? "rgb(193, 0, 0)" : "rgb(10, 162, 0)";

        if (over.position === "Top")
            return { borderTop: "2px dashed " + color };
        if (over.position === "Bottom")
            return { borderBottom: "2px solid " + color };
        return { backgroundColor: color.replace("(", "a(").replace(")", ", 0.2)") };
    }

    getColumnElement(node: TreeNode, c: VisibleColumn): React.ReactNode {
        if (c.resultIndex === -1 || c.cellFormatter == undefined)
            return undefined;

        const fctx: Finder.CellFormatterContext = {
            refresh: undefined,
            columns: this.props.columns.map(x => x.column.token!.fullKey()),
            row: { entity: node.lite as Lite<Entity>, columns: node.values },
            rowIndex: -1,
        } as unknown as Finder.CellFormatterContext;

        const value = node.values[c.resultIndex as number];

        if (c.hasToArray != undefined)
            return (value as unknown[] ?? [])
                .slice(0, TreeViewer.maxToArrayElements)
                .map((v, i) => <React.Fragment key={i}>{i > 0 && <br />}{c.cellFormatter!.formatter(v, fctx, c)}</React.Fragment>);

        return c.cellFormatter.formatter(value, fctx, c);
    }

    override render(): React.ReactElement {
        const node = this.props.treeNode;
        const tv = this.props.treeViewer;

        return (
            <>
                <tr>
                    <td>
                        <div className="try-no-wrap"
                            draggable={tv.props.allowMove}
                            onDragStart={e => tv.handleDragStart(node, e)}
                            onDragEnter={e => tv.handleDragOver(node, e)}
                            onDragOver={e => tv.handleDragOver(node, e)}
                            onDragEnd={tv.handleDragEnd}
                            onDrop={this.props.dropDisabled ? undefined : () => tv.handleDrop(node)}
                            style={{ marginLeft: `${(Number(node.level) - 1) * 32}px`, ...this.getDragAndDropStyle() }}>

                            {this.renderIcon(node.nodeState)}

                            <span className={classes("tree-label",
                                node === tv.state.selectedNode && "tree-selected",
                                node.disabled && "tree-disabled")}
                                onDoubleClick={e => tv.handleNodeTextDoubleClick(node, e)}
                                onClick={() => tv.handleNodeTextClick(node)}
                                onContextMenu={tv.props.showContextMenu !== false ? e => tv.handleNodeTextContextMenu(node, e) : undefined}>
                                {node.fullName !== node.name
                                    ? <OverlayTrigger overlay={<Tooltip id={`tree-${node.lite.key()}`}><span>{node.fullName}</span></Tooltip>}>
                                        <span>{node.name}</span>
                                    </OverlayTrigger>
                                    : node.name}
                            </span>
                        </div>
                    </td>
                    {this.props.columns.map((c, i) => <td key={i}>{this.getColumnElement(node, c)}</td>)}
                </tr>

                {node.loadedChildren.length > 0 && (node.nodeState === "Expanded" || node.nodeState === "Filtered") &&
                    node.loadedChildren.map((n, i) =>
                        <TreeNodeControl key={i} treeViewer={tv} treeNode={n} columns={this.props.columns}
                            dropDisabled={this.props.dropDisabled || n === tv.state.draggedNode} />)}
            </>
        );
    }
}
