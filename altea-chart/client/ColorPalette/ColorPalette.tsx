import * as React from 'react'
import { TypeContext } from '@altea/altea/client/TypeContext'
import type { IBinding } from '@altea/altea/client/binding'
import { PropertyRoute } from '@altea/altea/data/propertyRoute'
import { AutoLine } from '@altea/altea/client/Lines/AutoLine'
import { EntityLine } from '@altea/altea/client/Lines/EntityLine'
import { EntityTable } from '@altea/altea/client/Lines/EntityTable'
import { EnumLine } from '@altea/altea/client/Lines/EnumLine'
import { ColorLine } from '@altea/altea/client/Lines/TextBoxLine'
import { LinkButton } from '@altea/altea/client/Basics/LinkButton'
import { Finder } from '@altea/altea/client/Finder'
import { useForceUpdate } from '@altea/altea/client/Hooks'
import { tryGetTypeInfo } from '@altea/altea/client/Reflection'
import { classes, Dic } from '@altea/altea/data/globals'
import { Lite, LiteImp } from '@altea/altea/data/lite'
import type { Entity, Type, PrimaryKey } from '@altea/altea/data/entity'
import type { TypeEntity } from '@altea/altea/data/typeEntity'
import { resolveEnum } from '@altea/altea/data/registration'
import { EnumEntity, enumEntityMembers } from '@altea/altea/data/enumEntity'
import { Enum } from '@altea/altea/data/enum'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { colorSchemes } from './ColorUtils'
import { ColorPaletteClient, ColorScheme } from './ColorPaletteClient'
import { ColorPaletteEntity, ColorPaletteMessage, ColorPaletteEntity_SpecificColors } from '../../data/ColorPalette'
import '@altea/altea/data/globals/arrayExtensions'

// Port of Signum.Chart/ColorPalette/ColorPalette.tsx (the ColorPalette editor). Covers type / categoryName
// (color-scheme picker) / seed, the specificColors table, and the "fill automatically" magic wand — for
// BOTH entity and ENUM palette types.
//
// altea divergences, documented inline:
//  - ENUM detection: Signum uses `ti.kind == "Enum"`, but altea's client TypeInfo.kind is always "Entity"
//    (a framework TODO). altea detects the enum from the palette type's clean name via `resolveEnum` (the
//    isomorphic enum registry), and builds the id↔member↔lite converter CLIENT-SIDE from `enumEntityMembers`
//    (enum tables seed id = the member's numeric value), so Signum's async Navigator.API.getEnumEntities
//    (deferred in altea — no reflection endpoint) isn't needed. An enum row's `entity` (a Lite of the
//    EnumEntity<E> row) is edited as an EnumLine over the member names via `ConvertBinding` (lite ⇄ name).
//  - Signum's ColorSelector toggles a [Format(Color)] ColorLine ↔ EnumLine; altea's ColorLine (a text box +
//    native color picker) backs the "show color" case, the scheme dropdown (EnumLine) the "show palette" case.
//  - MList element wrappers are gone: push `Object.assign(new ColorPaletteEntity_SpecificColors(), …)` onto the plain array.
export default function ColorPalette(p: { ctx: TypeContext<ColorPaletteEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const forceUpdate = useForceUpdate();
    const ctx4 = ctx.subCtx({ formGroupStyle: "Basic" });

    const type = ctx4.value.type as TypeEntity | undefined;
    const typeCleanName = type?.cleanName;

    // An enum-typed palette (resolveEnum resolves the clean name to the enum object) vs a regular entity type.
    const enumObj = typeCleanName ? resolveEnum(typeCleanName) : undefined;
    const isEnum = enumObj != null;
    const ti = (typeCleanName && !isEnum) ? tryGetTypeInfo(typeCleanName) : undefined;

    // The id↔member↔lite converter for an enum palette, built once per type (client-side; no server fetch).
    const enumConverter = React.useMemo(
        () => isEnum ? buildEnumConverter(enumObj!) : null,
        [typeCleanName, isEnum]);

    const colors = ctx4.value.categoryName ? colorSchemes[ctx4.value.categoryName] : null;

    // The `entity` column of the specificColors table for an enum: an EnumLine over the member names, backed
    // by a ConvertBinding that maps the stored Lite<EnumEntity<E>> ⇄ its member name.
    function withConverter(ectx: TypeContext<Lite<Entity> | null>): TypeContext<string | null> {
        return new TypeContext<string | null>(ectx, undefined, ectx.propertyRoute, new ConvertBinding(ectx.binding, enumConverter!));
    }

    async function handleMagicWand(): Promise<void> {
        // ENUM: fill one row per member, cycling through the scheme colors.
        if (isEnum && enumConverter != null) {
            const lites = enumConverter.names.map(n => enumConverter.nameToLite[n]);
            let step = lites.length == 0 ? 1 : Math.floor((colors?.length ?? 1) / lites.length);
            if (step == 0) step = 1;
            ctx.value.specificColors = lites.map((e, i) => Object.assign(new ColorPaletteEntity_SpecificColors(), {
                entity: e,
                color: colors ? colors[(i * step) % colors.length] : undefined,
            }));
            forceUpdate();
            return;
        }

        if (ti == null || typeCleanName == null)
            return;

        const fewEntities: Lite<Entity>[] | null =
            ti.lowPopulation || (await Finder.getQueryValue(typeCleanName, [])) < 20 ?
                await Finder.API.fetchAllLites({ types: typeCleanName }) :
                null;

        if (fewEntities != null) {
            let step = fewEntities.length == 0 ? 1 : Math.floor((colors?.length ?? 1) / fewEntities.length);
            if (step == 0)
                step = 1;

            ctx.value.specificColors = fewEntities.map((e, i) => Object.assign(new ColorPaletteEntity_SpecificColors(), {
                entity: e,
                color: colors ? colors[(i * step) % colors.length] : undefined,
            }));
            forceUpdate();
        }
        else {
            const chosen = await Finder.findMany({ queryName: typeCleanName }, {
                message: ColorPaletteMessage.Select0OnlyIfYouWantToOverrideTheAutomaticColor.niceToString(ti.getNicePluralName()),
            });

            if (chosen != null) {
                ctx.value.specificColors = chosen.map(e => Object.assign(new ColorPaletteEntity_SpecificColors(), {
                    entity: e,
                    color: colors ? ColorPaletteClient.calculateColor(String(e.id), colors, Number(ctx.value.seed ?? 0)) : undefined,
                }));
                forceUpdate();
            }
        }
    }

    return (
        <div>
            <div className="row">
                <div className="col-sm-4">
                    <EntityLine ctx={ctx4.subCtx(n => n.type)} readOnly={!ctx.value.isNew || ctx.value.specificColors.length > 0} onChange={forceUpdate} />
                </div>
                <div className="col-sm-4">
                    <EnumLine ctx={ctx4.subCtx(n => n.categoryName)} onChange={forceUpdate}
                        optionItems={Dic.getKeys(colorSchemes)}
                        onRenderDropDownListItem={oi => <div style={{ display: "flex", alignItems: "center", userSelect: "none" }}>
                            <ColorScheme colorScheme={oi.value} />
                            {oi.label}
                        </div>} />
                </div>
                <div className="col-sm-4">
                    <AutoLine ctx={ctx4.subCtx(n => n.seed)} />
                </div>
            </div>

            {(ti != null || (isEnum && enumConverter != null)) &&
                <EntityTable ctx={ctx.subCtx(e => e.specificColors)}
                    extraButtons={() => <LinkButton className={classes("sf-line-button", "sf-create")}
                        title={ColorPaletteMessage.FillAutomatically.niceToString()}
                        onClick={handleMagicWand}>
                        <FontAwesomeIcon aria-hidden={true} icon="wand-magic-sparkles" />
                    </LinkButton>}
                    columns={[
                        {
                            header: isEnum ? (Enum.niceTypeName(enumObj as Record<string, string | number>) ?? typeCleanName!) : ti!.getNiceName(),
                            template: ectx => isEnum
                                ? <EnumLine ctx={withConverter(ectx.subCtx(a => a.entity, { formGroupStyle: "SrOnly" }))} optionItems={enumConverter!.names} />
                                : <EntityLine ctx={ectx.subCtx(a => a.entity, { formGroupStyle: "SrOnly" })} />,
                        },
                        {
                            // The field's own niceName ("Color"), like a normal column header — not the
                            // ShowPalette message (which is only the mode-toggle button's tooltip).
                            header: PropertyRoute.root(ColorPaletteEntity_SpecificColors).addLambda(a => a.color).fieldInfo!.niceToString(),
                            template: ectx => <ColorSelector ctx={ectx.subCtx(a => a.color, { formGroupStyle: "SrOnly" })} colors={colors as string[] | null} />,
                        },
                    ]} />
            }
        </div>
    );
}

// Client-side enum converter (Signum's EnumConverter, built from getEnumEntities): the enum's members map
// to Lites of its EnumEntity<E> rows (id = the member's numeric value — how altea seeds enum tables), and
// back. No server round-trip.
interface ClientEnumConverter {
    names: string[];
    nameToLite: Record<string, Lite<Entity>>;
    idToName: Record<string, string>;
}

function buildEnumConverter(enumObj: object): ClientEnumConverter {
    const ctor = EnumEntity.typeFor(enumObj) as unknown as Type<Entity>;
    const members = enumEntityMembers(enumObj); // [{ id, name }]
    const nameToLite: Record<string, Lite<Entity>> = {};
    const idToName: Record<string, string> = {};
    for (const m of members) {
        nameToLite[m.name] = new LiteImp(m.id as PrimaryKey, ctor, m.name);
        idToName[String(m.id)] = m.name;
    }
    return { names: members.map(m => m.name), nameToLite, idToName };
}

// Port of Signum's ConvertBinding: exposes a Lite<EnumEntity<E>> field as its enum member NAME (for an
// EnumLine), converting via the client enum converter.
class ConvertBinding implements IBinding<string | null> {
    suffix: string;
    constructor(private readonly parent: IBinding<Lite<Entity> | null>, private readonly converter: ClientEnumConverter) {
        this.suffix = parent.suffix;
    }
    getValue(): string | null {
        const val = this.parent.getValue();
        return val ? (this.converter.idToName[String(val.id)] ?? null) : null;
    }
    setValue(val: string | null): void {
        this.parent.setValue(val == null ? null : this.converter.nameToLite[val]);
    }
    getIsReadonly(): boolean { return this.parent.getIsReadonly(); }
    getIsHidden(): boolean { return this.parent.getIsHidden(); }
    getError(): string | undefined { return this.parent.getError(); }
    setError(value: string | undefined): void { this.parent.setError(value); }
}

function ColorSelector(p: { ctx: TypeContext<string>, colors: string[] | null }): React.JSX.Element {

    const [custom, setCustom] = React.useState<boolean>(false);

    React.useEffect(() => {
        setCustom(p.colors == null || (p.ctx.value != null && !p.colors.includes(p.ctx.value)));
    }, [p.colors]);

    // "Show color" mode: a ColorLine (text + native color picker), Signum's [Format(Color)] ColorLine.
    if (custom || p.colors == null)
        return <ColorLine ctx={p.ctx} extraButtons={() => switchButton()} />;

    return <EnumLine ctx={p.ctx}
        optionItems={p.colors}
        onRenderDropDownListItem={oi => <span>
            <span style={{ backgroundColor: oi.value, height: "20px", width: "20px", display: "inline-block", marginBottom: "-6px" }} className="me-2" />
            {oi.label}
        </span>}
        extraButtons={() => switchButton()} />;

    function switchButton(): React.ReactElement {
        return (
            <LinkButton className={classes("sf-line-button", "sf-find", "btn input-group-text")}
                title={custom ? ColorPaletteMessage.ShowPalette.niceToString() : ColorPaletteMessage.ShowList.niceToString()}
                onClick={() => setCustom(!custom)}>
                <FontAwesomeIcon aria-hidden={true} icon={custom ? "palette" : "list"} />
            </LinkButton>
        );
    }
}
