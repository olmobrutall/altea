import { msg } from "./utils/localization";

// Port of Signum's SearchHelpMessage (Signum/Entities/EnumMessages.cs) plus FieldExpressionMessage and
// FilterFieldMessage (Signum/DynamicQuery/Tokens/QueryTokenHelp.cs) — the prose the SearchControl's four
// VISUAL TIPS are made of.
//
// Converted MECHANICALLY from the C# enums (a member's `[Description]` if it has one, else nothing, which
// is exactly what `msg()` with no argument means here): 84 members of long English text is precisely where
// hand-transcription corrupts a string silently.
//
// They live in their own module rather than in data/uiMessages, because they are only ever loaded by the
// help popovers — a page that never opens one should not carry the text.

export const SearchHelpMessage = {
    SearchHelp: msg(),
    SearchControl: msg(),
    The0IsVeryPowerfulButCanBeIntimidatingTakeSomeTimeToLearnHowToUseItWillBeWorthIt: msg("The {0} is very powerful, but can be intimidating. Take some time to learn how to use it... will be worth it!"),
    TheBasics: msg(),
    CurrentlyWeAreInTheQuery0YouCanOpenA1ByClickingThe2IconOrDoing3InTheRowButNotInALink: msg("Currently we are in the query {0}, you can open a {1} by clicking the {2} icon, or doing {3} in the row (but not in a link!)."),
    CurrentlyWeAreInTheQuery0GroupedBy1YouCanOpenAGroupByClickingThe2IconOrDoing3InTheRowButNotInALink: msg("Currently we are in the query {0}, grouped by {1}, you can open a group by clicking the {2} icon, or doing {3} in the row (but not in a link!)."),
    DoubleClick: msg("double-click"),
    GroupedBy: msg(),
    Doing0InTheRowWillSelectTheEntityAndCloseTheModalAutomaticallyAlternativelyYouCanSelectOneEntityAndClickOK: msg("Doing {0} in the row will select the entity and close the modal automatically, alternatively you can select one entity and click OK."),
    YouCanUseThePreparedFiltersOnTheTopToQuicklyFindThe0YouAreLookingFor: msg("You can use the prepared filters on the top to quickly find the {0} you are looking for."),
    OrderingResults: msg("Ordering results"),
    YouCanOrderResultsByClickingInAColumnHeaderDefaultOrderingIs0AndByClickingAgainItChangesTo1YouCanOrderByMoreThanOneColumnIfYouKeep2DownWhenClickingOnTheColumnsHeader: msg("You can order results by clicking in a column header, default ordering is {0} and by clicking again it changes to {1}. You can order by more than one column if you keep {2} down when clicking on the columns header."),
    Ascending: msg(),
    Descending: msg(),
    Shift: msg(),
    ChangeColumns: msg("Change columns"),
    YouAreNotLimitedToTheColumnsYouSeeTheDefaultColumnsCanBeChangedBy0InAColumnHeaderAndThenSelect123: msg("You are not limited to the columns you see! The default columns can be changed by {0} in a column header and then select {1}, {2} or {3}."),
    RightClicking: msg("right-clicking"),
    RightClick: msg("right-click"),
    InsertColumn: msg("Insert Column"),
    EditColumn: msg("Edit Column"),
    RemoveColumn: msg("Remove Column"),
    YouCanAlso0TheColumnsByDraggingAndDroppingThemToAnotherPosition: msg("You can also {0} the columns by dragging and dropping them to another position."),
    Rearrange: msg("rearrange"),
    WhenInsertingTheNewColumnWillBeAddedBeforeOrAfterTheSelectedColumnDependingWhereYou0: msg("When inserting, the new column will be added before or after the selected column, depending where you {0}."),
    ClickOnThe0ButtonToOpenTheAdvancedFiltersThisWillAllowYouCreateComplexFiltersManuallyBySelectingThe1OfTheEntityOrARelatedEntitiesAComparison2AndA3ToCompare: msg("Click on the {0} button to open the Advanced filters, this will allow you create complex filters manually by selecting the {1} of the entity (or a related entities), a comparison {2} and a {3} to compare."),
    TrickYouCan0OnA1AndChoose2ToQuicklyFilterByThisColumnEvenMoreYouCan3ToFilterByThis4Directly: msg("Trick: You can {0} on a {1} and choose {2} to quickly filter by this column. Even more, you can {3} to filter by this {4} directly."),
    ColumnHeader: msg("column header"),
    GroupingResultsByOneOrMoreColumn: msg("Grouping results by one (or more) column"),
    YouCanGroupResultsBy0InAColumnHeaderAndSelecting1AllTheColumnsWillDisappearExceptTheSelectedOneAndAnAggregationColumnTypically2: msg("You can group results by {0} in a column header and selecting {1}. All the columns will disapear except the selected one and an agregation column (typically {2})."),
    GroupByThisColumn: msg("Group by this column"),
    GroupHelp: msg("Group help"),
    AnyNewColumnShouldEitherBeAnAggregate0OrItWillBeConsideredANewGroupKey1: msg("Any new column should either be an aggregate {0} or it will be considered a new group key {1}."),
    OnceGroupingYouCanFilterNormallyOrUsingAggregatesAsTheField0: msg("Once grouping you can filter normally or using aggregates as the field ({0})."),
    InSql: msg("in SQL"),
    FinallyYouCanStopGroupingBy0InAColumnHeaderAndSelect1: msg("Finally you can stop grouping by {0} in a column header and select {1}"),
    RestoreDefaultColumns: msg("Restore default columns"),
    AQueryExpressionCouldBeAnyFieldOfThe: msg("A query expression could be any field of the"),
    Like: msg("like"),
    OrAnyOtherFieldThatYouSeeInThe: msg("or any other field that you see in the"),
    WhenYouClick: msg("when you click"),
    IconOrAnyRelatedEntity: msg("icon) or any related entity."),
    AQueryExpressionCouldBeAnyColumnOfThe: msg("A query expression could be any column of the"),
    OrAnyOtherFieldThatYouSeeInTheProjectWhenYouClick: msg("or any other field that you see in the Project when you click"),
    TheOperationThatWillBeUsedToCompareThe: msg("The operation that will be used to compare the"),
    WithThe: msg("with the"),
    EqualsDistinctGreaterThan: msg("Equals, Distinct, GreaterThan"),
    Etc: msg("etc..."),
    TheValueThatWillBeComparedWithThe: msg("The value that will be compared with the"),
    TypicallyHasTheSameTypeAsTheFieldButSomeOperatorsLike: msg("typically has the same type as the field, but some operators like"),
    AllowToSelectMultipleValues: msg("allow to select multiple values."),
    YouAreEditingAColumnLetMeExplainWhatEachFieldDoes: msg("You are editing a column, let me explain what each field does:"),
    CanBeUsedAsTheFirstItemCountsTheNumberOfRowsOnEachGroup: msg("Can be used as the first item, counts the number of rows on each group."),
};

export const FieldExpressionMessage = {
    LearnMoreAboutFieldExpressions: msg(),
    YouCanNavigateDatabaseRelationshipsByContinuingTheExpressionWithMoreItems: msg("You can navigate database relationships by continuing the expression with more items."),
    SimpleValues: msg(),
    AStringLikeHelloANumberLike: msg("A string (like \\\"Hello\\\") a number (like 3.14) or a boolean (true). Sometimes you will be able to continue the expression, like the {0} of a string or calculating the {1} or {2} of a number (for histograms)."),
    Dates: msg(),
    _0And1YouCanExtractsPartsOfTheDateByContinuingTheExpressionWith2ReturnANumberOr3ReturnADate: msg("{0} and {1}, you can extracts parts of the date by continuing the expression with {2} (return a number) or {3} (return a date)"),
    EntityRelationships: msg("Entity Relationships"),
    EntityRelationshipsAllowYouToNavigateToOtherTablesToGetFields: msg(),
    InSql: msg("in SQL"),
    Collections: msg(),
    CollectionOfEntitiesOrRelationships: msg("Collection of entities or relationships."),
    CollectionOperators: msg(),
    MultipliesTheNumberOfRowsByAllTheElementsInTheCollection012: msg("Multiplies the number of rows by all the elements in the collection. ({0} / {1} {2}). All the field expressions using the same {3} reuse the same {4}, to avoid this use {5} / {6}."),
    AllowsToAddFiltersThatUseConditionsOnTheCollectionElemens: msg("Allows to add filters that use conditions on the collection elemens (without multiplying the number of rows) ({0} {1}). To combine different conditons use {2} / {3} groups with a prefix (see below)."),
    Aggregates: msg(),
    WhenGroupingAllowsToCollapseManyValuesInOneValue: msg("When allows to collapse many values in one value"),
    CountNotNull: msg("Count Not Null"),
    CountDistinct: msg("Count Distinct"),
    CanOnlyBeUsedAfterAnotherField: msg("Can only be used after another field."),
    FinallyRememberThatYouCan01FullFieldExpression: msg("Finally, remember that you can {0} / {1} full field expression to other filters or columns by opening the drop-down-list and using {2} / {3}."),
};

export const FilterFieldMessage = {
    FiltersHelp: msg(),
    AFilterConsistsOfA0AComparison1AndAConstant2: msg("A filter consists of a {0}, a comparison {1} and a constant {2}."),
    Field: msg(),
    Operator: msg(),
    Value: msg(),
    FieldCanBeAnyFieldOfThe0OrAnyRelatedEntity: msg("Field can be any field of the {0}, or any related entity."),
    FieldCanBeAnyColumnOfTheQuery0OrAnyFieldOf1: msg("Field can be any column of the query {0}, or any field of {1}."),
    AndOrGroups: msg("AND / OR Groups"),
    Using0YouCanGroupAFewFiltersTogether: msg("Using {0} you can group a few filters together so that only one condition needs to be satisfied. Inside an {1} you can create a nested {2} and so on. "),
    FilterGroupsCanAlsoBeUsedToCombineFiltersForTheSameElement012: msg("Filter groups can also be used to combine filters for {0} of a collection when using operator like {1} or {2} in the prefix field."),
    TheSameElement: msg("the same element"),
};

export const ColumnFieldMessage = {
    ColumnsHelp: msg(),
    YouCanSelectAFieldExpressionToPointToAnyColumnOfTheQuery0OrAnyFieldOf1OrAnyRelatedEntity: msg("You can select a field expression to point to any column of the query {0}, or any field of {1} or any related entity."),
    YouCanSelectAFieldExpressionToPointToAnyFieldOfThe0OrAnyRelatedEntity: msg("You can select a field expression to point to any field of the {0}, or any related entity."),
    TheColumnHeaderTextIsTypicallyAutomaticallySetDependingOnTheFieldExpression: msg("The column header text is typically automatically set depending on the field expression, but can be customized by setting {0} manually."),
    YouCanAddOneNumericValueToTheColumnHeaderLikeTheTotalSumOfTheInvoices: msg("You can add one numeric value to the column header (like the total sum of the invoices), using a field expression ending in an aggregate (like {0},...). Note: The aggregation includes rows that may not be visible due to pagination!"),
    WhenATableHasManyRepeatedValuesInAColumnYouCanCombineThemVertically01: msg("When a table has many repeated values in a column you can combine them vertically ({0}) either when the value is the same, or when is the same and belongs to the same {1}."),
    NoteTheAggregationIncludesRowsThatMayNotBeVisibleDueToPagination: msg("Note: The aggregation includes rows that may not be visible due to pagination."),
};


/**
 * The five token labels the help text names that altea's own `QueryTokenMessage` /
 * `QueryTokenDateMessage` do not carry.
 *
 * Signum's two enums are wider than altea's: altea's token classes build their nice names themselves, so
 * only the members something ELSE displays were ported. The help prose names five that nothing else does,
 * and they live here with the prose that needs them rather than widening a core enum for one consumer.
 */
export const QueryTokenHelpMessage = {
    Count: msg("Count"),
    And: msg("and"),
    Length: msg("Length"),
    Modulo0: msg("Modulo {0}"),
    Step0: msg("Step {0}"),
    Month: msg("Month"),
    WeekNumber: msg("Week number"),
    Day: msg("Day"),
    MonthStart: msg("Month start"),
    WeekStart: msg("Week start"),
};
