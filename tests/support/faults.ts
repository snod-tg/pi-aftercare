export type FaultAction =
  | { type: 'error' | 'response_lost'; message?: string }
  | { type: 'delay'; ms: number }
  | { type: 'effect'; apply: () => void | Promise<void> };
export interface FaultRule { tool: string; when: 'before' | 'after'; occurrence?: number; action: FaultAction }
export interface FaultEvent { time: string; tool: string; when: 'before' | 'after'; occurrence: number; fault: FaultAction['type'] }

// Explicitly injected by tests; never enabled by user chat text or tool arguments.
export class ToolFaultInjector {
  readonly events: FaultEvent[] = [];
  private readonly counts = new Map<string, number>();
  constructor(private readonly rules: FaultRule[]) {
    for (const rule of rules) {
      if (!Number.isSafeInteger(rule.occurrence ?? 1) || (rule.occurrence ?? 1) < 1) throw new Error('非法故障序号');
      if (rule.action.type === 'delay' && (!Number.isSafeInteger(rule.action.ms) || rule.action.ms < 0 || rule.action.ms > 60000)) throw new Error('故障延迟需为0–60000ms');
    }
  }
  private async inject(tool: string, when: FaultRule['when'], occurrence: number) {
    for (const rule of this.rules) {
      if (rule.tool !== tool || rule.when !== when || (rule.occurrence ?? 1) !== occurrence) continue;
      this.events.push({ time: new Date().toISOString(), tool, when, occurrence, fault: rule.action.type });
      if (rule.action.type === 'delay') { const ms = rule.action.ms; await new Promise(resolve => setTimeout(resolve, ms)); }
      else if (rule.action.type === 'effect') await rule.action.apply();
      else throw new Error(`${rule.action.type === 'response_lost' ? 'RESPONSE_LOST' : 'INJECTED_TOOL_ERROR'}: ${rule.action.message ?? '测试故障'}`);
    }
  }
  async run<T>(tool: string, operation: () => T | Promise<T>): Promise<T> {
    const occurrence = (this.counts.get(tool) ?? 0) + 1;
    this.counts.set(tool, occurrence);
    await this.inject(tool, 'before', occurrence);
    const result = await operation();
    await this.inject(tool, 'after', occurrence);
    return result;
  }
}
