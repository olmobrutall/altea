import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { Finder } from "@altea/altea/client/Finder";
import { getQueryNiceName } from "@altea/altea/client/Reflection";
import { cleanTypeName } from "@altea/altea/data/registration";
import { Binding } from "@altea/altea/client/binding";
import { Navigator } from "@altea/altea/client/Navigator";
import { Typeahead } from "@altea/altea/client/Components";
import QueryTokenBuilder from "@altea/altea/client/SearchControl/QueryTokenBuilder";
import SelectorModal from "@altea/altea/client/SelectorModal";
import { EntityControlMessage } from "@altea/altea/data/uiMessages";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { Entity, type BaseEntity } from "@altea/altea/data/entity";
import { EmbeddedEntity } from "@altea/altea/data/entity";
import {
    ColumnOptionsModeEnum, OrderTypeEnum, PaginationModeEnum,
} from "@altea/altea/data/dynamicQueries";
import { Enum } from "@altea/altea/data/enum";
import { type QueryToken, SubTokensOptions } from "@altea/altea/client/QueryToken";
import { getFilterOperations } from "@altea/altea/client/FindOptions";
import { useForceUpdate, useAPI } from "@altea/altea/client/Hooks";
import { ExpressionOrValueComponent, DesignerModal } from "./Designer";
import type { DesignerNode, Expression } from "./NodeUtils";
import type { BaseNode } from "./Nodes";
import type {
    FindOptionsExpr, FilterOptionExpr, OrderOptionExpr, ColumnOptionExpr,
} from "./FindOptionsExpression";
import { DynamicViewClient } from "../DynamicViewClient";
import { DynamicViewMessage } from "../../data/DynamicView";

// Port of Signum.Dynamic's View/FindOptionsComponent.tsx — the inspector row for a node's `findOptions`, and
// the modal behind it: a query picker plus three token-driven tables (filters, columns, orders) and the
// pagination block. Also `QueryTokenLine` (a bare token picker) and `ViewNameComponent` (the view-name
// dropdown, which is what makes a dynamic view referencable from another view).
//
// altea divergences, documented inline:
//  - `FetchQueryDescription` becomes `FetchQueryRootType`. altea has NO QueryDescription DTO (CLAUDE.md), so
//    "what type does this query's Entity column hold" is answered from the token TREE:
//    `Finder.getQueryRoot(queryName)` gives the root token, whose `.type` is that TypeReference.
//  - Signum's `EnumType.values()` → `Enum.values(SomeEnum)`.
//  - `token.type.isCollection / isLite / isEmbedded / name` → `.array` / `.lite` / `.is(EmbeddedEntity)` /
//    `.getTypeName()`; and the value-type switch matches altea's CAPITALIZED type names (`String`, `Number`,
//    `Boolean`, `Guid`, `PlainDate`…), which is what `@field` writes — see CLAUDE.md.
//  - the four `BaseOptionsComponent` subclasses stay CLASS components, as in Signum: they use `forceUpdate`
//    on themselves per row, which is exactly what a class gives for free.
//  - `LinkButton` → a plain bootstrap `btn btn-link`; `Array.removeAt` / `moveUp` / `moveDown` are Signum
//    globals, spelled out.

interface FindOptionsLineProps {
    binding: Binding<FindOptionsExpr | undefined>;
    dn: DesignerNode<BaseNode>;
    avoidSuggestion?: boolean;
    onQueryChanged?: () => void;
}

export function FindOptionsLine(p: FindOptionsLineProps): React.JSX.Element {

    function renderMember(fo: FindOptionsExpr | undefined): React.ReactNode {
        return (
            <span className={fo === undefined ? "design-default" : "design-changed"}>
                {p.binding.member}
            </span>);
    }

    function handleRemove(): void {
        p.binding.deleteValue();
        p.dn.context.refreshView();
    }

    function handleCreate(): void {
        const route = p.dn.route;
        const ti = route?.type.typeInfos()[0];

        // Offer the queries that already point AT this type, so the common case (a SearchControl of the
        // things that reference the entity being shown) is one click.
        const promise: Promise<FindOptionsExpr> = p.avoidSuggestion === true || ti == undefined
            ? Promise.resolve({} as FindOptionsExpr)
            : DynamicViewClient.API.getSuggestedFindOptions(ti.ctor == undefined ? "" : cleanTypeName(ti.ctor))
                .then(sfos => SelectorModal.chooseElement(sfos, {
                    title: DynamicViewMessage.SuggestedFindOptions.niceToString(),
                    message: DynamicViewMessage.TheFollowingQueriesReference0.niceToString(ti.getNiceName()),
                    buttonDisplay: sfo => <div><strong>{sfo.queryKey}</strong><br /><small>(by <code>{sfo.parentToken}</code>)</small></div>,
                }))
                .then(sfo => ({
                    queryName: sfo?.queryKey,
                    filterOptions: [{
                        token: sfo?.parentToken,
                        value: sfo && { __code__: "ctx.value" } as Expression<BaseEntity>,
                    }],
                } as FindOptionsExpr));

        void promise.then(fo => modifyFindOptions(fo));
    }

    function handleView(): void {
        const fo = JSON.parse(JSON.stringify(p.binding.getValue())) as FindOptionsExpr;
        modifyFindOptions(fo);
    }

    function modifyFindOptions(fo: FindOptionsExpr): void {
        void DesignerModal.show("FindOptions", () => <FindOptionsComponent findOptions={fo} dn={p.dn} />)
            .then(result => {
                if (result) {
                    const oldFo = p.binding.getValue();
                    p.binding.setValue(clean(fo));
                    if (oldFo?.queryName !== p.binding.getValue()?.queryName)
                        p.onQueryChanged?.();
                }

                p.dn.context.refreshView();
            });
    }

    /** The parsed tokens are UI state, never stored (Signum does the same). */
    function clean(fo: FindOptionsExpr): FindOptionsExpr {
        fo.filterOptions?.forEach(f => delete f.parsedToken);
        fo.orderOptions?.forEach(o => delete o.parsedToken);
        fo.columnOptions?.forEach(c => delete c.parsedToken);
        return fo;
    }

    function getDescription(fo: FindOptionsExpr): string {
        const filters = [
            fo.parentToken,
            fo.filterOptions && fo.filterOptions.length > 0 ? fo.filterOptions.length + " filters" : undefined,
        ].filter(a => !!a).join(", ");

        return `${fo.queryName} (${filters || "No filter"})`.trim();
    }

    const fo = p.binding.getValue();

    return (
        <div className="form-group">
            <label className="control-label">
                {renderMember(fo)}
            </label>
            <div>
                {fo
                    ? <div>
                        <button type="button" className="btn btn-link p-0" onClick={handleView}>{getDescription(fo)}</button>
                        {" "}
                        <button type="button" className={classes("btn btn-link p-0", "sf-line-button", "sf-remove")}
                            onClick={handleRemove}
                            title={EntityControlMessage.Remove.niceToString()}>
                            <FontAwesomeIcon icon="xmark" />
                        </button>
                    </div>
                    : <button type="button" className="btn btn-link p-0 sf-line-button sf-create"
                        title={EntityControlMessage.Create.niceToString()}
                        onClick={handleCreate}>
                        <FontAwesomeIcon icon="plus" className="sf-create sf-create-label" />{EntityControlMessage.Create.niceToString()}
                    </button>}
            </div>
        </div>
    );
}

interface QueryTokenLineProps {
    binding: Binding<string | undefined>;
    dn: DesignerNode<BaseNode>;
    subTokenOptions: SubTokensOptions;
    queryKey: string | undefined;
}

export function QueryTokenLine(p: QueryTokenLineProps): React.JSX.Element {

    const [parsedToken, setParsedToken] = React.useState<QueryToken | undefined>(undefined);

    function renderMember(token: string | undefined): React.ReactNode {
        return (
            <span className={token === undefined ? "design-default" : "design-changed"}>
                {p.binding.member}
            </span>
        );
    }

    function handleChange(qt: QueryToken | undefined): void {
        setParsedToken(qt);
        if (qt?.fullKey() !== p.binding.getValue()) {
            if (qt)
                p.binding.setValue(qt.fullKey());
            else
                p.binding.deleteValue();

            p.dn.context.refreshView();
        }
    }

    const token = p.binding.getValue();

    return (
        <div className="form-group">
            <label className="control-label">
                {renderMember(token)} {p.queryKey && <small>({getQueryNiceName(p.queryKey)})</small>}
            </label>
            <div>
                {p.queryKey && <QueryTokenBuilderString key={p.queryKey}
                    queryKey={p.queryKey}
                    token={token}
                    subTokenOptions={p.subTokenOptions}
                    parsedToken={parsedToken}
                    hideLabel={true}
                    onChange={handleChange}
                    label="" />}
            </div>
        </div>
    );
}

interface FetchQueryRootTypeProps {
    queryName?: string;
    children: (typeName?: string) => React.ReactElement;
}

/**
 * Signum's `FetchQueryDescription`, narrowed to the one thing its consumers asked of it: the type name of
 * the query's Entity column. altea has no QueryDescription, so it comes from the query's ROOT TOKEN.
 */
export function FetchQueryRootType(p: FetchQueryRootTypeProps): React.JSX.Element {
    const typeName = useAPI(
        () => !p.queryName
            ? Promise.resolve(undefined)
            : Finder.getQueryRoot(p.queryName).then(qt => qt.type.getTypeName()),
        [p.queryName]);

    return p.children(typeName ?? undefined);
}

interface ViewNameComponentProps {
    binding: Binding<unknown>;
    dn: DesignerNode<BaseNode>;
    typeName?: string;
}

export function ViewNameComponent(p: ViewNameComponentProps): React.JSX.Element {

    const viewNames = useAPI(() => {
        if (!p.typeName)
            return Promise.resolve(undefined);

        // A polymorphic reference names several types; ask each and merge, as Signum does.
        const names = p.typeName.split(",").map(a => a.trim()).filter(a => a !== "");

        return Promise.all(names.map(tn =>
            Navigator.getViewDispatcher().getViewNames(tn)
                .then(array => [...array, hasStaticView(tn) ? "STATIC" : undefined])))
            .then(arrays => [...arrays.flat().filter((a): a is string => a != null), "NEW"]);
    }, [p.typeName]);

    return <ExpressionOrValueComponent dn={p.dn} binding={p.binding as Binding<unknown>} type="string"
        defaultValue={null} options={viewNames ?? undefined}
        exampleExpression={`e => modules.Navigator.getViewDispatcher().getViewPromise(e, "View Name")`} />;
}

function hasStaticView(typeName: string): boolean {
    const es = Navigator.getSettings(typeName);
    return es?.getViewPromise != null;
}

interface FindOptionsComponentProps {
    dn: DesignerNode<BaseNode>;
    findOptions: FindOptionsExpr;
}

export function FindOptionsComponent(p: FindOptionsComponentProps): React.JSX.Element {
    const forceUpdate = useForceUpdate();

    function handleChangeQueryKey(queryKey: string | undefined): void {
        const fo = p.findOptions;
        fo.queryName = queryKey;
        delete fo.parentToken;
        delete fo.filterOptions;
        delete fo.columnOptions;
        delete fo.orderOptions;
        forceUpdate();
    }

    const dn = p.dn;
    const fo = p.findOptions;

    return (
        <div className="form-sm filter-options code-container">
            <QueryKeyLine queryKey={fo.queryName} label="queryKey" onChange={handleChangeQueryKey} />

            {fo.queryName &&
                <div>
                    <FilterOptionsComponent dn={dn} binding={Binding.create(fo, f => f.filterOptions)} queryKey={fo.queryName} refreshView={forceUpdate} extraButtons={() =>
                        <ExpressionOrValueComponent dn={dn} binding={Binding.create(fo, f => f.includeDefaultFilters)} refreshView={forceUpdate} type="boolean" defaultValue={null} />
                    } />
                    <ColumnOptionsComponent dn={dn} binding={Binding.create(fo, f => f.columnOptions)} queryKey={fo.queryName} refreshView={forceUpdate} extraButtons={() =>
                        <ExpressionOrValueComponent dn={dn} binding={Binding.create(fo, f => f.columnOptionsMode)} refreshView={forceUpdate} type="string" options={Enum.values(ColumnOptionsModeEnum) as string[]} defaultValue={"Add"} />
                    } />
                    <OrderOptionsComponent dn={dn} binding={Binding.create(fo, f => f.orderOptions)} queryKey={fo.queryName} refreshView={forceUpdate} />
                    <PaginationComponent dn={dn} findOptions={fo} refreshView={forceUpdate} />
                </div>}
        </div>
    );
}

export function QueryKeyLine(p: { queryKey: string | undefined; label: string; onChange: (queryKey: string | undefined) => void }): React.ReactElement {

    function handleGetItems(query: string): Promise<string[]> {
        return Finder.API.findLiteLike({ types: QueryEntity.typeName, subString: query, count: 5 })
            .then(lites => lites.map(a => a.toString()));
    }

    return (
        <div className="form-group">
            <label className="control-label">
                {p.label}
            </label>
            <div style={{ position: "relative" }}>
                {p.queryKey
                    ? <div className="input-group">
                        <span className="form-control btn-light sf-entity-line-entity">
                            {p.queryKey}
                        </span>
                        <button type="button" className={classes("btn btn-light", "sf-line-button", "sf-remove")}
                            onClick={() => p.onChange(undefined)}
                            title={EntityControlMessage.Remove.niceToString()}>
                            <FontAwesomeIcon icon="xmark" />
                        </button>
                    </div>
                    : <Typeahead
                        inputAttrs={{ className: "form-control sf-entity-autocomplete" }}
                        getItems={handleGetItems}
                        onSelect={item => { p.onChange(item as string); return ""; }} />}
            </div>
        </div>
    );
}

interface QueryTokenBuilderStringProps {
    queryKey: string;
    token: string | undefined;
    parsedToken: QueryToken | undefined;
    label: string;
    onChange: (newToken: QueryToken | undefined) => void;
    subTokenOptions: SubTokensOptions;
    hideLabel?: boolean;
}

/** A QueryTokenBuilder that stores the token as a STRING: what a view carries is `fullKey`, not a token. */
function QueryTokenBuilderString(p: QueryTokenBuilderStringProps): React.JSX.Element {

    React.useEffect(() => {
        if (p.parsedToken?.fullKey() !== p.token) {
            const promise = p.token == null
                ? Promise.resolve<QueryToken | undefined>(undefined)
                : Finder.parseSingleToken(p.queryKey, p.token, p.subTokenOptions);

            void promise.then(t => p.onChange(t));
        }
    }, [p.queryKey, p.token]);

    const qt = <QueryTokenBuilder
        queryToken={p.parsedToken}
        queryKey={p.queryKey}
        onTokenChange={p.onChange}
        readOnly={false}
        subTokenOptions={p.subTokenOptions} />;

    if (p.hideLabel)
        return qt;

    return (
        <div className="form-group">
            <label className="control-label">
                {p.label}
            </label>
            <div>
                {qt}
            </div>
        </div>
    );
}

interface BaseOptionsComponentProps<T> {
    binding: Binding<T[] | undefined>;
    dn: DesignerNode<BaseNode>;
    extraButtons?: () => React.ReactNode;
    refreshView: () => void;
    queryKey: string;
}

abstract class BaseOptionsComponent<T> extends React.Component<BaseOptionsComponentProps<T>> {

    handleOnRemove = (index: number): void => {
        const array = this.props.binding.getValue()!;
        array.splice(index, 1);
        if (array.length === 0)
            this.props.binding.deleteValue();

        this.props.refreshView();
    };

    handleOnMoveUp = (index: number): void => {
        const list = this.props.binding.getValue()!;
        if (index > 0)
            [list[index - 1], list[index]] = [list[index]!, list[index - 1]!];
        this.props.refreshView();
    };

    handleOnMoveDown = (index: number): void => {
        const list = this.props.binding.getValue()!;
        if (index < list.length - 1)
            [list[index + 1], list[index]] = [list[index]!, list[index + 1]!];
        this.props.refreshView();
    };

    handleCreateClick = (): void => {
        let array = this.props.binding.getValue();
        if (array == undefined) {
            array = [];
            this.props.binding.setValue(array);
        }
        array.push(this.newElement());
        this.props.refreshView();
    };

    renderButtons(index: number): React.JSX.Element {
        return (<div className="item-group">
            <button type="button" className={classes("btn btn-link p-0", "sf-line-button", "sf-remove")}
                onClick={() => this.handleOnRemove(index)}
                title={EntityControlMessage.Remove.niceToString()}>
                <FontAwesomeIcon icon="xmark" />
            </button>

            <button type="button" className={classes("btn btn-link p-0", "sf-line-button", "move-up")}
                onClick={() => this.handleOnMoveUp(index)}
                title={EntityControlMessage.MoveUp.niceToString()}>
                <FontAwesomeIcon icon="chevron-up" />
            </button>

            <button type="button" className={classes("btn btn-link p-0", "sf-line-button", "move-down")}
                onClick={() => this.handleOnMoveDown(index)}
                title={EntityControlMessage.MoveDown.niceToString()}>
                <FontAwesomeIcon icon="chevron-down" />
            </button>
        </div>);
    }

    abstract renderTitle(): React.ReactNode;
    abstract renderHeader(): React.ReactElement;
    abstract renderItem(item: T, index: number): React.ReactElement;
    abstract getNumColumns(): number;
    abstract newElement(): T;

    override render(): React.ReactNode {

        const array = this.props.binding.getValue();

        return (<fieldset className="sf-table-field">
            <legend>{this.renderTitle()}</legend>
            <table className="table table-sm code-container">
                <thead>
                    {this.renderHeader()}
                </thead>
                <tbody>
                    {array?.map((item, i) => this.renderItem(item, i))}
                    <tr>
                        <td colSpan={this.getNumColumns()}>
                            <button type="button" title={EntityControlMessage.Create.niceToString()}
                                className="btn btn-link p-0 sf-line-button sf-create"
                                onClick={this.handleCreateClick}>
                                <FontAwesomeIcon icon="plus" className="sf-create" />&nbsp;{EntityControlMessage.Create.niceToString()}
                            </button>
                            {this.props.extraButtons && <div className="mt-2">{this.props.extraButtons()}</div>}
                        </td>
                    </tr>
                </tbody>
            </table>
        </fieldset>);
    }
}

class FilterOptionsComponent extends BaseOptionsComponent<FilterOptionExpr> {

    renderTitle(): React.ReactNode { return "Filters"; }

    renderHeader(): React.ReactElement {
        return (
            <tr>
                <th></th>
                <th>Column</th>
                <th>Operation</th>
                <th>Value</th>
                <th>Frozen</th>
                <th>Applicable</th>
            </tr>
        );
    }

    handleColumnChange = (item: FilterOptionExpr, newToken: QueryToken | undefined): void => {
        item.token = newToken?.fullKey();
        item.parsedToken = newToken;
        this.props.refreshView();
    };

    renderItem(item: FilterOptionExpr, index: number): React.ReactElement {
        const dn = this.props.dn;
        return (
            <tr key={index}>
                <td>{this.renderButtons(index)}</td>
                <td><QueryTokenBuilderString label="columnName" token={item.token} parsedToken={item.parsedToken}
                    onChange={newToken => this.handleColumnChange(item, newToken)}
                    queryKey={this.props.queryKey}
                    subTokenOptions={SubTokensOptions.CanAnyAll | SubTokensOptions.CanElement} hideLabel={true} /></td>
                <td>{item.parsedToken && <ExpressionOrValueComponent dn={dn} hideLabel={true} refreshView={() => this.forceUpdate()} binding={Binding.create(item, f => f.operation)} type="string" defaultValue={null} options={getFilterOperations(item.parsedToken) as string[]} />}</td>
                <td>{item.parsedToken && <ExpressionOrValueComponent dn={dn} hideLabel={true} refreshView={() => this.forceUpdate()} binding={Binding.create(item, f => f.value)} type={FilterOptionsComponent.getValueType(item.parsedToken)} defaultValue={null} />}</td>
                <td><ExpressionOrValueComponent dn={dn} hideLabel={true} refreshView={() => this.forceUpdate()} binding={Binding.create(item, f => f.frozen)} type="boolean" defaultValue={false} /></td>
                <td><ExpressionOrValueComponent dn={dn} hideLabel={true} refreshView={() => this.forceUpdate()} binding={Binding.create(item, f => f.applicable)} type="boolean" defaultValue={true} /></td>
            </tr>
        );
    }

    /** altea's `@field` typeNames are CAPITALIZED (CLAUDE.md), so the switch reads those. */
    static getValueType(token: QueryToken): "string" | "boolean" | "number" | null {
        const tr = token.type;
        if (tr.array || tr.lite || tr.is(EmbeddedEntity))
            return null;

        const name = tr.getTypeName();

        if (name === "String" || name === "Guid" || name === "PlainDate" || name === "PlainDateTime"
            || name === "PlainTime" || name === "Duration")
            return "string";

        if (name === "Number" || name === "Decimal")
            return "number";

        if (name === "Boolean")
            return "boolean";

        return null;
    }

    getNumColumns(): number { return 7; }

    newElement(): FilterOptionExpr { return {} as FilterOptionExpr; }
}

class OrderOptionsComponent extends BaseOptionsComponent<OrderOptionExpr> {

    renderTitle(): React.ReactNode { return "Orders"; }

    renderHeader(): React.ReactElement {
        return (
            <tr>
                <th></th>
                <th>Column</th>
                <th>OrderType</th>
                <th>Applicable</th>
            </tr>
        );
    }

    handleColumnChange = (item: OrderOptionExpr, newToken: QueryToken | undefined): void => {
        item.token = newToken?.fullKey();
        item.parsedToken = newToken;
        this.props.refreshView();
    };

    renderItem(item: OrderOptionExpr, index: number): React.ReactElement {
        const dn = this.props.dn;
        return (
            <tr key={index}>
                <td>{this.renderButtons(index)}</td>
                <td><QueryTokenBuilderString label="columnName" parsedToken={item.parsedToken} token={item.token}
                    onChange={newToken => this.handleColumnChange(item, newToken)} queryKey={this.props.queryKey}
                    subTokenOptions={SubTokensOptions.CanElement} hideLabel={true} /></td>
                <td>{item.parsedToken && !item.parsedToken.type.is(EmbeddedEntity) && <ExpressionOrValueComponent dn={dn} hideLabel={true} refreshView={() => this.forceUpdate()} binding={Binding.create(item, f => f.orderType)} type="string" defaultValue={null} options={Enum.values(OrderTypeEnum) as string[]} />}</td>
                <td><ExpressionOrValueComponent dn={dn} hideLabel={true} refreshView={() => this.forceUpdate()} binding={Binding.create(item, f => f.applicable)} type="boolean" defaultValue={true} /></td>
            </tr>
        );
    }

    getNumColumns(): number { return 4; }

    newElement(): OrderOptionExpr { return {} as OrderOptionExpr; }
}

class ColumnOptionsComponent extends BaseOptionsComponent<ColumnOptionExpr> {

    renderTitle(): React.ReactNode { return "Columns"; }

    renderHeader(): React.ReactElement {
        return (
            <tr>
                <th></th>
                <th>Column</th>
                <th>DisplayName</th>
                <th>Applicable</th>
            </tr>
        );
    }

    handleColumnChange = (item: ColumnOptionExpr, newToken: QueryToken | undefined): void => {
        item.token = newToken?.fullKey();
        item.parsedToken = newToken;
        this.props.refreshView();
    };

    renderItem(item: ColumnOptionExpr, index: number): React.ReactElement {
        const dn = this.props.dn;
        return (
            <tr key={index}>
                <td>{this.renderButtons(index)}</td>
                <td>
                    <QueryTokenBuilderString label="columnName" parsedToken={item.parsedToken} token={item.token}
                        onChange={newToken => this.handleColumnChange(item, newToken)}
                        queryKey={this.props.queryKey}
                        subTokenOptions={SubTokensOptions.CanElement | SubTokensOptions.CanOperation | SubTokensOptions.CanManual}
                        hideLabel={true} />
                </td>
                <td>{item.parsedToken && <ExpressionOrValueComponent dn={dn} hideLabel={true} refreshView={() => this.forceUpdate()} binding={Binding.create(item, f => f.displayName)} type="string" defaultValue={null} />}</td>
                <td><ExpressionOrValueComponent dn={dn} hideLabel={true} refreshView={() => this.forceUpdate()} binding={Binding.create(item, f => f.applicable)} type="boolean" defaultValue={true} /></td>
            </tr>
        );
    }

    getNumColumns(): number { return 4; }

    newElement(): ColumnOptionExpr { return {} as ColumnOptionExpr; }
}

function PaginationComponent(p: { findOptions: FindOptionsExpr; dn: DesignerNode<BaseNode>; refreshView: () => void }): React.JSX.Element {
    const fo = p.findOptions;
    const dn = p.dn;
    const mode = fo.paginationMode;

    return (
        <fieldset>
            <legend>Pagination</legend>
            <ExpressionOrValueComponent dn={dn} refreshView={p.refreshView} binding={Binding.create(fo, f => f.paginationMode)} type="string" options={Enum.values(PaginationModeEnum) as string[]} defaultValue={null} allowsExpression={false} />
            {(mode === "Firsts" || mode === "Paginate") &&
                <ExpressionOrValueComponent dn={dn} refreshView={p.refreshView} binding={Binding.create(fo, f => f.elementsPerPage)} type="number" defaultValue={null} />}
            {mode === "Paginate" &&
                <ExpressionOrValueComponent dn={dn} refreshView={p.refreshView} binding={Binding.create(fo, f => f.currentPage)} type="number" defaultValue={null} />}
        </fieldset>
    );
}

// `Entity` is imported for the type-narrowing the SearchValueLine node's validation does through this module.
void Entity;
