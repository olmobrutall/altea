import * as React from 'react'
import { TypeContext } from '@altea/altea/client/TypeContext'
import { AutoLine } from '@altea/altea/client/Lines/AutoLine'
import { EntityLine } from '@altea/altea/client/Lines/EntityLine'
import { EntityTable } from '@altea/altea/client/Lines/EntityTable'
import { EnumLine } from '@altea/altea/client/Lines/EnumLine'
import { TextBoxLine } from '@altea/altea/client/Lines/TextBoxLine'
import { LinkButton } from '@altea/altea/client/Basics/LinkButton'
import { Finder } from '@altea/altea/client/Finder'
import { useForceUpdate } from '@altea/altea/client/Hooks'
import { tryGetTypeInfo } from '@altea/altea/client/Reflection'
import { classes, Dic } from '@altea/altea/data/globals'
import type { Lite } from '@altea/altea/data/lite'
import type { Entity } from '@altea/altea/data/entity'
import type { TypeEntity } from '@altea/altea/data/typeEntity'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { colorSchemes } from './ColorUtils'
import { ColorPaletteClient, ColorScheme } from './ColorPaletteClient'
import { ColorPaletteEntity, ColorPaletteMessage, SpecificColorEmbedded } from '../../data/ColorPalette'
import '@altea/altea/data/globals/arrayExtensions'

// Port of Signum.Chart/ColorPalette/ColorPalette.tsx (the ColorPalette editor). Covers type / categoryName
// (color-scheme picker) / seed, the specificColors table, and the "fill automatically" magic wand.
//
// altea divergences, documented inline:
//  - Signum's `type` picker uses ConvertBinding + Navigator.API.getEnumEntities to edit an ENUM palette's
//    rows as an EnumLine over the enum members. altea's client TypeInfo.kind is currently always "Entity"
//    (enum-kind detection is a framework TODO), so the enum-specific editing path (ConvertBinding / the
//    enum fill in the magic wand) is DEFERRED; the editor treats the palette's type as an entity type.
//  - Signum's ColorSelector toggles between a [Format(Color)] ColorLine and an EnumLine. altea has no
//    ColorLine, so the free-color case uses a plain TextBoxLine (a hex/CSS color string).
//  - MList element wrappers are gone: `newMListElement(SpecificColorEmbedded.New(...))` →
//    `Object.assign(new SpecificColorEmbedded(), ...)` pushed onto the plain `specificColors` array.
//  - The findMany custom entity-formatter swatch (Signum's EntityLink + getViewIcon) is dropped — a plain
//    findMany with the override-hint message.
export default function ColorPalette(p: { ctx: TypeContext<ColorPaletteEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const forceUpdate = useForceUpdate();
    const ctx4 = ctx.subCtx({ formGroupStyle: "Basic" });

    const type = ctx4.value.type as TypeEntity | undefined;
    const typeCleanName = type?.cleanName;
    const ti = typeCleanName ? tryGetTypeInfo(typeCleanName) : undefined;

    const colors = ctx4.value.categoryName ? colorSchemes[ctx4.value.categoryName] : null;

    async function handleMagicWand(): Promise<void> {
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

            ctx.value.specificColors = fewEntities.map((e, i) => Object.assign(new SpecificColorEmbedded(), {
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
                ctx.value.specificColors = chosen.map(e => Object.assign(new SpecificColorEmbedded(), {
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

            {ti != null &&
                <EntityTable ctx={ctx.subCtx(e => e.specificColors)}
                    extraButtons={() => <LinkButton className={classes("sf-line-button", "sf-create")}
                        title={ColorPaletteMessage.FillAutomatically.niceToString()}
                        onClick={handleMagicWand}>
                        <FontAwesomeIcon aria-hidden={true} icon="wand-magic-sparkles" />
                    </LinkButton>}
                    columns={[
                        {
                            header: ti.getNiceName(),
                            template: ectx => <EntityLine ctx={ectx.subCtx(a => a.entity, { formGroupStyle: "SrOnly" })} />,
                        },
                        {
                            header: ColorPaletteMessage.ShowPalette.niceToString(),
                            template: ectx => <ColorSelector ctx={ectx.subCtx(a => a.color, { formGroupStyle: "SrOnly" })} colors={colors as string[] | null} />,
                        },
                    ]} />
            }
        </div>
    );
}

function ColorSelector(p: { ctx: TypeContext<string>, colors: string[] | null }): React.JSX.Element {

    const [custom, setCustom] = React.useState<boolean>(false);

    React.useEffect(() => {
        setCustom(p.colors == null || (p.ctx.value != null && !p.colors.includes(p.ctx.value)));
    }, [p.colors]);

    if (custom || p.colors == null)
        return <TextBoxLine ctx={p.ctx} extraButtons={() => switchButton()} />;

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
