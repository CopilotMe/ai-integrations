export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
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
    super(message, 'validation_error', 422, false);
  }
}

/** Claude answered, but not with something usable. */
export class LlmContractError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'llm_contract_error', 502, true, cause);
  }
}

export class LlmTimeoutError extends AppError {
  constructor(timeoutMs: number, cause?: unknown) {
    super(`Claude call exceeded ${timeoutMs}ms`, 'llm_timeout', 504, true, cause);
  }
}

export class LlmRefusalError extends AppError {
  constructor(category: string | null) {
    super(
      `Claude declined to classify this lead${category ? ` (${category})` : ''}`,
      'llm_refusal',
      502,
      false,
    );
  }
}

export class CrmError extends AppError {
  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message, 'crm_error', 502, retryable, cause);
  }
}
