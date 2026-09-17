export type PosModalIsolationTarget = {
  inert: boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

type IsolationSnapshot<T extends PosModalIsolationTarget> = Readonly<{
  target: T;
  inert: boolean;
  ariaHidden: string | null;
}>;

type ModalEntry<T extends PosModalIsolationTarget> = Readonly<{
  token: string;
  target: T;
  baseline: IsolationSnapshot<T>;
}>;

export type PosModalCloseResult<T extends PosModalIsolationTarget> = Readonly<{
  removed: boolean;
  wasTop: boolean;
  top: T | null;
}>;

/**
 * Pure isolation stack. The DOM adapter supplies background targets only when
 * the first modal opens, so importing and rendering remain SSR-safe.
 */
export class PosModalIsolationStack<T extends PosModalIsolationTarget> {
  private readonly entries: ModalEntry<T>[] = [];
  private background: IsolationSnapshot<T>[] | null = null;

  constructor(private readonly backgroundTargets: () => readonly T[]) {}

  get depth() {
    return this.entries.length;
  }

  open(token: string, target: T) {
    const normalizedToken = modalToken(token);
    if (this.entries.some(entry => entry.token === normalizedToken)) throw new Error("O token do modal já está ativo.");
    if (!this.entries.length) {
      this.background = distinct(this.backgroundTargets()).map(snapshot);
      this.background.forEach(item => isolate(item.target));
    }
    this.entries.push({ token: normalizedToken, target, baseline: snapshot(target) });
    this.reconcile();
  }

  close(token: string): PosModalCloseResult<T> {
    const normalizedToken = modalToken(token);
    const index = this.entries.findIndex(entry => entry.token === normalizedToken);
    if (index < 0) return Object.freeze({ removed: false, wasTop: false, top: this.top() });
    const wasTop = index === this.entries.length - 1;
    const [removed] = this.entries.splice(index, 1);
    restore(removed.baseline);
    if (this.entries.length) this.reconcile();
    else {
      this.background?.forEach(restore);
      this.background = null;
    }
    return Object.freeze({ removed: true, wasTop, top: this.top() });
  }

  isTop(token: string) {
    const normalizedToken = modalToken(token);
    return this.entries.at(-1)?.token === normalizedToken;
  }

  has(token: string) {
    const normalizedToken = modalToken(token);
    return this.entries.some(entry => entry.token === normalizedToken);
  }

  top() {
    return this.entries.at(-1)?.target ?? null;
  }

  private reconcile() {
    const last = this.entries.length - 1;
    this.entries.forEach((entry, index) => index === last ? restore(entry.baseline) : isolate(entry.target));
  }
}

/** Returns the deterministic destination when Tab is fully managed by a modal. */
export function nextPosModalFocusIndex(count: number, currentIndex: number, shiftKey: boolean) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("A quantidade de controles focáveis é inválida.");
  if (!count) return -1;
  if (!Number.isSafeInteger(currentIndex) || currentIndex < 0 || currentIndex >= count) return shiftKey ? count - 1 : 0;
  return shiftKey ? (currentIndex - 1 + count) % count : (currentIndex + 1) % count;
}

function snapshot<T extends PosModalIsolationTarget>(target: T): IsolationSnapshot<T> {
  return Object.freeze({ target, inert: target.inert, ariaHidden: target.getAttribute("aria-hidden") });
}

function isolate(target: PosModalIsolationTarget) {
  target.inert = true;
  target.setAttribute("aria-hidden", "true");
}

function restore(snapshotValue: IsolationSnapshot<PosModalIsolationTarget>) {
  snapshotValue.target.inert = snapshotValue.inert;
  if (snapshotValue.ariaHidden == null) snapshotValue.target.removeAttribute("aria-hidden");
  else snapshotValue.target.setAttribute("aria-hidden", snapshotValue.ariaHidden);
}

function distinct<T>(values: readonly T[]) {
  return [...new Set(values)];
}

function modalToken(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) throw new Error("O token do modal é inválido.");
  return normalized;
}
