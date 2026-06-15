// Custom error class for attribute validation failures.
// Caught by the global error handler and serialized as
// { error: { code: "INVALID_ARGUMENT", message } } with HTTP 400.
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}
