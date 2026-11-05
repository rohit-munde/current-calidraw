export type Topic = { id: number; name: string };
export type NoteSummary = { id: number; title: string; updatedAt: string };
export type Note = NoteSummary & { topicId: number; scene: string | null };

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new ApiError(`${init?.method ?? "GET"} ${url} failed: ${res.status}`, res.status);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const body = (name: string) => JSON.stringify({ name });

export const api = {
  topics: () => request<Topic[]>("/api/topics"),
  createTopic: (name: string) => request<Topic>("/api/topics", { method: "POST", body: body(name) }),
  deleteTopic: (id: number) => request<void>(`/api/topics/${id}`, { method: "DELETE" }),

  notes: (topicId: number) => request<NoteSummary[]>(`/api/topics/${topicId}/notes`),
  createNote: (topicId: number, title: string) =>
    request<Note>(`/api/topics/${topicId}/notes`, { method: "POST", body: body(title) }),
  note: (id: number) => request<Note>(`/api/notes/${id}`),
  deleteNote: (id: number) => request<void>(`/api/notes/${id}`, { method: "DELETE" }),

  // keepalive asks the browser to finish the request after the page is gone.
  // Only used for small bodies; see saveQueue.ts.
  saveScene: (id: number, scene: string, keepalive = false) =>
    request<void>(`/api/notes/${id}/scene`, { method: "PUT", body: scene, keepalive }),
};
