import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import type { TypeReference } from "../../reflection";
import { QueryTokenDateMessage } from "../../dynamicQueries";
import { QueryToken, SubTokensOptions, TR_DATE } from "./queryToken";

// Port of Signum's `DateToken`: the date (day-truncated) part of a date/time — `dt.date`
// (Signum's ToDateOnly). Groupable.
export class DateToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return "Date"; }
    // The KEY stays the literal "Date" (it is stored in user assets); only the caption is localized.
    override toString(): string { return QueryTokenDateMessage.Date.niceToString(); }
    niceName(): string { return `${this.toString()} of ${this._parent.toString()}`; }
    get type(): TypeReference { return TR_DATE; }
    get format(): string | undefined { return "d"; }
    get unit(): string | undefined { return undefined; }
    override get isGroupable(): boolean { return true; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return this._parent.getPropertyRoute(); }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
