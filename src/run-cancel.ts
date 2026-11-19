export class RunCancelledError extends Error {
  constructor() {
    super("用户已终止执行");
    this.name = "RunCancelledError";
  }
}
