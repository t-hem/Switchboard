export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400,
    readonly fields: {path: string; message: string}[] = []) {
    super(message);
  }
}
