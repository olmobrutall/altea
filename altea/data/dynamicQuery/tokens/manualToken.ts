import type { PropertyRoute } from "../../propertyRoute";
import type { Implementations } from "../../implementations";
import { TypeReference } from "../../reflection";
import type { Lite } from "../../lite";
import { Entity } from "../../entity";
import { QueryToken, SubTokensOptions } from "./queryToken";

// Port of Signum's manual-token family (DynamicQuery/Tokens/ManualToken.cs + ManualContainerToken.cs +
// QuickLinksToken.cs). A "manual" token is one whose leaves are declared imperatively at runtime (the
// QuickLinkClient registers them via registerManualSubTokens), not derived from entity metadata — used
// to surface a quick link as a search-result COLUMN.
//
// Shape: an entity token exposes a ManualContainerToken (e.g. QuickLinksToken, key "[QuickLinks]"); that
// container resolves ANY child key to a ManualToken leaf (Signum's SubTokenInternal special-case). A leaf
// column projects a ManualCellDto per row — { lite, containerKey, tokenKey } — which the client's
// CellQuickLink formatter turns into the actual quick-link badge.
//
// altea divergences: the client leaves are REAL token-class instances (Signum's client synthesized flat
// DTOs with `queryTokenType: "Manual"`); the ManualCellDto value type is a plain TypeReference by name
// (no registered ManualCellDTO entity — the client never navigates into it).

// Signum's ManualCellDTO — the per-row column value a manual leaf projects.
export interface ManualCellDto {
    lite: Lite<Entity>;
    manualContainerTokenKey: string;
    manualTokenKey: string;
}

// The value TypeReference every manual token reports (Signum's `Type => typeof(ManualCellDTO)`). A
// name-only reference: filterType/isGroupable fall through to "not filterable / not groupable", and the
// client never expands sub-tokens off it.
export const TR_MANUAL_CELL = new TypeReference({ typeName: "ManualCellDTO" });

// Signum's abstract ManualContainerToken: the parent of a set of manual leaves. Its own value is opaque;
// it only groups the leaves and delegates authorization to its (entity) parent.
export abstract class ManualContainerToken extends QueryToken {
    constructor(private readonly _parent: QueryToken) {
        super();
        // Signum: "ManualContainer tokens only can be child of an entity type token".
        if (!_parent.type.is(Entity))
            throw new Error("ManualContainerToken can only be a child of an entity/lite token");
    }

    // The stable container key surfaced in fullKey (e.g. "[QuickLinks]"); also the registration key.
    abstract getTokenKey(): string;

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this.getTokenKey(); }
    override toString(): string { return this.getTokenKey(); }
    niceName(): string { return this.getTokenKey(); }
    get type(): TypeReference { return TR_MANUAL_CELL; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    override get hideInAutoExpand(): boolean { return true; }
    override hasManual(): boolean { return true; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    // The container's own metadata sub-tokens are empty; the leaves are injected at runtime — on the
    // CLIENT via getManualSubTokens (registerManualSubTokens), on the SERVER via the subToken override
    // below (Signum's SubTokenInternal: any key under a ManualContainerToken → a ManualToken).
    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }

    // Signum's SubTokenInternal special case: `if (this is ManualContainerToken mc) return new
    // ManualToken(mc, key, ...)`. Lets the server resolve `[QuickLinks].<anyKey>` when re-parsing a
    // column the client added, without knowing the registered quick-link set.
    override subToken(key: string, _options: SubTokensOptions): QueryToken | undefined {
        return new ManualToken(this, key);
    }
}

// Signum's QuickLinksToken — the manual container for quick links.
export class QuickLinksToken extends ManualContainerToken {
    getTokenKey(): string { return "[QuickLinks]"; }
}

// Signum's ManualToken — a single manual leaf. `display` carries the client-registered nice name / color
// (the server constructs one with no display, since it only builds the projection expression).
export class ManualToken extends QueryToken {
    constructor(
        private readonly _parent: ManualContainerToken,
        private readonly _key: string,
        readonly display?: { toStr?: string; niceName?: string; typeColor?: string; niceTypeName?: string },
    ) {
        super();
    }

    get parent(): QueryToken | undefined { return this._parent; }
    get key(): string { return this._key; }
    override toString(): string { return this.display?.toStr ?? this._key; }
    niceName(): string { return this.display?.niceName ?? this._key; }
    get type(): TypeReference { return TR_MANUAL_CELL; }
    get format(): string | undefined { return undefined; }
    get unit(): string | undefined { return undefined; }
    override niceTypeName(): string { return this.display?.niceTypeName ?? "Cell quick link"; }
    override hasManual(): boolean { return true; }
    override get isGroupable(): boolean { return false; }
    getImplementations(): Implementations | undefined { return undefined; }
    getPropertyRoute(): PropertyRoute | undefined { return undefined; }
    isAllowed(): string | null { return this._parent.isAllowed(); }

    protected subTokensOverride(_options: SubTokensOptions): QueryToken[] {
        return [];
    }
}
