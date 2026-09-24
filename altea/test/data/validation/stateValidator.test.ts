import { test, describe } from "vitest";
import assert from "node:assert/strict";
import "@altea/altea/data/globals";
import { entityIntegrityCheck } from "@altea/altea/data/validation";
import { ValidationMessage, StateValidator, validate } from "@altea/altea/data/validators";
import { Entity } from "@altea/altea/data/entity";
import { entity } from "@altea/altea/data/decorators";
import { Enum } from "@altea/altea/data/enum";
import { Temporal } from "@altea/altea/data/basics";
import { getTypeInfo } from "@altea/altea/data/reflection";

// Signum's StateValidator: per state, whether each listed property is necessary (true), not allowed
// (false) or either (null). The shape is ReNew's RoleAssignment, whose dates follow its status.

@entity("Main", "Transactional")
@validate<AssignmentSample>((as, field) => assignmentStates.validate(as, field))
class AssignmentSample extends Entity {
    status: AssignmentStatus = AssignmentStatus.Interested;
    fromDate: Temporal.PlainDate | null = null;
    toDate: Temporal.PlainDate | null = null;
}

enum AssignmentStatus {
    Interested,
    Assigned,
    Rejected,
    Finished,
}

const assignmentStates = new StateValidator(AssignmentSample,
    a => a.status,                    "fromDate", "toDate")
    .add(AssignmentStatus.Interested, false,      false   )
    .add(AssignmentStatus.Assigned,   true,       null    )
    .add(AssignmentStatus.Rejected,   null,       null    )
    .add(AssignmentStatus.Finished,   true,       true    );

// For the error cases: a validator no entity calls.
@entity("Main", "Transactional")
class MisconfiguredSample extends Entity {
    status: AssignmentStatus = AssignmentStatus.Interested;
    fromDate: Temporal.PlainDate | null = null;
    toDate: Temporal.PlainDate | null = null;
}

const errorsOf = (e: Entity) => entityIntegrityCheck(e, "Saving")?.errors ?? {};
const day = Temporal.PlainDate.from("2024-07-01");

describe("StateValidator", () => {

    test("not allowed / necessary per state, with the state's nice name", () => {
        const a = new AssignmentSample();
        a.fromDate = day;
        assert.equal(errorsOf(a)["fromDate"],
            ValidationMessage._0IsNotAllowedOnState1.niceToString("From date", Enum.niceName(AssignmentStatus, AssignmentStatus.Interested)));

        a.status = AssignmentStatus.Finished;
        assert.equal(errorsOf(a)["fromDate"], undefined);
        assert.equal(errorsOf(a)["toDate"],
            ValidationMessage._0IsNecessaryOnState1.niceToString("To date", Enum.niceName(AssignmentStatus, AssignmentStatus.Finished)));
    });

    test("a class-level @validate is one rule asked about every field", () => {
        assert.equal(getTypeInfo(AssignmentSample)!.propertyValidation?.length, 1);
        const a = new AssignmentSample();
        a.fromDate = day;
        assert.deepEqual(Object.keys(errorsOf(a)), ["fromDate"]);
    });

    test("null means either", () => {
        const a = new AssignmentSample();
        a.status = AssignmentStatus.Rejected;
        assert.deepEqual(errorsOf(a), {});
        a.fromDate = day;
        a.toDate = day;
        assert.deepEqual(errorsOf(a), {});
    });

    test("the queries a view or an operation asks", () => {
        assert.equal(assignmentStates.necessary(AssignmentStatus.Assigned, "fromDate"), true);
        assert.equal(assignmentStates.isAllowed(AssignmentStatus.Assigned, "toDate"), null);
        assert.equal(assignmentStates.isAllowed(AssignmentStatus.Assigned, "status"), undefined);

        const a = new AssignmentSample();
        assert.equal(assignmentStates.previewErrors(a, AssignmentStatus.Finished, false),
            [ValidationMessage._0IsNecessary.niceToString("From date"), ValidationMessage._0IsNecessary.niceToString("To date")].join("\n"));
    });

    test("a row of the wrong length, or an unregistered state, is refused", () => {
        assert.throws(() => new StateValidator(MisconfiguredSample, a => a.status, "fromDate", "toDate").add(AssignmentStatus.Assigned, true),
            /has 1 values instead of 2/);

        const partial = new StateValidator(MisconfiguredSample, a => a.status, "fromDate")
            .add(AssignmentStatus.Assigned, true);
        assert.throws(() => partial.validate(new MisconfiguredSample(), "fromDate"), /not registered/);
    });
});
