/**
 * AccountLifecycle — owns acquire locks and rotation strategy.
 *
 * Handles: acquire, release, lock management, rotation strategy.
 * Uses AccountRegistry for entry access (no circular dep — one-way reference).
 */

import { getConfig } from "../config.js";
import { getModelPlanTypes, isPlanFetched } from "../models/model-store.js";
import { hasReachedCachedQuota } from "./quota-skip.js";
import { getRotationStrategy } from "./rotation-strategy.js";
import type { RotationStrategy, RotationState, RotationStrategyName } from "./rotation-strategy.js";
import type { AccountRegistry } from "./account-registry.js";
import type { AccountEntry, AcquiredAccount } from "./types.js";
import { isCfChallengeCooldownActive } from "./cf-challenge-cooldown.js";
import { QuotaBatchSelector, type QuotaBatchStateStore } from "./quota-batch-selector.js";

const ACQUIRE_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface AccountCapacitySummary {
  max_concurrent_per_account: number;
  total_slots: number;
  used_slots: number;
  available_slots: number;
}

export class AccountLifecycle {
  /** Per-account active leases. Each entry = one in-flight request. */
  private acquireLocks: Map<string, Array<{ leaseId: string; acquiredAt: number }>> = new Map();
  private nextLeaseId = 0;
  private strategy: RotationStrategy;
  private strategyName: RotationStrategyName;
  private quotaBatchSelector: QuotaBatchSelector;
  private rotationState: RotationState = { roundRobinIndex: 0 };
  private registry: AccountRegistry;

  constructor(
    registry: AccountRegistry,
    strategyName: RotationStrategyName,
    quotaBatchStateStore?: QuotaBatchStateStore,
  ) {
    this.registry = registry;
    this.strategyName = strategyName;
    this.strategy = getRotationStrategy(strategyName);
    this.quotaBatchSelector = new QuotaBatchSelector(quotaBatchStateStore);
  }

  private slotCount(entryId: string): number {
    return this.acquireLocks.get(entryId)?.length ?? 0;
  }

  private pushSlot(entryId: string): string {
    const leaseId = `${entryId}:${Date.now().toString(36)}:${(++this.nextLeaseId).toString(36)}`;
    const slots = this.acquireLocks.get(entryId);
    if (slots) {
      slots.push({ leaseId, acquiredAt: Date.now() });
    } else {
      this.acquireLocks.set(entryId, [{ leaseId, acquiredAt: Date.now() }]);
    }
    return leaseId;
  }

  private popSlot(entryId: string, leaseId?: string): boolean {
    const slots = this.acquireLocks.get(entryId);
    if (!slots) return false;
    if (leaseId === undefined) {
      slots.shift();
    } else {
      const index = slots.findIndex((slot) => slot.leaseId === leaseId);
      if (index < 0) return false;
      slots.splice(index, 1);
    }
    if (slots.length === 0) this.acquireLocks.delete(entryId);
    return true;
  }

  private cleanupStaleSlots(nowMs: number): void {
    // Auto-release stale slots (slots are chronological — if oldest is fresh, all are)
    for (const [id, slots] of this.acquireLocks) {
      if (nowMs - slots[0].acquiredAt <= ACQUIRE_LOCK_TTL_MS) continue;
      const fresh = slots.filter((slot) => nowMs - slot.acquiredAt <= ACQUIRE_LOCK_TTL_MS);
      const staleCount = slots.length - fresh.length;
      console.warn(
        `[AccountPool] Auto-releasing ${staleCount} stale slot(s) for ${id}`,
      );
      if (fresh.length === 0) {
        this.acquireLocks.delete(id);
      } else {
        this.acquireLocks.set(id, fresh);
      }
    }
  }

  acquire(options?: { model?: string; excludeIds?: string[]; preferredEntryId?: string }): AcquiredAccount | null {
    const nowMs = Date.now();
    const now = new Date(nowMs);

    const entries = this.registry.getAllEntries();
    for (const entry of entries) {
      this.registry.refreshStatus(entry, now);
    }

    this.cleanupStaleSlots(nowMs);

    const config = getConfig();
    const maxConcurrent = config.auth.max_concurrent_per_account ?? 3;
    const skipExhausted = config.quota?.skip_exhausted === true;
    const excludeSet = options?.excludeIds?.length ? new Set(options.excludeIds) : null;

    const available = entries.filter(
      (a) =>
        a.status === "active" &&
        this.slotCount(a.id) < maxConcurrent &&
        (!excludeSet || !excludeSet.has(a.id)) &&
        !isCfChallengeCooldownActive(a.id) &&
        (!skipExhausted || !hasReachedCachedQuota(a, options?.model)),
    );

    if (available.length === 0) return null;

    let candidates = available;
    if (options?.model) {
      const preferredPlans = getModelPlanTypes(options.model);
      if (preferredPlans.length > 0) {
        const planSet = new Set(preferredPlans);
        const matched = available.filter((a) => {
          if (!a.planType) return false;
          if (planSet.has(a.planType)) return true;
          return !isPlanFetched(a.planType);
        });
        if (matched.length > 0) {
          candidates = matched;
        } else {
          return null;
        }
      }
    }

    // Tier-based filtering: when configured, restrict to the highest available tier
    const tierPriority = config.auth.tier_priority;
    if (tierPriority && tierPriority.length > 0) {
      const tierOrder = new Map(tierPriority.map((t, i) => [t, i]));
      let bestIdx = Infinity;
      for (const c of candidates) {
        const idx = c.planType != null ? (tierOrder.get(c.planType) ?? Infinity) : Infinity;
        if (idx < bestIdx) bestIdx = idx;
      }
      if (bestIdx < Infinity) {
        const bestTier = tierPriority[bestIdx];
        const tierFiltered = candidates.filter((c) => c.planType === bestTier);
        if (tierFiltered.length > 0) candidates = tierFiltered;
      }
    }

    // Quota batches intentionally override stale conversation affinity. All
    // authoritative eligibility filters have already reduced `candidates`.
    let selected: AccountEntry;
    if (this.strategyName === "quota_batch") {
      selected = this.quotaBatchSelector.select(
        candidates,
        config.auth.quota_batch_percent,
        entries.map((entry) => entry.id),
        {
          model: options?.model,
          nowMs,
          maxQuotaAgeMs: Math.max(60_000, (config.quota?.refresh_interval_minutes ?? 5) * 120_000),
        },
      );
    } else if (options?.preferredEntryId) {
      const preferred = candidates.find((a) => a.id === options.preferredEntryId);
      selected = preferred ?? this.strategy.select(candidates, this.rotationState);
    } else {
      selected = this.strategy.select(candidates, this.rotationState);
    }
    const prevSlots = this.acquireLocks.get(selected.id);
    const prevSlotMs = prevSlots?.[prevSlots.length - 1]?.acquiredAt ?? null;
    const leaseId = this.pushSlot(selected.id);
    return {
      entryId: selected.id,
      leaseId,
      token: selected.token,
      accountId: selected.accountId,
      prevSlotMs,
    };
  }

  release(
    entryId: string,
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_tokens?: number;
      image_input_tokens?: number;
      image_output_tokens?: number;
      image_request_attempted?: boolean;
      image_request_succeeded?: boolean;
    },
    leaseId?: string,
  ): void {
    // Slot capacity is best-effort (TTL and status cleanup may already have
    // removed it), while usage accounting must preserve the historical
    // release semantics for the request that actually completed.
    this.popSlot(entryId, leaseId);
    this.registry.recordUsage(entryId, usage);
  }

  releaseWithoutCounting(entryId: string, leaseId?: string): void {
    this.popSlot(entryId, leaseId);
  }

  /** Clear all slots for an entry (called by facade on status mutations). */
  clearLock(entryId: string): void {
    this.acquireLocks.delete(entryId);
  }

  clearAllLocks(): void {
    this.acquireLocks.clear();
  }

  setRotationStrategy(name: RotationStrategyName): void {
    if (name !== this.strategyName) this.quotaBatchSelector.reset();
    this.strategyName = name;
    this.strategy = getRotationStrategy(name);
    this.rotationState.roundRobinIndex = 0;
  }

  getDistinctPlanAccounts(): Array<{
    planType: string;
    entryId: string;
    token: string;
    accountId: string | null;
    leaseId: string;
  }> {
    const now = new Date();
    const config = getConfig();
    const maxConcurrent = config.auth.max_concurrent_per_account ?? 3;
    const skipExhausted = config.quota?.skip_exhausted === true;
    const entries = this.registry.getAllEntries();
    for (const entry of entries) {
      this.registry.refreshStatus(entry, now);
    }

    const available = entries.filter(
      (a: AccountEntry) =>
        a.status === "active" &&
        this.slotCount(a.id) < maxConcurrent &&
        a.planType &&
        !isCfChallengeCooldownActive(a.id) &&
        (!skipExhausted || !hasReachedCachedQuota(a)),
    );

    const byPlan = new Map<string, AccountEntry[]>();
    for (const a of available) {
      const plan = a.planType!;
      let group = byPlan.get(plan);
      if (!group) {
        group = [];
        byPlan.set(plan, group);
      }
      group.push(a);
    }

    const result: Array<{ planType: string; entryId: string; token: string; accountId: string | null; leaseId: string }> = [];
    for (const [plan, group] of byPlan) {
      // Model catalog refreshes must not advance the request-routing batch.
      const selected = this.strategyName === "quota_batch"
        ? getRotationStrategy("sticky").select(group, this.rotationState)
        : this.strategy.select(group, this.rotationState);
      const leaseId = this.pushSlot(selected.id);
      result.push({
        planType: plan,
        entryId: selected.id,
        token: selected.token,
        accountId: selected.accountId,
        leaseId,
      });
    }

    return result;
  }

  getCapacitySummary(): AccountCapacitySummary {
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const config = getConfig();
    const maxConcurrent = config.auth.max_concurrent_per_account ?? 3;
    const skipExhausted = config.quota?.skip_exhausted === true;

    const entries = this.registry.getAllEntries();
    for (const entry of entries) {
      this.registry.refreshStatus(entry, now);
    }
    this.cleanupStaleSlots(nowMs);

    let totalSlots = 0;
    let usedSlots = 0;
    let availableSlots = 0;

    for (const entry of entries) {
      if (entry.status !== "active") continue;
      if (skipExhausted && hasReachedCachedQuota(entry)) continue;

      const used = Math.min(this.slotCount(entry.id), maxConcurrent);
      totalSlots += maxConcurrent;
      usedSlots += used;
      availableSlots += maxConcurrent - used;
    }

    return {
      max_concurrent_per_account: maxConcurrent,
      total_slots: totalSlots,
      used_slots: usedSlots,
      available_slots: availableSlots,
    };
  }
}
