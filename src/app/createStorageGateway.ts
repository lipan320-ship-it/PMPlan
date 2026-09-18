import { isTauri } from "@tauri-apps/api/core";
import { todayDateOnly } from "../domain/dateOnly";
import {
  DEFAULT_TASK_COLUMN_WIDTH,
  type BoardSnapshot,
} from "../domain/models";
import type { StorageGateway } from "../storage/gateway";
import { MemoryStorageGateway } from "../storage/memoryGateway";
import { TauriStorageGateway } from "../storage/tauriGateway";

export function createEmptyBoard(): BoardSnapshot {
  return {
    tasks: [],
    viewSettings: {
      viewMode: "biweek",
      anchorDate: todayDateOnly(),
      showDependencies: true,
      taskColumnWidth: DEFAULT_TASK_COLUMN_WIDTH,
    },
  };
}

export function createStorageGateway(): StorageGateway {
  return isTauri()
    ? new TauriStorageGateway()
    : new MemoryStorageGateway(createEmptyBoard());
}
