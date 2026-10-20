/**
 * Plan limits by account (spec 2026-10-20-limit-suns-design § 1). A plan's
 * limits belong to the Claude account, not to the directory: every
 * directory signed in to one account, on this device or on another member
 * of the group, reads the same windows. The desktop web and the phone group
 * the readings they get with the one function here.
 */

/** The hub topic the limits snapshot is published on. */
export const LIMITS_TOPIC = 'limits';

/**
 * How far back the recent pace of the 5-hour window looks (spec
 * 2026-10-20-limit-suns-design § 2): long enough for the slope to rest on
 * several probe reads, short enough to follow a burst.
 */
export const FIVE_HOUR_PACE_LOOKBACK_MS = 60 * 60_000;
/**
 * How far back the recent pace of a weekly window looks: a whole day, so
 * the night's pause and the working day's pace average out.
 */
export const WEEKLY_PACE_LOOKBACK_MS = 24 * 3_600_000;

/**
 * A reading older than this is out of date wherever it is shown (canvas
 * 60f, STALE): the sun gives no light and the estimates are hidden. With
 * the suns or the limits view open the server reads far more often, so
 * only a read that keeps failing, or a member gone offline, gets here.
 */
export const LIMITS_STALE_AFTER_MS = 15 * 60_000;

/** Whether an entry's reading is out of date: a failed read, never read, or older than `LIMITS_STALE_AFTER_MS`. */
export function limitsReadingStale(entry: Pick<LimitsEntry, 'readAt' | 'stale'>, now: number): boolean {
  if (entry.stale) return true;
  const at = entry.readAt === null ? NaN : Date.parse(entry.readAt);
  return !Number.isFinite(at) || now - at > LIMITS_STALE_AFTER_MS;
}

// ---- Window kinds --------------------------------------------------------
// The server's row kinds (`limits[].kind`) and the SDK's typed fixed windows
// name the same windows differently; each list holds both names.

const FIVE_HOUR_KINDS: readonly string[] = ['session', 'five_hour'];
const WEEKLY_ALL_KINDS: readonly string[] = ['weekly_all', 'seven_day'];
const WEEKLY_SCOPED_KINDS: readonly string[] = ['weekly_scoped', 'seven_day_opus', 'seven_day_sonnet'];

/** Whether a window kind is the 5-hour window. */
export function isFiveHourKind(kind: string): boolean {
  return FIVE_HOUR_KINDS.includes(kind);
}

/** Whether a window kind is the all-models weekly window. */
export function isWeeklyAllKind(kind: string): boolean {
  return WEEKLY_ALL_KINDS.includes(kind);
}

/** Whether a window kind is a weekly window of one model (Opus, Sonnet, or one the server scopes). */
export function isWeeklyScopedKind(kind: string): boolean {
  return WEEKLY_SCOPED_KINDS.includes(kind);
}

/** Who a directory's reading came from when it is another member's: `MachineRef`'s fields that matter here. */
export interface LimitsMachine {
  id: string;
  name: string;
}

/** What grouping reads of one directory's limits (`ClaudeDirLimits`). */
export interface LimitsEntry {
  /** The directory's id on its own device. */
  id: number;
  /** The account's e-mail, lower-cased; null (or absent, from an older Mac) when unknown. */
  account?: string | null;
  /**
   * The account and its organization (`ClaudeDirLimits.accountId`): one
   * e-mail can belong to two organizations, each with its own plan. Absent
   * from an older Mac, which is then grouped by the e-mail.
   */
  accountId?: string | null;
  /** Set on another member's directory; absent on this device's own. */
  machine?: LimitsMachine | null;
  /** ISO of the last good read; null when never read. */
  readAt: string | null;
  stale: boolean;
}

/** One account's limits, as the limits view and the suns show them. */
export interface LimitsAccountGroup<T extends LimitsEntry> {
  /**
   * What anything stored per account is keyed by (a sun's position): the
   * `accountId`, else the e-mail, or for a directory whose account is
   * unknown, `<machine>:<dir>` with `self` for this device's own.
   */
  key: string;
  /** The e-mail; null for a directory whose account is unknown. */
  account: string | null;
  /** The entry whose reading the group shows (`groupLimitsByAccount`). */
  reading: T;
  /** Every directory the group covers, in the order they came. */
  entries: T[];
  /** The other members it covers, each once, in the order they came; this device's own are not listed. */
  machines: LimitsMachine[];
  /** Whether it covers a directory of this device. */
  local: boolean;
}

/** The key of the group an entry falls in (`LimitsAccountGroup.key`). */
export function limitsAccountKey(entry: Pick<LimitsEntry, 'id' | 'account' | 'accountId' | 'machine'>): string {
  const id = entry.accountId?.trim();
  if (id) return id;
  const account = entry.account?.trim().toLowerCase();
  if (account) return account;
  return `${entry.machine?.id ?? 'self'}:${entry.id}`;
}

/**
 * Entries grouped by account, groups in the order their first entry came.
 * Readings of one account from several places are the same data, so the
 * freshest reading wins whole, its windows and estimates included; a stale
 * one (a failed read, an offline member) only when every reading of the
 * account is stale, and a directory never read only when none was.
 */
export function groupLimitsByAccount<T extends LimitsEntry>(entries: readonly T[]): LimitsAccountGroup<T>[] {
  const groups = new Map<string, LimitsAccountGroup<T>>();
  for (const entry of entries) {
    const key = limitsAccountKey(entry);
    let group = groups.get(key);
    if (!group) {
      const account = entry.account?.trim().toLowerCase() || null;
      group = { key, account, reading: entry, entries: [], machines: [], local: false };
      groups.set(key, group);
    } else if (fresher(entry, group.reading)) {
      group.reading = entry;
    }
    group.entries.push(entry);
    const machine = entry.machine;
    if (!machine) group.local = true;
    else if (!group.machines.some((m) => m.id === machine.id)) group.machines.push({ id: machine.id, name: machine.name });
  }
  return [...groups.values()];
}

/** Whether `a`'s reading beats `b`'s: any reading before none, not stale before stale, then the later read. */
function fresher(a: LimitsEntry, b: LimitsEntry): boolean {
  const aRead = readMs(a) > -Infinity;
  if (aRead !== readMs(b) > -Infinity) return aRead;
  if (a.stale !== b.stale) return !a.stale;
  return readMs(a) > readMs(b);
}

function readMs(entry: LimitsEntry): number {
  const at = entry.readAt === null ? NaN : Date.parse(entry.readAt);
  return Number.isFinite(at) ? at : -Infinity;
}

// ---- Another member's directories ----------------------------------------

/** Whether an entry is this device's own directory, not one another member's answer carried in. */
export function isOwnLimitsEntry(entry: { machine?: unknown }): boolean {
  return entry.machine === undefined || entry.machine === null;
}

/**
 * A directory's limits as they travel between devices (`ClaudeDirLimits`):
 * what grouping reads, checked; the windows, the extra usage and the waits
 * passed on as they came.
 */
export interface LimitsDir extends LimitsEntry {
  name: string;
  account: string | null;
  plan: string | null;
  tracked: boolean;
  windows: readonly unknown[];
  extraUsage: unknown;
  waits: readonly unknown[];
}

/**
 * One member's own directories, from its answer or its frame, as this device
 * shows them: each tagged with the member's `machine`, the e-mail
 * lower-cased. What does not read as a directory is left out, and so is one
 * the member itself carries as another's (no chaining). `offline`, the
 * reading is stale and its windows carry no estimate: the pace is not known
 * to hold while nothing reads them. `D` is the caller's directory type; the
 * windows, extra usage and waits are not checked against it.
 */
export function memberLimitsEntries<D extends LimitsDir, M extends LimitsMachine = LimitsMachine>(
  raw: readonly unknown[],
  machine: M,
  opts: { offline: boolean },
): (D & { machine: M })[] {
  const out: (D & { machine: M })[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'number' || !isOwnLimitsEntry(item)) continue;
    const windows = Array.isArray(item.windows) ? item.windows : [];
    const entry: LimitsDir & { machine: M } = {
      id: item.id,
      name: typeof item.name === 'string' ? item.name : '',
      // An older Mac sends neither: the directory is its own group, its plan unknown.
      account: typeof item.account === 'string' && item.account.trim() ? item.account.trim().toLowerCase() : null,
      accountId: typeof item.accountId === 'string' && item.accountId.trim() ? item.accountId.trim() : null,
      plan: typeof item.plan === 'string' && item.plan ? item.plan : null,
      machine,
      tracked: item.tracked !== false,
      readAt: typeof item.readAt === 'string' ? item.readAt : null,
      stale: item.stale === true || opts.offline,
      windows: opts.offline ? windows.map((w) => (isRecord(w) ? { ...w, estimate: null } : w)) : windows,
      extraUsage: item.extraUsage ?? null,
      waits: Array.isArray(item.waits) ? item.waits : [],
    };
    out.push(entry as D & { machine: M });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
