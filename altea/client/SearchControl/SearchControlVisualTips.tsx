import * as React from "react";
import { Popover } from "react-bootstrap";
import type { OverlayInjectedProps } from "react-bootstrap/esm/Overlay";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Finder } from "../Finder";
import { getQueryNiceName } from "../Reflection";
import { LinkButton } from "../Basics/LinkButton";
import type { QueryToken } from "../QueryToken";
import type SearchControlLoaded from "./SearchControlLoaded";
import {
    getAddFilterIcon, getEditColumnIcon, getInsertColumnIcon, getRemoveColumnIcon,
    getGroupByThisColumnIcon, getResotreDefaultColumnsIcon,
} from "./SearchControlIcons";
import { Enum } from "../../data/enum";
import { SearchMessage } from "../../data/uiMessages";
import { QueryTokenMessage, QueryTokenDateMessage, CollectionMessage, FilterOperation, OrderType } from "../../data/dynamicQueries";
import { AggregateFunction } from "../../data/dynamicQuery/tokens/aggregateToken";
import { CollectionElementType } from "../../data/dynamicQuery/tokens/collectionElementToken";
import { CollectionAnyAllType } from "../../data/dynamicQuery/tokens/collectionAnyAllToken";
import {
    SearchHelpMessage, FieldExpressionMessage, FilterFieldMessage, ColumnFieldMessage,
    QueryTokenHelpMessage,
} from "../../data/searchHelpMessages";

// Port of Signum's React/SearchControl/SearchControlVisualTips.tsx — the CONTENT of the four visual tips
// the SearchControl carries (`SearchVisualTip` in data/visualTip). Without it the "?" icons open an empty
// popover, so this is not optional decoration: it IS the feature.
//
// altea divergences, all from one root — **there is no QueryDescription**:
//  - Signum reads the entity type from `queryDescription.columns['Entity'].niceTypeName` and its sample
//    columns from `Finder.getDefaultColumns(qd)`. altea resolves both from the query's ROOT TOKEN, which
//    is what the call sites already pass (`Finder.getDefaultColumns` takes a token here).
//  - `isTypeEntity(queryDescription.queryKey)` becomes a check on the root token's own type: a "default
//    query" is one whose key IS an entity type.
//  - `formatHtml` is altea's own (data/globals) and takes the same `{0}` placeholders.
//
// The prose is Signum's, mechanically converted (see data/searchHelpMessages), so the two frameworks say
// the same thing to a user.

type SearchMode = "Search" | "Group" | "Find";

function getSearchMode(sc: SearchControlLoaded): SearchMode {
    if (sc.props.findOptions.groupResults)
        return "Group";
    if (sc.props.onDoubleClick != null)
        return "Find";
    return "Search";
}

/** The popover shell all four tips share — Signum repeats these three attributes in each. */
function TipPopover(p: {
    injected: OverlayInjectedProps;
    title: React.ReactNode;
    minWidth: number;
    maxWidth: string;
    children: React.ReactNode;
}): React.JSX.Element {
    return (
        <Popover id="popover-basic" {...p.injected}
            style={{ ...p.injected.style, minWidth: p.minWidth, maxWidth: p.maxWidth }}>
            <Popover.Header as="h3"><strong>{p.title}</strong></Popover.Header>
            <Popover.Body style={{ maxHeight: "calc(100vh - 300px)", overflowY: "auto" }}>
                {p.children}
            </Popover.Body>
        </Popover>
    );
}

export function SearchHelp(p: { sc: SearchControlLoaded; injected: OverlayInjectedProps }): React.JSX.Element {
    const sc = p.sc;
    const fo = sc.props.findOptions;
    const query = getQueryNiceName(fo.queryKey);
    // altea's `Finder.getQueryRoot` is ASYNC (there is no QueryDescription to read a root off), so the
    // root comes from a token the view already holds — every SearchControl has at least one column.
    const anyToken = fo.columnOptions.map(a => a.token).find(a => a != null);
    const type = anyToken == null ? query : rootOf(anyToken).niceTypeName();
    const searchMode = getSearchMode(sc);

    // The non-aggregate tokens the current view groups or orders by — what "grouped by …" names.
    const tokens = [
        ...fo.columnOptions.map(a => a.token),
        ...fo.orderOptions.map(a => a.token),
    ].filter((a): a is QueryToken => a != null && !a.isAggregate());

    const distinct = [...new Map(tokens.map(t => [t.fullKey(), t])).values()];
    const doubleClick = <strong><samp style={{ whiteSpace: "nowrap" }}>{SearchHelpMessage.DoubleClick.niceToString()}</samp></strong>;
    const rightClicking = <strong><samp style={{ whiteSpace: "nowrap" }}>{SearchHelpMessage.RightClicking.niceToString()}</samp></strong>;
    const rightClick = <strong><samp style={{ whiteSpace: "nowrap" }}>{SearchHelpMessage.RightClick.niceToString()}</samp></strong>;

    return (
        <TipPopover injected={p.injected} minWidth={600} maxWidth="min(900px, 90vw)"
            title={SearchHelpMessage.SearchHelp.niceToString()}>

            <div className="my-2">
                {SearchHelpMessage.The0IsVeryPowerfulButCanBeIntimidatingTakeSomeTimeToLearnHowToUseItWillBeWorthIt
                    .niceToString().formatHtml(<strong>{SearchHelpMessage.SearchControl.niceToString()}</strong>)}
            </div>

            <div className="pt-2"><strong>{SearchHelpMessage.TheBasics.niceToString()}</strong></div>

            {searchMode === "Search" &&
                <p className="my-2">
                    {SearchHelpMessage.CurrentlyWeAreInTheQuery0YouCanOpenA1ByClickingThe2IconOrDoing3InTheRowButNotInALink
                        .niceToString().formatHtml(
                            <strong><samp>{query}</samp></strong>,
                            <strong><samp>{type}</samp></strong>,
                            <FontAwesomeIcon aria-hidden={true} icon="arrow-right" color="#b1bac4" />,
                            doubleClick)}
                </p>}

            {searchMode === "Group" &&
                <p className="my-2">
                    {SearchHelpMessage.CurrentlyWeAreInTheQuery0GroupedBy1YouCanOpenAGroupByClickingThe2IconOrDoing3InTheRowButNotInALink
                        .niceToString().formatHtml(
                            <strong><samp>{query}</samp></strong>,
                            distinct.map(a => <strong key={a.fullKey()}><samp>{a.niceName()}</samp></strong>)
                                .joinCommaHtml(CollectionMessage.And.niceToString()),
                            <FontAwesomeIcon aria-hidden={true} icon="layer-group" color="#b1bac4" />,
                            doubleClick)}
                </p>}

            {searchMode === "Find" &&
                <p className="my-2">
                    {SearchHelpMessage.Doing0InTheRowWillSelectTheEntityAndCloseTheModalAutomaticallyAlternativelyYouCanSelectOneEntityAndClickOK
                        .niceToString().formatHtml(doubleClick)}
                </p>}

            <div className="pt-2"><strong>{SearchHelpMessage.OrderingResults.niceToString()}</strong></div>
            <p className="my-2">
                {SearchHelpMessage.YouCanOrderResultsByClickingInAColumnHeaderDefaultOrderingIs0AndByClickingAgainItChangesTo1YouCanOrderByMoreThanOneColumnIfYouKeep2DownWhenClickingOnTheColumnsHeader
                    .niceToString().formatHtml(
                        // The two sort directions and the modifier key are DECLARED names — OrderType is a
                        // reflected enum and SearchHelpMessage.Shift a message member, both translated in
                        // every shipped culture. They were hardcoded English literals, so this one
                        // sentence stayed half-English inside an otherwise translated paragraph.
                        <span><samp>{Enum.niceName(OrderType, "Ascending")}</samp> <FontAwesomeIcon aria-hidden={true} icon="sort-up" /></span>,
                        <span><samp>{Enum.niceName(OrderType, "Descending")}</samp> <FontAwesomeIcon aria-hidden={true} icon="sort-down" /></span>,
                        <kbd>{SearchHelpMessage.Shift.niceToString()}</kbd>)}
            </p>

            <div className="pt-2"><strong>{SearchHelpMessage.ChangeColumns.niceToString()}</strong></div>
            <p className="my-2">
                {SearchHelpMessage.YouAreNotLimitedToTheColumnsYouSeeTheDefaultColumnsCanBeChangedBy0InAColumnHeaderAndThenSelect123
                    .niceToString().formatHtml(
                        rightClicking,
                        <span>{getInsertColumnIcon()}<em>{SearchHelpMessage.InsertColumn.niceToString()}</em></span>,
                        <span>{getEditColumnIcon()}<em>{SearchHelpMessage.EditColumn.niceToString()}</em></span>,
                        <span>{getRemoveColumnIcon()}<em>{SearchHelpMessage.RemoveColumn.niceToString()}</em></span>)}
            </p>
            <p className="my-2">
                {SearchHelpMessage.YouCanAlso0TheColumnsByDraggingAndDroppingThemToAnotherPosition
                    .niceToString().formatHtml(<em>{SearchHelpMessage.Rearrange.niceToString()}</em>)}
            </p>
            <p className="my-2">
                {SearchHelpMessage.WhenInsertingTheNewColumnWillBeAddedBeforeOrAfterTheSelectedColumnDependingWhereYou0
                    .niceToString().formatHtml(rightClick)}
            </p>

            <div className="pt-2"><strong>{SearchMessage.AdvancedFilters.niceToString()}</strong></div>
            <p className="my-2">
                {SearchHelpMessage.ClickOnThe0ButtonToOpenTheAdvancedFiltersThisWillAllowYouCreateComplexFiltersManuallyBySelectingThe1OfTheEntityOrARelatedEntitiesAComparison2AndA3ToCompare
                    .niceToString().formatHtml(
                        <FontAwesomeIcon aria-hidden={true} icon="filter" />,
                        <strong>{FilterFieldMessage.Field.niceToString()}</strong>,
                        <strong>{FilterFieldMessage.Operator.niceToString()}</strong>,
                        <strong>{FilterFieldMessage.Value.niceToString()}</strong>)}
            </p>
            <p className="my-2">
                {SearchHelpMessage.TrickYouCan0OnA1AndChoose2ToQuicklyFilterByThisColumnEvenMoreYouCan3ToFilterByThis4Directly
                    .niceToString().formatHtml(
                        rightClick,
                        <strong>{SearchHelpMessage.ColumnHeader.niceToString()}</strong>,
                        <span>{getAddFilterIcon()}<em>{SearchMessage.AddFilter.niceToString()}</em></span>,
                        rightClicking,
                        <strong>{SearchMessage.Value.niceToString()}</strong>)}
            </p>

            <div className="pt-2"><strong>{SearchHelpMessage.GroupingResultsByOneOrMoreColumn.niceToString()}</strong></div>
            <p className="my-2">
                {SearchHelpMessage.YouCanGroupResultsBy0InAColumnHeaderAndSelecting1AllTheColumnsWillDisappearExceptTheSelectedOneAndAnAggregationColumnTypically2
                    .niceToString().formatHtml(
                        rightClicking,
                        <span>{getGroupByThisColumnIcon()}<em style={{ whiteSpace: "nowrap" }}>{SearchHelpMessage.GroupByThisColumn.niceToString()}</em></span>,
                        <em>{QueryTokenHelpMessage.Count.niceToString()}</em>)}
            </p>
        </TipPopover>
    );
}

export function GroupHelp(p: { injected: OverlayInjectedProps }): React.JSX.Element {
    return (
        <TipPopover injected={p.injected} minWidth={600} maxWidth="min(900px, 90vw)"
            title={SearchHelpMessage.GroupHelp.niceToString()}>

            <p className="my-2">
                {SearchHelpMessage.AnyNewColumnShouldEitherBeAnAggregate0OrItWillBeConsideredANewGroupKey1
                    .niceToString().formatHtml(
                        <span>(<samp>{aggregate("Count")}</samp>, <samp>{aggregate("Sum")}</samp>, <samp>{aggregate("Min")}</samp>...)</span>,
                        <FontAwesomeIcon aria-hidden={true} icon="key" color="gray" />)}
            </p>
            <p className="my-2">
                {SearchHelpMessage.OnceGroupingYouCanFilterNormallyOrUsingAggregatesAsTheField0
                    .niceToString().formatHtml(<span><code>HAVING</code> {SearchHelpMessage.InSql.niceToString()}</span>)}
            </p>
            <p className="my-2">
                {SearchHelpMessage.FinallyYouCanStopGroupingBy0InAColumnHeaderAndSelect1
                    .niceToString().formatHtml(
                        <strong><samp style={{ whiteSpace: "nowrap" }}>{SearchHelpMessage.RightClicking.niceToString()}</samp></strong>,
                        <span>{getResotreDefaultColumnsIcon()}<em style={{ whiteSpace: "nowrap" }}>{SearchHelpMessage.RestoreDefaultColumns.niceToString()}</em></span>)}
            </p>
        </TipPopover>
    );
}

export function FilterHelp(p: { queryToken: QueryToken; injected: OverlayInjectedProps }): React.JSX.Element {
    const [expanded, setExpanded] = React.useState(false);
    const root = rootOf(p.queryToken);
    const type = root.niceTypeName();
    const queryName = getQueryNiceName(root.queryName);
    // Signum's `isTypeEntity(queryKey)`: a "default query" is the one whose key IS an entity type, and it
    // is named after that type — so there is nothing to distinguish from the query's own name.
    const isDefaultQuery = queryName === type;
    const sampleColumns = Finder.getDefaultColumns(root).slice(0, 3);

    return (
        <TipPopover injected={p.injected} minWidth={400}
            maxWidth={expanded ? "min(900px, 90vw)" : "min(600px, 90vw)"}
            title={FilterFieldMessage.FiltersHelp.niceToString()}>

            <div className="my-2">
                {FilterFieldMessage.AFilterConsistsOfA0AComparison1AndAConstant2.niceToString().formatHtml(
                    <strong>{FilterFieldMessage.Field.niceToString()}</strong>,
                    <strong>{FilterFieldMessage.Operator.niceToString()}</strong>,
                    <strong>{FilterFieldMessage.Value.niceToString()}</strong>)}
            </div>

            <ul>
                <li>
                    <div className="my-2">
                        <strong>{FilterFieldMessage.Field.niceToString()}: </strong>
                        {SearchHelpMessage.AQueryExpressionCouldBeAnyColumnOfThe.niceToString()}{" "}
                        <strong><samp>{isDefaultQuery ? type : queryName}</samp></strong>
                        {sampleColumns.length > 0 && <>
                            {" ("}{SearchHelpMessage.Like.niceToString()}{" "}
                            {sampleColumns.map(c => <strong key={c.fullKey()}><samp>{c.niceName()}</samp></strong>)
                                .joinCommaHtml(", ")}
                            {") "}
                        </>}
                        {isDefaultQuery
                            ? <>{SearchHelpMessage.OrAnyOtherFieldThatYouSeeInThe.niceToString()}{" "}
                                <strong><samp>{type}</samp></strong>{" "}
                                {SearchHelpMessage.WhenYouClick.niceToString()}{" "}</>
                            : <>{SearchHelpMessage.OrAnyOtherFieldThatYouSeeInTheProjectWhenYouClick.niceToString()}{" "}</>}
                        <FontAwesomeIcon aria-hidden={true} icon="arrow-right" color="#b1bac4" />{" "}
                        {SearchHelpMessage.IconOrAnyRelatedEntity.niceToString()}
                    </div>
                    <LearnMoreAboutFieldExpressions expanded={expanded} onSetExpanded={setExpanded} showAny />
                </li>
                <li>
                    <div className="my-2">
                        <strong>{FilterFieldMessage.Operator.niceToString()}: </strong>
                        {SearchHelpMessage.TheOperationThatWillBeUsedToCompareThe.niceToString()}{" "}
                        <strong><samp>{FilterFieldMessage.Field.niceToString()}</samp></strong>{" "}
                        {SearchHelpMessage.WithThe.niceToString()}{" "}
                        <strong><samp>{FilterFieldMessage.Value.niceToString()}</samp></strong>,{" "}
                        {SearchHelpMessage.Like.niceToString()}{" "}
                        <samp>{SearchHelpMessage.EqualsDistinctGreaterThan.niceToString()}</samp>,{" "}
                        {SearchHelpMessage.Etc.niceToString()}
                    </div>
                </li>
                <li>
                    <div className="my-2">
                        <strong>{FilterFieldMessage.Value.niceToString()}: </strong>
                        {SearchHelpMessage.TheValueThatWillBeComparedWithThe.niceToString()}{" "}
                        <strong><samp>{FilterFieldMessage.Field.niceToString()}</samp></strong>,{" "}
                        {SearchHelpMessage.TypicallyHasTheSameTypeAsTheFieldButSomeOperatorsLike.niceToString()}{" "}
                        <strong><samp>{filterOperation("IsIn")}</samp></strong>{" "}
                        {QueryTokenHelpMessage.And.niceToString()}{" "}
                        <strong><samp>{filterOperation("IsNotIn")}</samp></strong>{" "}
                        {SearchHelpMessage.AllowToSelectMultipleValues.niceToString()}
                    </div>
                </li>
            </ul>

            <strong>{FilterFieldMessage.AndOrGroups.niceToString()}</strong>
            <div className="my-2">
                {FilterFieldMessage.Using0YouCanGroupAFewFiltersTogether.niceToString().formatHtml(
                    <strong><samp>[+ {SearchMessage.AddOrGroup.niceToString()}]</samp></strong>,
                    <strong><samp>{SearchMessage.OrGroup.niceToString()}</samp></strong>,
                    <strong><samp>{SearchMessage.AndGroup.niceToString()}</samp></strong>)}
            </div>
            <div className="my-2">
                {FilterFieldMessage.FilterGroupsCanAlsoBeUsedToCombineFiltersForTheSameElement012
                    .niceToString().formatHtml(
                        <strong>{FilterFieldMessage.TheSameElement.niceToString()}</strong>,
                        <strong><samp>{collectionAnyAll("Any")}</samp></strong>,
                        <strong><samp>{collectionAnyAll("All")}</samp></strong>)}
            </div>
        </TipPopover>
    );
}

export function ColumnHelp(p: { queryToken: QueryToken; injected: OverlayInjectedProps }): React.JSX.Element {
    const [expanded, setExpanded] = React.useState(false);
    const root = rootOf(p.queryToken);
    const type = root.niceTypeName();
    const queryName = getQueryNiceName(root.queryName);
    const isDefaultQuery = queryName === type;

    return (
        <TipPopover injected={p.injected} minWidth={600} maxWidth="min(800px, 90vw)"
            title={ColumnFieldMessage.ColumnsHelp.niceToString()}>

            <div className="my-2">
                {SearchHelpMessage.YouAreEditingAColumnLetMeExplainWhatEachFieldDoes.niceToString()}
            </div>
            <ul>
                <li>
                    <strong>{SearchMessage.ColumnField.niceToString()}: </strong>
                    {isDefaultQuery
                        ? ColumnFieldMessage.YouCanSelectAFieldExpressionToPointToAnyFieldOfThe0OrAnyRelatedEntity
                            .niceToString().formatHtml(<strong>{type}</strong>)
                        : ColumnFieldMessage.YouCanSelectAFieldExpressionToPointToAnyColumnOfTheQuery0OrAnyFieldOf1OrAnyRelatedEntity
                            .niceToString().formatHtml(<strong>{queryName}</strong>, <strong>{type}</strong>)}
                    <LearnMoreAboutFieldExpressions expanded={expanded} onSetExpanded={setExpanded} showAny={false} />
                </li>
                <li>
                    <div className="my-2">
                        <strong>{SearchMessage.DisplayName.niceToString()}: </strong>
                        {ColumnFieldMessage.TheColumnHeaderTextIsTypicallyAutomaticallySetDependingOnTheFieldExpression
                            .niceToString().formatHtml(<strong>{SearchMessage.DisplayName.niceToString()}</strong>)}
                    </div>
                </li>
                <li>
                    <div className="my-2">
                        <strong>{SearchMessage.SummaryHeader.niceToString()}: </strong>
                        {ColumnFieldMessage.YouCanAddOneNumericValueToTheColumnHeaderLikeTheTotalSumOfTheInvoices
                            .niceToString().formatHtml(<samp>{aggregate("Sum")}</samp>)}
                    </div>
                </li>
                <li>
                    <div className="my-2">
                        <strong>{SearchMessage.CombineRowsWith.niceToString()}: </strong>
                        {ColumnFieldMessage.WhenATableHasManyRepeatedValuesInAColumnYouCanCombineThemVertically01
                            .niceToString().formatHtml(<code>rowSpan</code>, <strong><samp>{type}</samp></strong>)}
                    </div>
                </li>
            </ul>
        </TipPopover>
    );
}

/**
 * Signum's `LearnMoreAboutFieldExpressions` — the collapsible tour of what a field expression can be.
 *
 * Shared by the filter and column tips, which is why it is exported: a query token means the same thing
 * in both places.
 */
export function LearnMoreAboutFieldExpressions(p: {
    expanded: boolean;
    onSetExpanded: (expanded: boolean) => void;
    showAny: boolean;
}): React.JSX.Element {
    return (
        <div className="mb-2">
            <LinkButton title={undefined} onClick={() => p.onSetExpanded(!p.expanded)}>
                <FontAwesomeIcon aria-hidden={true} icon={p.expanded ? "chevron-up" : "chevron-down"} />{" "}
                {FieldExpressionMessage.LearnMoreAboutFieldExpressions.niceToString()}
            </LinkButton>

            {p.expanded && <div className="ms-4">
                <div className="my-2">
                    {FieldExpressionMessage.YouCanNavigateDatabaseRelationshipsByContinuingTheExpressionWithMoreItems.niceToString()}
                </div>
                <ul>
                    <li>
                        <strong>{FieldExpressionMessage.SimpleValues.niceToString()}: </strong>
                        {FieldExpressionMessage.AStringLikeHelloANumberLike.niceToString().formatHtml(
                            <em>{QueryTokenHelpMessage.Length.niceToString()}</em>,
                            <em>{QueryTokenHelpMessage.Modulo0.niceToString("")}</em>,
                            <em>{QueryTokenHelpMessage.Step0.niceToString("")}</em>)}
                    </li>
                    <li>
                        <strong style={{ color: "#5100a1" }}>{FieldExpressionMessage.Dates.niceToString()}: </strong>
                        {FieldExpressionMessage._0And1YouCanExtractsPartsOfTheDateByContinuingTheExpressionWith2ReturnANumberOr3ReturnADate
                            .niceToString().formatHtml(
                                <em>{QueryTokenMessage.Date.niceToString()}</em>,
                                <em>{QueryTokenMessage.DateTime.niceToString()}</em>,
                                <span><em>{QueryTokenHelpMessage.Month.niceToString()}</em>, <em>{QueryTokenHelpMessage.WeekNumber.niceToString()}</em>, <em>{QueryTokenHelpMessage.Day.niceToString()}</em></span>,
                                <span><em>{QueryTokenHelpMessage.MonthStart.niceToString()}</em>, <em>{QueryTokenHelpMessage.WeekStart.niceToString()}</em>, <em>{QueryTokenDateMessage.Date.niceToString()}</em></span>)}
                    </li>
                    <li>
                        <strong style={{ color: "#2b91af" }}>{FieldExpressionMessage.EntityRelationships.niceToString()}: </strong>
                        {FieldExpressionMessage.EntityRelationshipsAllowYouToNavigateToOtherTablesToGetFields.niceToString()}
                        {" ("}<code>LEFT JOIN</code> {FieldExpressionMessage.InSql.niceToString()}{")"}
                    </li>
                    <li>
                        <strong style={{ color: "#ce6700" }}>{FieldExpressionMessage.Collections.niceToString()}: </strong>
                        {FieldExpressionMessage.CollectionOfEntitiesOrRelationships.niceToString()}
                    </li>
                    <li>
                        <strong style={{ color: "blue" }}>{FieldExpressionMessage.CollectionOperators.niceToString()}:</strong>
                        <ul>
                            <li>
                                <strong>{collectionElement("Element")}: </strong>
                                {FieldExpressionMessage.MultipliesTheNumberOfRowsByAllTheElementsInTheCollection012
                                    .niceToString().formatHtml(
                                        <code>OUTER APPLY</code>,
                                        <code>LEFT JOIN LATERAL</code>,
                                        FieldExpressionMessage.InSql.niceToString(),
                                        <em>{collectionElement("Element")}</em>,
                                        <em>{collectionElement("Element2")}</em>,
                                        <em>{collectionElement("Element3")}</em>)}
                            </li>
                            {p.showAny &&
                                <li>
                                    <strong>
                                        {collectionAnyAll("Any")} / {collectionAnyAll("NotAny")} /{" "}
                                        {collectionAnyAll("All")} / {collectionAnyAll("NotAll")}:
                                    </strong>{" "}
                                    {FieldExpressionMessage.AllowsToAddFiltersThatUseConditionsOnTheCollectionElemens
                                        .niceToString().formatHtml(
                                            <code>EXISTS</code>,
                                            FieldExpressionMessage.InSql.niceToString(),
                                            <code>AND</code>,
                                            <code>OR</code>)}
                                </li>}
                        </ul>
                    </li>
                    <li>
                        <strong style={{ color: "green" }}>{FieldExpressionMessage.Aggregates.niceToString()}:</strong>{" "}
                        {FieldExpressionMessage.WhenGroupingAllowsToCollapseManyValuesInOneValue.niceToString()}
                        <ul>
                            <li>
                                <strong>{aggregate("Count")}:</strong>{" "}
                                {SearchHelpMessage.CanBeUsedAsTheFirstItemCountsTheNumberOfRowsOnEachGroup.niceToString()}
                            </li>
                            <li>
                                <strong>
                                    {aggregate("Min")}, {aggregate("Max")}, {aggregate("Average")},{" "}
                                    {FieldExpressionMessage.CountNotNull.niceToString()},{" "}
                                    {FieldExpressionMessage.CountDistinct.niceToString()} ..:
                                </strong>{" "}
                                {FieldExpressionMessage.CanOnlyBeUsedAfterAnotherField.niceToString()}
                            </li>
                        </ul>
                    </li>
                </ul>
                <div>
                    {FieldExpressionMessage.FinallyRememberThatYouCan01FullFieldExpression.niceToString().formatHtml(
                        <code>COPY</code>, <code>PASTE</code>, <kbd>Ctrl+C</kbd>, <kbd>Ctrl+V</kbd>)}
                </div>
            </div>}
        </div>
    );
}

/** The query's ROOT token — altea's stand-in for Signum's `queryDescription.columns['Entity']`. */
function rootOf(token: QueryToken): QueryToken {
    let current = token;
    while (current.parent != null)
        current = current.parent;
    return current;
}

// altea's enums are a numeric object plus a string-union of names, so a member's display name is
// `Enum.niceName(TheEnum, "Member")` where Signum writes `TheEnum.niceToString("Member")`.
function aggregate(member: "Count" | "Sum" | "Min" | "Max" | "Average"): string {
    return Enum.niceName(AggregateFunction, member);
}

function collectionElement(member: "Element" | "Element2" | "Element3"): string {
    return Enum.niceName(CollectionElementType, member);
}

function collectionAnyAll(member: "Any" | "NotAny" | "All" | "NotAll"): string {
    return Enum.niceName(CollectionAnyAllType, member);
}

function filterOperation(member: "IsIn" | "IsNotIn"): string {
    return Enum.niceName(FilterOperation, member);
}
