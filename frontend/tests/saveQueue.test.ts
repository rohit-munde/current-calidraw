import { test } from "node:test";
import assert from "node:assert/strict";
import { createLatest, createSaveQueue, KEEPALIVE_MAX_BYTES, type SaveStatus } from "../src/saveQueue.ts";

// ---- helpers -------------------------------------------------------------

type Call = { noteId: number; scene: string; keepalive: boolean; resolve: () => void; reject: (e: unknown) => void };

/** A fake backend: every save waits until the test resolves or rejects it. */
function manualServer() {
  const calls: Call[] = [];
  const stored = new Map<number, string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const save = (noteId: number, scene: string, keepalive: boolean) =>
    new Promise<void>((resolve, reject) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push({
        noteId, scene, keepalive,
        resolve: () => { inFlight--; stored.set(noteId, scene); resolve(); },
        reject: (e) => { inFlight--; reject(e); },
      });
    });
  return { calls, stored, save, maxInFlight: () => maxInFlight };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the server has received `n` calls. */
async function untilCalls(server: { calls: Call[] }, n: number) {
  for (let i = 0; i < 200 && server.calls.length < n; i++) await tick();
  assert.equal(server.calls.length, n, `expected ${n} save calls`);
}

function makeQueue(save: (id: number, s: string, k: boolean) => Promise<void>, extra = {}) {
  const statuses: SaveStatus[] = [];
  const queue = createSaveQueue({
    save,
    delayMs: 5,
    retryDelaysMs: [10_000], // long by default so tests control retries
    onStatus: (s) => statuses.push(s),
    ...extra,
  });
  return { queue, statuses };
}

// ---- 1. failed save followed by a successful retry ------------------------

test("a failed save keeps the scene and a retry saves it", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save);

  queue.schedule(1, 10, "v1");
  const first = queue.flush();
  await untilCalls(server, 1);
  server.calls[0].reject(new Error("offline"));
  assert.equal(await first, false, "flush reports failure");
  assert.equal(queue.status(), "error");
  assert.equal(queue.peek(1), "v1", "scene is retained");
  assert.equal(queue.hasUnsaved(), true);

  const second = queue.flush();
  await untilCalls(server, 2);
  assert.equal(server.calls[1].scene, "v1");
  server.calls[1].resolve();
  assert.equal(await second, true);
  assert.equal(server.stored.get(1), "v1");
  assert.equal(queue.status(), "saved");
  assert.equal(queue.hasUnsaved(), false);
});

test("after a failure it retries automatically, and on retryNow()", async () => {
  let fail = true;
  const saved: string[] = [];
  const { queue } = makeQueue(
    async (_id, scene) => {
      if (fail) throw new Error("offline");
      saved.push(scene);
    },
    { retryDelaysMs: [20] },
  );

  queue.schedule(1, 10, "v1");
  assert.equal(await queue.flush(), false);
  fail = false;
  await sleep(60); // backoff timer fires
  assert.deepEqual(saved, ["v1"]);
  assert.equal(queue.status(), "saved");

  // retryNow (the browser's "online" event) skips the remaining backoff.
  fail = true;
  const { queue: q2 } = makeQueue(async (_id, scene) => {
    if (fail) throw new Error("offline");
    saved.push(scene);
  });
  q2.schedule(2, 10, "w1");
  assert.equal(await q2.flush(), false);
  fail = false;
  q2.retryNow();
  await sleep(10);
  assert.deepEqual(saved, ["v1", "w1"]);
});

test("an edit made after a failure replaces the failed scene instead of being overwritten by it", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save);

  queue.schedule(1, 10, "v1");
  const f = queue.flush();
  await untilCalls(server, 1);
  queue.schedule(1, 10, "v2"); // user keeps drawing while v1 is in flight
  server.calls[0].reject(new Error("500"));
  assert.equal(await f, false);
  assert.equal(queue.peek(1), "v2", "the newer scene wins, the failed v1 isn't re-queued");

  const g = queue.flush();
  await untilCalls(server, 2);
  server.calls[1].resolve();
  assert.equal(await g, true);
  assert.equal(server.stored.get(1), "v2");
});

// ---- 2. slow saves while more edits arrive --------------------------------

test("slow saves: one request at a time, edits coalesce, newest scene ends up stored", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save);

  queue.schedule(1, 10, "v1");
  const f = queue.flush();
  await untilCalls(server, 1);

  // More edits arrive while v1 is still in flight.
  queue.schedule(1, 10, "v2");
  queue.schedule(1, 10, "v3");
  await sleep(20); // past the debounce: still must not start a second request
  assert.equal(server.calls.length, 1, "no overlapping request");

  server.calls[0].resolve();
  await untilCalls(server, 2);
  assert.equal(server.calls[1].scene, "v3", "v2 was coalesced away");
  server.calls[1].resolve();

  assert.equal(await f, true);
  assert.equal(server.maxInFlight(), 1);
  assert.equal(server.stored.get(1), "v3");
});

test("an older save cannot finish after a newer one (no rollback)", async () => {
  // A server whose first request is slow and the second fast. If both were sent
  // concurrently the older scene would be stored last.
  const stored = new Map<number, string>();
  let n = 0;
  const save = async (id: number, scene: string) => {
    const delay = n++ === 0 ? 30 : 1;
    await sleep(delay);
    stored.set(id, scene);
  };
  const { queue } = makeQueue(save);

  queue.schedule(1, 10, "old");
  const f = queue.flush();
  await tick();
  queue.schedule(1, 10, "new");
  assert.equal(await queue.flush(), true);
  await f;
  assert.equal(stored.get(1), "new");
});

// ---- 3. switching notes with pending / in-flight saves --------------------

test("switching notes: flush waits for the in-flight save and the pending ones", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save);

  queue.schedule(1, 10, "a1");
  void queue.flush();
  await untilCalls(server, 1); // note 1 in flight
  queue.schedule(1, 10, "a2"); // note 1 edited again
  queue.schedule(2, 10, "b1"); // and another note has pending changes

  let switched = false;
  const sw = queue.flush().then((ok) => { switched = ok; });
  await tick();
  assert.equal(switched, false, "doesn't switch while a save is in flight");

  server.calls[0].resolve();
  await untilCalls(server, 2);
  server.calls[1].resolve();
  await untilCalls(server, 3);
  server.calls[2].resolve();
  await sw;

  assert.equal(switched, true);
  assert.deepEqual(Object.fromEntries(server.stored), { 1: "a2", 2: "b1" });
});

test("switching notes when the save fails: flush says so and nothing is dropped", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save);

  queue.schedule(1, 10, "a1");
  const sw = queue.flush();
  await untilCalls(server, 1);
  server.calls[0].reject(new Error("offline"));

  assert.equal(await sw, false, "the app asks before switching");
  assert.equal(queue.peek(1), "a1", "reopening note 1 shows the unsaved copy");
  assert.equal(queue.hasUnsaved(), true);
});

test("deleting a note drops its queued scene; undo restores it if the delete fails", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save);

  queue.schedule(1, 10, "a1");
  queue.schedule(2, 20, "b1");
  const undo = queue.discard((_id, topicId) => topicId === 10);
  assert.equal(queue.peek(1), undefined);
  assert.equal(queue.peek(2), "b1");

  undo();
  assert.equal(queue.peek(1), "a1");
});

test("a save failing because the note was deleted from the UI is not reported as an error", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save, { isPermanent: () => true });

  queue.schedule(1, 10, "a1");
  const f = queue.flush();
  await untilCalls(server, 1);
  queue.discard((id) => id === 1); // user deletes the note while its save is in flight
  server.calls[0].reject(new Error("404"));
  assert.equal(await f, true);
  assert.notEqual(queue.status(), "error");
  assert.equal(queue.hasUnsaved(), false);
});

// ---- 4. out-of-order topic and note fetches -------------------------------

test("out-of-order responses: only the latest request updates the screen", async () => {
  const latest = createLatest();
  let shownNotes: string[] = [];

  // Simulates showTopic(): slow response for topic A, fast for topic B.
  const fetchNotes = (names: string[], ms: number) =>
    new Promise<string[]>((r) => setTimeout(() => r(names), ms));
  const showTopic = async (names: string[], ms: number) => {
    const token = latest.begin();
    const ns = await fetchNotes(names, ms);
    if (latest.isCurrent(token)) shownNotes = ns;
  };

  const a = showTopic(["A-note"], 30); // clicked first, answers last
  const b = showTopic(["B-note"], 5);
  await Promise.all([a, b]);
  assert.deepEqual(shownNotes, ["B-note"]);

  // Same guard for opening a note: open 1, then 2; 1's late response is ignored.
  const open = createLatest();
  let openNote: number | null = null;
  const openIt = async (id: number, ms: number) => {
    const t = open.begin();
    await sleep(ms);
    if (open.isCurrent(t)) openNote = id;
  };
  await Promise.all([openIt(1, 30), openIt(2, 5)]);
  assert.equal(openNote, 2);
});

// ---- 5. status accuracy ---------------------------------------------------

test("status goes idle → pending → saving → saved, and error → saving → saved on retry", async () => {
  const server = manualServer();
  const { queue, statuses } = makeQueue(server.save);
  assert.equal(queue.status(), "idle");

  queue.schedule(1, 10, "v1");
  assert.equal(queue.status(), "pending");
  await untilCalls(server, 1); // debounce fired on its own
  assert.equal(queue.status(), "saving");
  server.calls[0].resolve();
  await tick();
  assert.equal(queue.status(), "saved");

  queue.schedule(1, 10, "v2");
  const f = queue.flush();
  await untilCalls(server, 2);
  server.calls[1].reject(new Error("500"));
  await f;
  assert.equal(queue.status(), "error", "stays in error, not 'saved'");

  queue.schedule(1, 10, "v3"); // more edits while failing: still error until it saves
  assert.equal(queue.status(), "error");

  const g = queue.flush();
  await untilCalls(server, 3);
  assert.equal(queue.status(), "saving");
  server.calls[2].resolve();
  await g;
  assert.equal(queue.status(), "saved");

  assert.deepEqual(statuses, ["pending", "saving", "saved", "pending", "saving", "error", "saving", "saved"]);
});

// ---- page unload ----------------------------------------------------------

test("unload: small queued scenes go out as keepalive; in-flight or large scenes need a warning", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save);

  queue.schedule(1, 10, "small");
  assert.equal(queue.canSendOnUnload(), true);
  queue.sendOnUnload();
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].keepalive, true);
  assert.equal(queue.hasUnsaved(), false);
  server.calls[0].resolve();

  // Too big for keepalive (e.g. an embedded image).
  queue.schedule(1, 10, "x".repeat(KEEPALIVE_MAX_BYTES + 1));
  assert.equal(queue.canSendOnUnload(), false);
  queue.sendOnUnload();
  assert.equal(server.calls.length, 1, "nothing sent; the app shows 'Leave site?' instead");
  assert.equal(queue.hasUnsaved(), true);

  // A request in flight: a keepalive copy could overtake it, so don't send.
  queue.discard(() => true)();
  const f = queue.flush();
  await untilCalls(server, 2);
  queue.schedule(1, 10, "after");
  assert.equal(queue.canSendOnUnload(), false);
  server.calls[1].resolve();
  await untilCalls(server, 3);
  server.calls[2].resolve();
  await f;
});

// ---- idle-flush lifecycle (regression: an empty flush used to stop all later saves) ----

/** Fails the test instead of hanging if `p` doesn't settle in time. */
function within<T>(p: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`did not settle within ${ms}ms`)), ms)),
  ]);
}

test("an empty flush doesn't stop later autosaves", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save);

  assert.equal(await within(queue.flush()), true);
  queue.schedule(1, 10, "v1");
  await sleep(20); // past the 5ms debounce, no flush call
  assert.equal(server.calls.length, 1, "the debounced save was sent");
  server.calls[0].resolve();
  await tick();
  assert.equal(queue.status(), "saved");
  assert.equal(server.stored.get(1), "v1");
});

test("repeated idle flushes, then edits still save via debounce and via flush", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save);

  for (let i = 0; i < 3; i++) assert.equal(await within(queue.flush()), true);

  queue.schedule(1, 10, "v1");
  await untilCalls(server, 1);
  server.calls[0].resolve();
  await tick();

  assert.equal(await within(queue.flush()), true, "idle again after a save");
  queue.schedule(1, 10, "v2");
  const f = within(queue.flush());
  await untilCalls(server, 2);
  server.calls[1].resolve();
  assert.equal(await f, true, "flush with pending work settles (no spinning)");
  assert.equal(server.stored.get(1), "v2");
});

test("app lifecycle: open first note (empty flush), edit, open second note, edit", async () => {
  const server = manualServer();
  const { queue } = makeQueue(server.save);

  await within(queue.flush()); // openNote(1) on a fresh page
  queue.schedule(1, 10, "a1"); // user draws
  await untilCalls(server, 1); // autosave fires on its own
  server.calls[0].resolve();
  await tick();
  assert.equal(queue.status(), "saved");

  queue.schedule(1, 10, "a2"); // draws more, then immediately opens note 2
  const sw = within(queue.flush());
  await untilCalls(server, 2);
  server.calls[1].resolve();
  assert.equal(await sw, true);

  queue.schedule(2, 10, "b1"); // draws in note 2
  await untilCalls(server, 3);
  server.calls[2].resolve();
  await tick();
  assert.deepEqual(Object.fromEntries(server.stored), { 1: "a2", 2: "b1" });
  assert.equal(queue.status(), "saved");
});

test("a save function that throws synchronously leaves the queue usable", async () => {
  let throwSync = true;
  const saved: string[] = [];
  const save = (_id: number, scene: string) => {
    if (throwSync) throw new Error("sync failure");
    saved.push(scene);
    return Promise.resolve();
  };
  const { queue } = makeQueue(save);

  queue.schedule(1, 10, "v1");
  assert.equal(await within(queue.flush()), false);
  throwSync = false;
  assert.equal(await within(queue.flush()), true);
  queue.schedule(1, 10, "v2");
  await sleep(20);
  assert.deepEqual(saved, ["v1", "v2"]);
});
