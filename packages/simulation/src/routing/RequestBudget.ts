import { RoutingError } from "./errors.ts";

export class RequestBudget {
  private used = 0;
  constructor(readonly maximum: number) {}
  reserve(): void {
    if (this.used >= this.maximum) throw new RoutingError("BUDGET_EXHAUSTED");
    this.used += 1;
  }
  remaining(): number { return Math.max(0, this.maximum - this.used); }
}
