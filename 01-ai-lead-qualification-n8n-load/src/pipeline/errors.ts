/** Base class for errors we raise ourselves, as opposed to bugs. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Whether the caller (n8n, a form tool) should try the same request again. */
    readonly retryable: boolean,
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
    super(message, 'validation_error', false);
  }
}

/** The model answered, but not with something we can use. */
export class LlmContractError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'llm_contract_error', true, cause);
  }
}

export class LlmTimeoutError extends AppError {
  constructor(timeoutMs: number, cause?: unknown) {
    super(`LLM call exceeded ${timeoutMs}ms`, 'llm_timeout', true, cause);
  }
}

export class LlmRateLimitError extends AppError {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(message, 'llm_rate_limited', true, cause);
  }
}

export class CrmError extends AppError {
  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message, 'crm_error', retryable, cause);
  }
}

export class NotifierError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'notifier_error', true, cause);
  }
}
