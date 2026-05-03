// IndexedDB persistence for chat sessions

export type ChatMode = "chat" | "agent" | "workflow";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, string>;
  status: "pending" | "approved" | "denied" | "running" | "done" | "error";
  result?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;   // Links a "tool" role message back to the ToolCall that produced it
  toolName?: string;     // Name of the tool for result attribution
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  mode: ChatMode;
  createdAt: number;
  updatedAt: number;
  compactedSummary?: string;
  projectPath?: string;
  contextState?: {
    mode: "auto" | "manual";
    selectedPaths: string[];
    workingContext: string;
    lastTaskContext: string;
    lastMatchedContextNames: string[];
  };
}

const DB_NAME = "athva_chat";
const DB_VERSION = 1;
const STORE_NAME = "sessions";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllSessions(): Promise<ChatSession[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const sessions = req.result as ChatSession[];
      // Strip legacy workflow state — breaking change, old sessions lose workflow data
      sessions.forEach((s: any) => { delete s.workflowState; });
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(sessions);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getSessionsByProject(projectPath: string): Promise<ChatSession[]> {
  const all = await getAllSessions();
  return all.filter((s) => s.projectPath === projectPath);
}

export async function getSession(id: string): Promise<ChatSession | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result as ChatSession | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(session: ChatSession): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(session);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function createSession(mode: ChatMode = "chat", projectPath?: string): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: "New Chat",
    messages: [],
    mode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    projectPath,
    contextState: {
      mode: "auto",
      selectedPaths: [],
      workingContext: "",
      lastTaskContext: "",
      lastMatchedContextNames: [],
    },
  };
}
