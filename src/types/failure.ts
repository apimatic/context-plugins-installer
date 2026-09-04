/**
 * A problem the user can fix, as a value rather than a throw. Infrastructure
 * returns one inside a `Result`; only a bug throws. The CLI prints the message
 * as one line, then the hint, with no stack trace.
 */
export class Failure {
  constructor(
    readonly message: string,
    readonly hint?: string,
  ) {}
}
