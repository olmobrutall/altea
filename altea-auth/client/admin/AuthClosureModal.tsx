import * as React from "react";
import { Modal, Button } from "react-bootstrap";
import { openModal, type IModalProps } from "@altea/altea/client/Modals";
import { tryGetTypeInfo } from "@altea/altea/client/Reflection";
import { Operations } from "@altea/altea/client/Operations";
import { useForceUpdate } from "@altea/altea/client/Hooks";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import type { Lite } from "@altea/altea/data/lite";
import type { PropertyRulePack, OperationRulePack, QueryRulePack, TypeConditionSetModel, TypeConditionSymbol } from "../../data/Rules";
import { AuthAdminMessage } from "../../data/AuthMessages";
import { AuthAdminClient } from "./AuthAdminClient";
import { PropertyRulesTable } from "./PropertyRulePackControl";
import { OperationRulesTable } from "./OperationRulePackControl";
import { QueryRulesTable } from "./QueryRulePackControl";
import { type Slice } from "./AuthSlice";
import { SliceSelector } from "./SliceSelector";

// altea-only (no Signum analog — Parts are real entities). A per-type dimension drill-in
// (property/operation/query) opened from the Type-Auth grid renders ONE rule table per type in the SAME
// modal for the owner's transitive owned-part closure {owner ∪ parts}. A Part is hidden from the grid
// (it inherits the owner's TYPE rules) but its own property/operation/query rules stay editable here.
// Storage stays per-type: Save posts every pack independently. A part section is shown only when it has
// rules (so operation/query modals aren't cluttered with parts that have none; properties always do).

type Kind = "properties" | "operations" | "queries";
type AnyPack = PropertyRulePack | OperationRulePack | QueryRulePack;

interface AuthClosureModalProps extends IModalProps<undefined> {
    kind: Kind;
    roleId: number | string;
    roleStr: string;
    packs: AnyPack[]; // owner first, then parts (ordered by ownership depth)
    readOnly: boolean;
    initialTypeConditions?: Lite<TypeConditionSymbol>[]; // preselect a condition slice (from a condition-row drill-in)
}

const KIND_LABEL: Record<Kind, string> = { properties: "Property rules", operations: "Operation rules", queries: "Query rules" };

// The owner pack's condition SETS drive the shared slice selector (queries have none). Parts inherit the
// owner's conditions but store no sets of their own, so the selector is owner-driven and each part table
// binds to the same slice (a part with no matching condition rule shows the fallback for that slice).
const availableSets = (pack: AnyPack): TypeConditionSetModel[] =>
    "availableTypeConditions" in pack ? (pack as PropertyRulePack | OperationRulePack).availableTypeConditions : [];

function fetchPack(kind: Kind, typeName: string, roleId: number | string): Promise<AnyPack> {
    return kind === "properties" ? AuthAdminClient.API.fetchPropertyRulePack(typeName, roleId)
        : kind === "operations" ? AuthAdminClient.API.fetchOperationRulePack(typeName, roleId)
            : AuthAdminClient.API.fetchQueryRulePack(typeName, roleId);
}
function savePack(kind: Kind, pack: AnyPack): Promise<void> {
    return kind === "properties" ? AuthAdminClient.API.savePropertyRulePack(pack as PropertyRulePack)
        : kind === "operations" ? AuthAdminClient.API.saveOperationRulePack(pack as OperationRulePack)
            : AuthAdminClient.API.saveQueryRulePack(pack as QueryRulePack);
}
function renderTable(kind: Kind, pack: AnyPack, readOnly: boolean, markDirty: () => void, slice: Slice): React.JSX.Element {
    return kind === "properties" ? <PropertyRulesTable pack={pack as PropertyRulePack} readOnly={readOnly} markDirty={markDirty} slice={slice} />
        : kind === "operations" ? <OperationRulesTable pack={pack as OperationRulePack} readOnly={readOnly} markDirty={markDirty} slice={slice} />
            : <QueryRulesTable pack={pack as QueryRulePack} readOnly={readOnly} markDirty={markDirty} />;
}

const typeHeading = (pack: AnyPack): string => tryGetTypeInfo(pack.type.toString())?.getNiceName() ?? pack.type.toString();

function AuthClosureModal(p: AuthClosureModalProps): React.JSX.Element {
    const [show, setShow] = React.useState(true);
    const [packs, setPacks] = React.useState<AnyPack[]>(p.packs);
    const dirty = React.useRef(false);
    const saving = React.useRef(false);
    const forceUpdate = useForceUpdate();
    const markDirty = (): void => { dirty.current = true; forceUpdate(); };
    const [slice, setSlice] = React.useState<Slice>(p.initialTypeConditions);
    const ownerSets = availableSets(packs[0]);

    function handleSave(): void {
        if (saving.current) return;
        saving.current = true; forceUpdate();
        // Storage is per-type — post every pack (unchanged packs are a no-op: setRules deletes only
        // redundant rules), then refetch the whole closure so allowed/allowedBase reflect what persisted.
        void Promise.all(packs.map(pk => savePack(p.kind, pk)))
            .then(() => Promise.all(packs.map(pk => fetchPack(p.kind, pk.type.toString(), p.roleId))))
            .then(fresh => { Operations.notifySuccess(); dirty.current = false; saving.current = false; setPacks(fresh); })
            .catch(() => { saving.current = false; forceUpdate(); });
    }

    // Always show the owner (index 0); show a part only if it carries rules for this dimension.
    const sections = packs.filter((pk, i) => i === 0 || pk.rules.length > 0);

    return (
        <Modal size="lg" show={show} onExited={() => p.onExited!(undefined)} onHide={() => setShow(false)} className="sf-frame-modal">
            <div className="modal-header">
                <h1 className="modal-title h5">{KIND_LABEL[p.kind]} — {typeHeading(packs[0])} / {p.roleStr}</h1>
                <button type="button" className="btn-close" aria-label="Close" onClick={() => setShow(false)} />
            </div>
            <div className="modal-body">
                {ownerSets.length > 0 &&
                    <div className="mb-3 d-flex align-items-center gap-2">
                        <span className="text-muted small">Type conditions</span>
                        <SliceSelector available={ownerSets} slice={slice} onChange={setSlice} />
                    </div>}
                {sections.map((pk, i) => (
                    <div key={pk.type.toString()} className={i > 0 ? "mt-4" : undefined}>
                        <h6 className="text-muted">{typeHeading(pk)}</h6>
                        {renderTable(p.kind, pk, p.readOnly, markDirty, slice)}
                    </div>
                ))}
            </div>
            <div className="modal-footer">
                <Button variant="primary" disabled={!dirty.current || p.readOnly || saving.current} onClick={handleSave}>
                    {AuthAdminMessage.Save.niceToString()}
                </Button>
                <Button variant="secondary" onClick={() => setShow(false)}>{JavascriptMessage.Close.niceToString()}</Button>
            </div>
        </Modal>
    );
}

/** Open the per-type dimension drill-in for the owner's owned-part closure — one editable table per type
 *  in a single modal. `packs` is owner-first (already fetched by the caller). */
export function openAuthClosureModal(props: Omit<AuthClosureModalProps, keyof IModalProps<undefined>>): Promise<undefined> {
    return openModal<undefined>(<AuthClosureModal {...props} />);
}
