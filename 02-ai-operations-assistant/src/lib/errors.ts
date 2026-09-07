export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(message, 'validation_error', 422);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 'unauthorized', 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Not permitted') {
    super(message, 'forbidden', 403);
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(`${what} not found`, 'not_found', 404);
  }
}

/** Someone else changed the case first — the classic two-operators problem. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'conflict', 409);
  }
}

export class ClassifierError extends AppError {
  constructor(message: string, retryable = true, cause?: unknown) {
    super(message, 'classifier_error', 502, retryable, cause);
  }
}

export class ExecutionError extends AppError {
  constructor(message: string, retryable = true, cause?: unknown) {
    super(message, 'execution_error', 502, retryable, cause);
  }
}
