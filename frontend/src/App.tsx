import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, getSceneVersion, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { api, ApiError, type Note, type NoteSummary, type Topic } from "./api";
import { createLatest, createSaveQueue, type SaveStatus } from "./saveQueue";
import "./App.css";

type OnChange = NonNullable<ExcalidrawProps["onChange"]>;

const STATUS_LABEL: Record<SaveStatus, string> = {
  idle: "Ready",
  pending: "Unsaved changes…",
  saving: "Saving…",
  saved: "Saved to Postgres ✓",
  error: "Save failed — retrying",
};

const COLLAPSED_KEY = "excali-notes:sidebar-collapsed";

const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};

export default function App() {
  const [topics, setTopics] = useState<Topic[] | null>(null); // null = still loading
  const [topicsFailed, setTopicsFailed] = useState(false);
  const [openTopicId, setOpenTopicId] = useState<number | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [newTopic, setNewTopic] = useState("");
  const [newNote, setNewNote] = useState("");
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleSidebar = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        // storage unavailable (private mode): just don't remember it
      }
      return !c;
    });
  };

  // One queue for the whole app: unsaved scenes survive switching notes.
  const [queue] = useState(() =>
    createSaveQueue({
      save: api.saveScene,
      isPermanent: (err) => err instanceof ApiError && err.status === 404,
      onStatus: setStatus,
    }),
  );
  // Only the newest topic-list / note-open request may update the screen.
  const [notesReq] = useState(createLatest);
  const [openReq] = useState(createLatest);

  // Scene "fingerprint" of the open note, so hover/selection changes don't trigger saves.
  const baseline = useRef<{ id: number; key: string } | null>(null);

  const loadTopics = useCallback(
    () =>
      api.topics().then(
        (ts) => {
          setTopics(ts);
          setTopicsFailed(false);
        },
        () => setTopicsFailed(true),
      ),
    [],
  );

  useEffect(() => {
    void loadTopics();
  }, [loadTopics]);

  useEffect(() => {
    // Small queued saves go out as keepalive requests when the page is hidden.
    // Anything else (a request still in flight, or a scene too big for keepalive,
    // e.g. with images) makes the browser ask "Leave site?" instead.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (queue.hasUnsaved() && !queue.canSendOnUnload()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const onHide = () => queue.sendOnUnload();
    const onOnline = () => queue.retryNow();
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("online", onOnline);
    };
  }, [queue]);

  //global error handler

  const showTopic = async (id: number | null) => {
    const token = notesReq.begin();
    setOpenTopicId(id);
    setNotes([]);
    if (id == null) return;
    try {
      const ns = await api.notes(id);
      if (notesReq.isCurrent(token)) setNotes(ns);
    } catch {
      if (notesReq.isCurrent(token)) setNotice("Couldn't load the notes for this topic.");
    }
  };

  const openNote = async (id: number) => {
    // Every click cancels slower opens still in progress, including a click back
    // on the note that's already open.
    const token = openReq.begin();
    if (note?.id === id) return;
    // Save the note we're leaving first. If that fails its changes stay queued
    // (and keep retrying), but the user decides whether to move on.
    if (!(await queue.flush())) {
      if (!openReq.isCurrent(token)) return;
      const go = confirm(
        "Your latest changes couldn't be saved yet. They're kept in this tab and will keep retrying.\n\nOpen the other note anyway?",
      );
      if (!go) return;
    }
    try {
      const n = await api.note(id);
      if (openReq.isCurrent(token)) setNote(n);
    } catch {
      if (openReq.isCurrent(token)) setNotice("Couldn't open that note.");
    }
  };

  // Prefer this tab's unsaved copy over what the server has.
  const initialData = useMemo(() => {
    if (!note) return undefined;
    const json = queue.peek(note.id) ?? note.scene;
    if (!json) return undefined;
    try {
      return JSON.parse(json);
    } catch {
      return undefined;
    }
  }, [note, queue]);

  const onChange: OnChange = (elements, appState, files) => {
    if (!note) return;
    const key = `${getSceneVersion(elements)}|${Object.keys(files).length}|${appState.viewBackgroundColor}`;
    if (baseline.current?.id !== note.id) {
      baseline.current = { id: note.id, key }; // first render of the scene we just loaded
      return;
    }
    if (key === baseline.current.key) return;
    baseline.current.key = key;
    queue.schedule(note.id, note.topicId, serializeAsJSON(elements, appState, files, "local"));
  };

  const addTopic = async () => {
    const name = newTopic.trim();
    if (!name) return;
    let t: Topic;
    try {
      t = await api.createTopic(name);
    } catch (err) {
      setNotice(
        err instanceof ApiError && err.status === 409
          ? `A topic named "${name}" already exists.`
          : "Couldn't create the topic. Is the backend running?",
      );
      return;
    }
    setTopics((ts) => [...(ts ?? []), t].sort((a, b) => a.name.localeCompare(b.name)));
    setNewTopic("");
    void showTopic(t.id);
  };

  const addNote = async () => {
    const title = newNote.trim();
    if (openTopicId == null || !title) return;
    let n: Note;
    try {
      n = await api.createNote(openTopicId, title);
    } catch {
      setNotice("Couldn't create the note. Is the backend running?");
      return;
    }
    setNotes((ns) => [n, ...ns]);
    setNewNote("");
    void openNote(n.id);
  };

  const removeTopic = async (t: Topic) => {
    if (!confirm(`Delete topic "${t.name}" and all its notes?`)) return;
    // Stop saving its notes first, so a save racing the delete isn't reported as a failure.
    const undo = queue.discard((_, topicId) => topicId === t.id);
    try {
      await api.deleteTopic(t.id);
    } catch {
      undo();
      setNotice(`Couldn't delete "${t.name}".`);
      return;
    }
    setTopics((ts) => (ts ?? []).filter((x) => x.id !== t.id));
    if (openTopicId === t.id) void showTopic(null);
    if (note?.topicId === t.id) {
      openReq.begin();
      setNote(null);
    }
  };

  const removeNote = async (n: NoteSummary) => {
    if (!confirm(`Delete note "${n.title}"?`)) return;
    const undo = queue.discard((noteId) => noteId === n.id);
    try {
      await api.deleteNote(n.id);
    } catch {
      undo();
      setNotice(`Couldn't delete "${n.title}".`);
      return;
    }
    setNotes((ns) => ns.filter((x) => x.id !== n.id));
    if (note?.id === n.id) {
      openReq.begin();
      setNote(null);
    }
  };

  return (
    <div className="app">
      {collapsed ? (
        <aside className="sidebar collapsed">
          <button className="toggle" onClick={toggleSidebar} title="Show sidebar" aria-label="Show sidebar">»</button>
          <span className={`dot ${status}`} title={STATUS_LABEL[status]} />
        </aside>
      ) : (
        <aside className="sidebar">
          <div className="sidebar-head">
            <h1>Current-Calidraw</h1>
            <button className="toggle" onClick={toggleSidebar} title="Hide sidebar" aria-label="Hide sidebar">«</button>
          </div>

          <form className="add" onSubmit={(e) => { e.preventDefault(); void addTopic(); }}>
            <input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} placeholder="New topic…" />
            <button>+</button>
          </form>

          {notice && (
            <div className="notice" role="alert">
              <span>{notice}</span>
              <button onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
            </div>
          )}

          <ul className="topics">
            {topicsFailed && (
              <li className="hint">
                Couldn't load topics. Is the backend running?{" "}
                <button className="link" onClick={() => void loadTopics()}>Retry</button>
              </li>
            )}
            {topics == null && !topicsFailed && <li className="hint">Loading…</li>}
            {topics?.map((t) => (
              <li key={t.id}>
                <div className={`row topic ${openTopicId === t.id ? "open" : ""}`}
                  onClick={() => void showTopic(openTopicId === t.id ? null : t.id)}>
                  <span>{openTopicId === t.id ? "▾" : "▸"} {t.name}</span>
                  <button className="del" onClick={(e) => { e.stopPropagation(); void removeTopic(t); }}>×</button>
                </div>

                {openTopicId === t.id && (
                  <ul className="notes">
                    {notes.map((n) => (
                      <li key={n.id} className={`row note ${note?.id === n.id ? "active" : ""}`}
                        onClick={() => void openNote(n.id)}>
                        <span>{n.title}</span>
                        <button className="del" onClick={(e) => { e.stopPropagation(); void removeNote(n); }}>×</button>
                      </li>
                    ))}
                    <form className="add" onSubmit={(e) => { e.preventDefault(); void addNote(); }}>
                      <input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="New note…" />
                      <button>+</button>
                    </form>
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <footer className={`status ${status}`}>
            {note || status !== "idle" ? STATUS_LABEL[status] : "No note open"}
            {status === "error" && (
              <button className="link" onClick={() => void queue.flush()}>Retry now</button>
            )}
          </footer>
        </aside>
      )}

      <main className="canvas">
        {note ? (
          <Excalidraw key={note.id} initialData={initialData} onChange={onChange} />
        ) : (
          <div className="empty">Pick a topic, then create or open a note.</div>
        )}
      </main>
    </div>
  );
}
