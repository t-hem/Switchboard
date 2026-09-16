import type { SettingsStore } from "./store.js";
/** No timers or integrations are started by the scaffold. Future workers share this gate. */
export class SchedulerShell {
  constructor(private readonly store: SettingsStore) {}
  status(): {state:"disabled"|"paused"|"unavailable"; reason:string; dispatchAvailable:false} {
    const {value} = this.store.current();
    if (!value.enabled) return {state:"disabled",reason:"Jobs is disabled",dispatchAvailable:false};
    if (value.paused) return {state:"paused",reason:"Jobs is paused",dispatchAvailable:false};
    return {state:"unavailable",reason:"Workers are not implemented yet; no jobs will run",dispatchAvailable:false};
  }
}
