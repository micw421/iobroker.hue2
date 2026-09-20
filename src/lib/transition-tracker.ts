export type TransitionStateWriter = (stateId: string, value: boolean) => void | Promise<void>;

/**
 * Tracks adapter-started Hue transitions.
 * One timer is used per transition operation, while per-state tokens prevent
 * older operations from clearing states that were superseded by newer ones.
 */
export class TransitionTracker {
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly tokens = new Map<string, number>();
    private nextToken = 0;

    public constructor(private readonly writeState: TransitionStateWriter) {}

    public async start(stateIds: string[], duration: number): Promise<void> {
        const uniqueStateIds = [...new Set(stateIds)];
        const token = ++this.nextToken;

        for (const stateId of uniqueStateIds) {
            this.tokens.set(stateId, token);
            await this.writeState(stateId, duration > 0);
        }

        if (duration === 0) return;

        const timer = setTimeout(() => {
            this.timers.delete(timer);
            for (const stateId of uniqueStateIds) {
                if (this.tokens.get(stateId) !== token) continue;
                this.tokens.delete(stateId);
                void this.writeState(stateId, false);
            }
        }, duration);

        this.timers.add(timer);
    }

    public async cancel(stateIds: string[]): Promise<void> {
        for (const stateId of new Set(stateIds)) {
            if (!this.tokens.has(stateId)) continue;
            this.tokens.delete(stateId);
            await this.writeState(stateId, false);
        }
    }

    public stop(): void {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.tokens.clear();
    }
}
