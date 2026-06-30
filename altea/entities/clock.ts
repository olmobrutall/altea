import { Temporal } from "./basics";

// Server clock (Signum's Clock / SystemTime.Now). In a query `Clock.now` lowers to the
// database's current-timestamp; there's no in-memory body, so it throws. Lives in
// entities/ so the entity model can reference it without depending on the logic layer.
export const Clock = {
    get now(): Temporal.PlainDateTime {
        throw new Error("Clock.now is a query-only server-now constant");
    },
};
