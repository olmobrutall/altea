import * as React from "react";
import TextArea from "@altea/altea/client/Components/TextArea";
import { AccessibleRow, AccessibleTable } from "@altea/altea/client/Basics/AccessibleTable";
import { LinkButton } from "@altea/altea/client/Basics/LinkButton";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { Dic } from "@altea/altea/data/globals";
import { TranslationMessage } from "../../data/Translation";
import { TranslationClient } from "../TranslationClient";

// Port of Signum.Translation's Code/TranslationTypeTable.tsx — one table per TYPE, with a row per culture
// for the type's own name and a pair of rows per member.
//
// Every editable cell is either a plain textarea, or — when a machine translator suggested something — a
// SELECT over the suggestions with an "edit" escape hatch beside it. That is Signum's whole interaction
// model here, kept verbatim: reviewing a hundred suggestions should be a hundred keystrokes, not a
// hundred paste operations.
//
// altea divergences: none of substance; `KeyNames` becomes the plain `e.key` strings.

export function TranslationTypeTable(p: {
    type: TranslationClient.LocalizableType;
    result: TranslationClient.PackageResult;
    currentCulture: string | undefined;
}): React.JSX.Element {

    const { type, result } = p;

    function editCulture(loc: TranslationClient.LocalizedType): boolean {
        return p.currentCulture == undefined || p.currentCulture === loc.culture;
    }

    function RenderMembers(): React.ReactElement[] {
        const first = Dic.getValues(type.cultures)[0];
        const members = first == undefined ? [] : Dic.getKeys(first.members);

        return members.flatMap(me => [
            <AccessibleRow key={me}>
                <th className="leftCell">{TranslationMessage.Member.niceToString()}</th>
                <th colSpan={4}>{me}</th>
            </AccessibleRow>,
            ...Dic.getValues(type.cultures)
                .filter(loc => loc.members[me] != undefined)
                .map(loc => <TranslationMember key={me + "-" + loc.culture} type={type} loc={loc}
                    edit={editCulture(loc)} member={loc.members[me]} />),
        ]);
    }

    return (
        <AccessibleTable
            aria-label={TranslationMessage.TranslationsOverview.niceToString()}
            className="table st"
            mapCustomComponents={new Map<React.JSXElementConstructor<any>, string>([
                [TranslationTypeDescription as React.JSXElementConstructor<any>, "tr"],
                [RenderMembers as React.JSXElementConstructor<any>, "tr"],
            ])}
            multiselectable={false}
            key={type.type}
            style={{ width: "100%", margin: "10px 0" }}>
            <thead>
                <tr>
                    <th className="leftCell">{TranslationMessage.Type.niceToString()}</th>
                    <th colSpan={4} className="titleCell">
                        {type.type} ({[
                            type.hasDescription ? TranslationMessage.Singular.niceToString() : undefined,
                            type.hasPluralDescription ? TranslationMessage.Plural.niceToString() : undefined,
                            type.hasGender ? TranslationMessage.Gender.niceToString() : undefined,
                            type.hasMembers ? TranslationMessage.Member.niceToString() : undefined,
                        ].filter(a => a != undefined).join(" / ")})
                    </th>
                </tr>
            </thead>
            <tbody>
                {Dic.getValues(type.cultures)
                    .filter(loc => type.hasDescription && loc.typeDescription != undefined)
                    .map(loc => <TranslationTypeDescription key={loc.culture} edit={editCulture(loc)} loc={loc} result={result} type={type} />)}
                <RenderMembers />
            </tbody>
        </AccessibleTable>
    );
}

export function TranslationMember(p: {
    type: TranslationClient.LocalizableType;
    loc: TranslationClient.LocalizedType;
    member: TranslationClient.LocalizedMember;
    edit: boolean;
}): React.JSX.Element {

    const { type, loc, member, edit } = p;
    const [avoidCombo, setAvoidCombo] = React.useState(false);
    const forceUpdate = useForceUpdate();

    const focusWhenTyping = React.useCallback((ta: HTMLTextAreaElement | null) => {
        if (ta != null && avoidCombo) ta.focus();
    }, [avoidCombo]);

    // Every culture's suggestion for THIS member, whichever translator produced it.
    const suggestions = Dic.getValues(type.cultures)
        .filter(lt => lt.members[member.name]?.automaticTranslations != undefined)
        .flatMap(lt => lt.members[member.name].automaticTranslations!.map(at =>
            ({ culture: lt.culture, translatorName: at.translatorName, text: at.text })));

    return (
        <AccessibleRow>
            <td className="leftCell">{loc.culture}</td>
            <td colSpan={4} className="monospaceCell">
                {!edit ? member.description :
                    suggestions.length === 0 || avoidCombo ? (
                        <TextArea style={{ height: "24px", width: "90%" }} minHeight="24px" value={member.description ?? ""}
                            onChange={e => { member.description = e.currentTarget.value; forceUpdate(); }}
                            innerRef={focusWhenTyping} />
                    ) : (
                        <span>
                            <select value={member.description ?? ""}
                                onChange={e => { member.description = e.currentTarget.value; forceUpdate(); }}
                                onKeyDown={e => onEscapeToText(e, () => setAvoidCombo(true))}>
                                {initialElementIf(!member.description)}
                                {suggestions.map(a => <option key={a.culture + a.translatorName} value={a.text}
                                    title={TranslationMessage.From0using1_.niceToString(a.culture, a.translatorName)}>{a.text}</option>)}
                            </select>
                            &nbsp;
                            <LinkButton title={undefined} onClick={() => setAvoidCombo(true)}>{TranslationMessage.Edit.niceToString()}</LinkButton>
                        </span>
                    )}
            </td>
        </AccessibleRow>
    );
}

/** Space / F2 leave the suggestion combo for a free-text box — Signum's escape hatch. */
export function onEscapeToText(e: React.KeyboardEvent, avoidCombo: () => void): void {
    if (e.key === " " || e.key === "F2") {
        e.preventDefault();
        avoidCombo();
    }
}

export function initialElementIf(condition: boolean): React.JSX.Element[] {
    return condition ? [<option key="" value="">{" - "}</option>] : [];
}

export function TranslationTypeDescription(p: {
    type: TranslationClient.LocalizableType;
    loc: TranslationClient.LocalizedType;
    edit: boolean;
    result: TranslationClient.PackageResult;
}): React.JSX.Element {

    const { type, loc, edit } = p;
    const td = loc.typeDescription!;
    const [avoidCombo, setAvoidCombo] = React.useState(false);
    const forceUpdate = useForceUpdate();

    const suggestions = Dic.getValues(type.cultures)
        .filter(a => a.typeDescription?.automaticTranslations != undefined)
        .flatMap(a => a.typeDescription!.automaticTranslations!.map(at => ({ ...at, culture: a.culture })));

    const pronoms = p.result.cultures[loc.culture]?.pronoms ?? [];

    const focusWhenTyping = React.useCallback((ta: HTMLTextAreaElement | null) => {
        if (ta != null && avoidCombo) ta.focus();
    }, [avoidCombo]);

    // Typing a singular name asks the SERVER for its plural and gender in that culture — the whole reason
    // those two routes exist (the client has no pluralizer).
    function handleSingularBlur(value: string): void {
        td.description = value;
        void TranslationClient.API.pluralize(loc.culture, value).then(plural => { td.pluralDescription = plural; forceUpdate(); });
        void TranslationClient.API.gender(loc.culture, value).then(gender => { td.gender = gender ?? undefined; forceUpdate(); });
        forceUpdate();
    }

    // Picking a suggestion takes its singular, plural AND gender together — they came from one translation.
    function handleSelect(value: string): void {
        const line = value === "" ? undefined : suggestions.find(a => a.singular === value);
        td.description = line?.singular;
        td.pluralDescription = line?.plural;
        td.gender = line?.gender;
        forceUpdate();
    }

    const safe = (content: React.ReactNode): React.ReactNode =>
        content == null || content === false ? <span aria-hidden="true">&nbsp;</span> : content;

    return (
        <AccessibleRow>
            <th className="leftCell">{loc.culture}</th>
            <th className="smallCell monospaceCell">
                {safe(type.hasGender && pronoms.length > 0 && (edit ? (
                    <select value={td.gender ?? ""} onChange={e => { td.gender = e.currentTarget.value; forceUpdate(); }}
                        className={!td.gender && Boolean(td.description) ? "sf-mandatory" : undefined}>
                        {initialElementIf(!td.gender)}
                        {pronoms.map(a => <option key={a.gender} value={a.gender}>{a.singular}</option>)}
                    </select>
                ) : pronoms.filter(a => a.gender === td.gender).map(a => a.singular).join("")))}
            </th>
            <th className="monospaceCell">
                {safe(!edit ? td.description :
                    suggestions.length === 0 || avoidCombo ? (
                        <TextArea style={{ height: "24px", width: "90%" }} minHeight="24px" value={td.description ?? ""}
                            onChange={e => { td.description = e.currentTarget.value; forceUpdate(); }}
                            onBlur={e => handleSingularBlur(e.currentTarget.value)}
                            innerRef={focusWhenTyping} />
                    ) : (
                        <span>
                            <select value={td.description ?? ""} onChange={e => handleSelect(e.currentTarget.value)}
                                onKeyDown={e => onEscapeToText(e, () => setAvoidCombo(true))}>
                                {initialElementIf(!td.description)}
                                {suggestions.map(a => <option key={a.culture + a.translatorName} value={a.singular}
                                    title={TranslationMessage.From0using1_.niceToString(a.culture, a.translatorName)}>{a.singular}</option>)}
                            </select>
                            &nbsp;
                            <LinkButton title={undefined} onClick={() => setAvoidCombo(true)}>{TranslationMessage.Edit.niceToString()}</LinkButton>
                        </span>
                    ))}
            </th>
            <th className="smallCell">
                {safe(type.hasPluralDescription && type.hasGender
                    && pronoms.filter(a => a.gender === td.gender).map(a => a.plural).join(""))}
            </th>
            <th className="monospaceCell">
                {safe(type.hasPluralDescription && (edit ? (
                    <TextArea style={{ height: "24px", width: "90%" }} minHeight="24px" value={td.pluralDescription ?? ""}
                        className={!td.pluralDescription && Boolean(td.description) ? "sf-mandatory" : undefined}
                        onChange={e => { td.pluralDescription = e.currentTarget.value; forceUpdate(); }} />
                ) : td.pluralDescription))}
            </th>
        </AccessibleRow>
    );
}
