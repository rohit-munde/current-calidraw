// Autosave queue for note scenes.
//
// - Keeps only the latest unsaved scene per note (newer edits replace older ones).
// - Sends one request at a time, so an older save can never land after a newer one.
// - A scene is removed from the queue only after its request succeeds. On failure it
//   stays queued (unless a newer edit replaced it) and is retried with backoff, or
//   right away when the browser comes back online or flush() is called.
//
// No React or DOM imports, so it can be unit tested with `node --test`.

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export type SaveFn = (noteId: number, scene: string, keepalive: boolean) => Promise<void>;

export type SaveQueueOptions = {
  save: SaveFn;
  /** Debounce before an edit is sent. */
  delayMs?: number;
  /** Waits between automatic retries after a failure; the last one repeats. */
  retryDelaysMs?: number[];
  /** Errors that retrying can't fix (e.g. the note was deleted): drop the scene. */
  isPermanent?: (err: unknown) => boolean;
  onStatus?: (status: SaveStatus) => void;
};

type Entry = { scene: string; topicId: number };

// Browsers reject keepalive requests whose body is over 64KB (shared by all of them).
export const KEEPALIVE_MAX_BYTES = 60_000;
export const byteSize = (s: string) => new Blob([s]).size;

export function createSaveQueue(opts: SaveQueueOptions) {
  const delayMs = opts.delayMs ?? 1000;
  const retryDelays = opts.retryDelaysMs ?? [1000, 2000, 5000, 10_000, 30_000];

  const pending = new Map<number, Entry>();
  let inFlight: { noteId: number; topicId: number } | null = null;
  // Notes deleted from the UI: a failure for them is expected, not an error to show.
  const discarded = new Set<number>();
  let running: Promise<boolean> | null = null;
  let failures = 0;
  let lastError: unknown = null;
  let everSaved = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastStatus: SaveStatus | null = null;

  function status(): SaveStatus {
    if (inFlight) return "saving";
    if (lastError) return "error";
    if (pending.size) return "pending";
    return everSaved ? "saved" : "idle";
  }

  function emit() {
    const s = status();
    if (s !== lastStatus) {
      lastStatus = s;
      opts.onStatus?.(s);
    }
  }

  function clearTimers() {
    clearTimeout(debounce);
    clearTimeout(retry);
    debounce = retry = undefined;
  }

  function scheduleRetry() {
    const wait = retryDelays[Math.min(failures - 1, retryDelays.length - 1)];
    clearTimeout(retry);
    retry = setTimeout(() => {
      retry = undefined;
      void drain();
    }, wait);
  }

  function canSendOnUnload(): boolean {
    if (inFlight) return false;
    let total = 0;
    for (const e of pending.values()) total += byteSize(e.scene);
    return total <= KEEPALIVE_MAX_BYTES;
  }

  // Sends queued scenes one by one. Resolves true when everything is saved,
  // false if a save failed (the scene stays queued for retry).
  function drain(): Promise<boolean> {
    if (running) return running;
    if (!pending.size) return Promise.resolve(true);
    // Clear `running` from a promise callback: those always run after this function
    // returns, so the reset can't happen before the assignment below (which is what
    // went wrong when the run finished synchronously).
    const run = sendAll().finally(() => {
      if (running === run) running = null;
      emit();
    });
    running = run;
    return run;
  }

  async function sendAll(): Promise<boolean> {
    while (pending.size) {
      const [noteId, entry] = pending.entries().next().value as [number, Entry];
      pending.delete(noteId);
      inFlight = { noteId, topicId: entry.topicId };
      emit();
      try {
        await opts.save(noteId, entry.scene, false);
        failures = 0;
        lastError = null;
        everSaved = true;
      } catch (err) {
        if (discarded.has(noteId)) continue;
        if (opts.isPermanent?.(err)) {
          lastError = err; // e.g. note deleted elsewhere: report it, nothing to retry
          continue;
        }
        // Put it back unless a newer edit for this note arrived meanwhile.
        if (!pending.has(noteId)) pending.set(noteId, entry);
        lastError = err;
        failures++;
        scheduleRetry();
        return false;
      } finally {
        inFlight = null;
        emit();
      }
    }
    return true;
  }

  return {
    /** Queue the latest scene for a note; it's sent after the debounce delay. */
    schedule(noteId: number, topicId: number, scene: string) {
      pending.set(noteId, { scene, topicId });
      emit();
      // While backing off after a failure, let the retry timer send it.
      if (retry) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = undefined;
        void drain();
      }, delayMs);
    },

    /** Send everything now and wait. True if nothing is left unsaved. */
    async flush(): Promise<boolean> {
      clearTimers();
      // A drain started before this call may not include edits queued since; loop until settled.
      for (;;) {
        const ok = await drain();
        if (!ok) return false;
        if (!pending.size) return true;
      }
    },

    /** Call when the browser reports it is back online. */
    retryNow() {
      if (pending.size && !running) {
        clearTimers();
        void drain();
      }
    },

    /** The queued (not yet saved) scene for a note, if any. */
    peek(noteId: number): string | undefined {
      return pending.get(noteId)?.scene;
    },

    /**
     * Forget queued scenes for notes that are being deleted. Returns an `undo`
     * that puts them back (if the delete fails), unless newer edits replaced them.
     */
    discard(match: (noteId: number, topicId: number) => boolean) {
      const removed = new Map<number, Entry>();
      const ids = new Set<number>();
      for (const [id, e] of pending) {
        if (match(id, e.topicId)) {
          pending.delete(id);
          removed.set(id, e);
          ids.add(id);
        }
      }
      if (inFlight && match(inFlight.noteId, inFlight.topicId)) ids.add(inFlight.noteId);
      for (const id of ids) discarded.add(id);
      if (!pending.size) clearTimers();
      emit();
      return () => {
        for (const id of ids) discarded.delete(id);
        for (const [id, e] of removed) if (!pending.has(id)) this.schedule(id, e.topicId, e.scene);
      };
    },

    /** Something is queued or a request is still on its way. */
    hasUnsaved: () => pending.size > 0 || inFlight != null,

    /**
     * Whether everything unsaved can be handed to keepalive requests on page hide:
     * nothing in flight (a second request could overtake it) and the total body is
     * within the browser's keepalive budget.
     */
    canSendOnUnload,

    /**
     * Page is going away: fire keepalive requests for what's queued. The browser may
     * still drop them; this is best effort and nothing is awaited.
     */
    sendOnUnload() {
      if (!canSendOnUnload()) return;
      clearTimers();
      for (const [id, e] of pending) void opts.save(id, e.scene, true).catch(() => {});
      pending.clear();
    },

    status,
  };
}

export type SaveQueue = ReturnType<typeof createSaveQueue>;

/**
 * Guards against out-of-order responses: each call to `begin()` invalidates
 * the previous ones, and `isCurrent(token)` tells whether a response still matters.
 */
export function createLatest() {
  let current = 0;
  return {
    begin: () => ++current,
    isCurrent: (token: number) => token === current,
  };
}
