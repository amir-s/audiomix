const APP_STATE_STORAGE_KEY = "unshuffle-music-state-v1";
const DATABASE_NAME = "unshuffle-music";
const DATABASE_VERSION = 1;
const TIMELINE_FILE_STORE = "timeline-files";

export type PersistedTimelineMetadata = {
  id: string;
  fileName: string;
  fileType: string;
  fileLastModified: number;
  trimInput: string;
  dslInput: string;
};

export type PersistedAppState = {
  bpmInput: string;
  timelineViewMode: string;
  timelines: PersistedTimelineMetadata[];
};

type StoredTimelineFileRecord = {
  id: string;
  blob: Blob;
};

function isPersistedTimelineMetadata(
  value: unknown,
): value is PersistedTimelineMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.id === "string" &&
    typeof candidate.fileName === "string" &&
    typeof candidate.fileType === "string" &&
    typeof candidate.fileLastModified === "number" &&
    typeof candidate.trimInput === "string" &&
    (typeof candidate.dslInput === "string" ||
      typeof candidate.dslInput === "undefined")
  );
}

function openTimelineDatabase(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    throw new Error("This browser cannot persist dropped files for refreshes.");
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(TIMELINE_FILE_STORE)) {
        database.createObjectStore(TIMELINE_FILE_STORE, { keyPath: "id" });
      }
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Unable to open browser storage."));
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

export function loadPersistedAppState() {
  if (typeof window === "undefined") {
    return null;
  }

  const rawState = window.localStorage.getItem(APP_STATE_STORAGE_KEY);

  if (!rawState) {
    return null;
  }

  try {
    const parsedState = JSON.parse(rawState) as Partial<PersistedAppState>;

    return {
      bpmInput:
        typeof parsedState.bpmInput === "string" ? parsedState.bpmInput : "",
      timelineViewMode:
        typeof parsedState.timelineViewMode === "string"
          ? parsedState.timelineViewMode
          : "compact-timeline",
      timelines: Array.isArray(parsedState.timelines)
        ? parsedState.timelines
            .filter(isPersistedTimelineMetadata)
            .map((timeline) => ({
              ...timeline,
              dslInput: timeline.dslInput ?? "",
            }))
        : [],
    } satisfies PersistedAppState;
  } catch {
    return null;
  }
}

export function savePersistedAppState(state: PersistedAppState) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
}

export async function saveTimelineFile(id: string, blob: Blob) {
  const database = await openTimelineDatabase();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        TIMELINE_FILE_STORE,
        "readwrite",
      );

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onerror = () => {
        reject(
          transaction.error ??
            new Error("Unable to save the file in browser storage."),
        );
      };

      transaction.objectStore(TIMELINE_FILE_STORE).put({
        id,
        blob,
      } satisfies StoredTimelineFileRecord);
    });
  } finally {
    database.close();
  }
}

export async function loadTimelineFile(id: string) {
  const database = await openTimelineDatabase();

  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const transaction = database.transaction(TIMELINE_FILE_STORE, "readonly");
      const request = transaction.objectStore(TIMELINE_FILE_STORE).get(id);

      request.onerror = () => {
        reject(
          request.error ?? new Error("Unable to read the stored file."),
        );
      };

      request.onsuccess = () => {
        const record = request.result as StoredTimelineFileRecord | undefined;
        resolve(record?.blob ?? null);
      };
    });
  } finally {
    database.close();
  }
}

export async function deleteTimelineFile(id: string) {
  const database = await openTimelineDatabase();

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        TIMELINE_FILE_STORE,
        "readwrite",
      );

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onerror = () => {
        reject(
          transaction.error ??
            new Error("Unable to remove the stored file from browser storage."),
        );
      };

      transaction.objectStore(TIMELINE_FILE_STORE).delete(id);
    });
  } finally {
    database.close();
  }
}
