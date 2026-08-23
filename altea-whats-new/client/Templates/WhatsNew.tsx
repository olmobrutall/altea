import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { AutoLine } from "@altea/altea/client/Lines/AutoLine";
import { EntityLine } from "@altea/altea/client/Lines/EntityLine";
import { EntityCombo } from "@altea/altea/client/Lines/EntityCombo";
import { EntityTabRepeater } from "@altea/altea/client/Lines/EntityTabRepeater";
import type { TypeContext } from "@altea/altea/client/TypeContext";
import { Binding } from "@altea/altea/client/binding";
import { PropertyRoute } from "@altea/altea/data/propertyRoute";
import { Finder } from "@altea/altea/client/Finder";
import { Navigator } from "@altea/altea/client/Navigator";
import { Constructor } from "@altea/altea/client/Constructor";
import SelectorModal from "@altea/altea/client/SelectorModal";
import type { TypeInfo } from "@altea/altea/data/reflection";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { QueryEntity } from "@altea/altea/data/queryEntity";
import { TypeEntity } from "@altea/altea/data/typeEntity";
import { OperationSymbol } from "@altea/altea/data/operations";
import { PermissionSymbol } from "@altea/altea-auth/data/Rules";
import { FileLine } from "@altea/altea-files/client/Components/FileLine";
import type { Entity, Type } from "@altea/altea/data/entity";
import {
    WhatsNewEntity, WhatsNewFileType, WhatsNewMessage, WhatsNewMessageEmbedded,
} from "../../data/WhatsNew";
import { WhatsNewClient } from "../WhatsNewClient";
import WhatsNewHtmlEditor from "../WhatsNewHtmlEditor";

// Port of Signum.WhatsNew's Templates/WhatsNew.tsx — the editor: the status (read-only, the operations move
// it), the name, the preview picture, what the item is `related` to, and one tab per culture.
//
// altea divergences:
//  - the two FileLines NAME their file type: `[DefaultFileType]` is reflected in Signum and altea has no
//    counterpart (the accommodation @altea/altea-help's image handler documents).
//  - `ctx.memberInfo(wn => wn.related)` → `ctx.memberInfo("related")`: the quote-transformer does not
//    rewrite lambdas in JSX ATTRIBUTES, and this call sits in the component body but reads the same route,
//    so the string form is used for consistency with the rest of the repo's Line props.
export default function WhatsNew(p: { ctx: TypeContext<WhatsNewEntity> }): React.JSX.Element {
    const ctx = p.ctx;
    const forceUpdate = useForceUpdate();

    function selectContentType(filter: (ti: TypeInfo) => boolean): Promise<TypeInfo | undefined> {
        // ALTEA: Signum splits a ", "-joined clean-name list with `getTypeInfos(pr.type)`; altea holds the
        // target ctors STRUCTURALLY on the TypeReference, so the implementations are read off it directly.
        const route = PropertyRoute.root(WhatsNewEntity).addMember("related");
        return SelectorModal.chooseType(route.type.typeInfos().filter(filter), {
            buttonDisplay: ti => {
                const icon = getDefaultIcon(ti);
                if (icon == null)
                    return ti.getNiceName();
                return <><FontAwesomeIcon aria-hidden={true} icon={icon.icon as never} color={icon.iconColor} />
                    <span className="ms-2">{ti.getNiceName()}</span></>;
            },
        });
    }

    return (
        <div>
            <AutoLine ctx={ctx.subCtx(w => w.status)} readOnly />
            <AutoLine ctx={ctx.subCtx(w => w.name)} />
            <FileLine ctx={ctx.subCtx(w => w.previewPicture)}
                fileType={WhatsNewFileType.WhatsNewPreviewFileType} mandatory />
            <EntityLine ctx={ctx.subCtx(w => w.related)}
                onFind={() => selectContentType(ti => Navigator.isFindable(ti.ctor as Type<Entity>))
                    .then(ti => ti && Finder.find(ti.ctor as Type<Entity>))}
                onCreate={() => selectContentType(ti => Navigator.isCreable(ti.ctor as Type<Entity>))
                    .then(ti => ti && Constructor.construct(ti.ctor as Type<Entity>))} />
            <EntityTabRepeater ctx={ctx.subCtx(w => w.messages)} onChange={forceUpdate}
                getComponent={mctx => <WhatsNewMessageComponent ctx={mctx} invalidate={forceUpdate} />} />
        </div>
    );
}

export function WhatsNewMessageComponent(p: {
    ctx: TypeContext<WhatsNewMessageEmbedded>;
    invalidate: () => void;
}): React.JSX.Element {
    const ec = p.ctx.subCtx({ labelColumns: 4 });

    return (
        <div>
            <EntityCombo ctx={ec.subCtx(e => e.culture)} label={WhatsNewMessage.Language.niceToString()}
                onChange={p.invalidate} />
            <AutoLine ctx={ec.subCtx(e => e.title)} onChange={p.invalidate} />
            <div>
                <p>{ec.subCtx(e => e.description).niceName()}</p>
                <WhatsNewHtmlEditor binding={Binding.create(ec.value, w => w.description)} />
            </div>
        </div>
    );
}

/** Signum's `getDefaultIcon` — the four framework `Related` types, then whatever an app registered. */
function getDefaultIcon(ti: TypeInfo): WhatsNewClient.IconColor | null {
    switch (ti.ctor) {
        case TypeEntity: return { icon: "object-group", iconColor: "#229954" };
        case QueryEntity: return { icon: "rectangle-list", iconColor: "#52BE80" };
        case OperationSymbol: return { icon: "key", iconColor: "#F1C40F" };
        case PermissionSymbol: return { icon: "key", iconColor: "#F1C40F" };
    }

    const conf = WhatsNewClient.configs[ti.ctor!.name];
    return conf == undefined || conf.length === 0 ? null : conf[0].getDefaultIcon();
}
