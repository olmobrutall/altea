import type { Entity, PrimaryKey, Type } from "../data/entity";

// Framework exception types the API exception filter (exceptionFilter.ts) maps to HTTP status codes.
// Real classes (checked with `instanceof`), not string-name matching.

// Port of Signum.Engine's EntityNotFoundException (old/Framework/Signum/Engine/Exceptions.cs) —
// thrown when a retrieve finds no row for the requested id(s). Maps to HTTP 404.
export class EntityNotFoundException extends Error {
    constructor(public readonly type: Type<Entity>, public readonly ids: PrimaryKey[]) {
        super(`${type.name} with id ${ids.join(", ")} not found`);
        this.name = "EntityNotFoundException";
    }
}

// altea equivalents of the .NET BCL exceptions Signum's SignumExceptionFilterAttribute maps (both →
// HTTP 403 Forbidden). They are framework primitives — the auth layer (altea-auth) throws them once
// wired — declared in core so the exception filter can map them without depending on the auth module.
export class UnauthorizedAccessException extends Error {
    constructor(message = "Unauthorized access") {
        super(message);
        this.name = "UnauthorizedAccessException";
    }
}

export class AuthenticationException extends Error {
    constructor(message = "Authentication required") {
        super(message);
        this.name = "AuthenticationException";
    }
}
