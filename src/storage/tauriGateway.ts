import { invoke } from "@tauri-apps/api/core";
import type {
  BoardSnapshot,
  CreateMotherTaskInput,
  CreateSubTaskInput,
  MotherTask,
  ReorderMotherTasksInput,
  ReorderSubTasksInput,
  RenameMotherTaskInput,
  SetDependenciesInput,
  SetMotherExpandedInput,
  SubTask,
  UpdateSubTaskInput,
  ViewSettings,
} from "../domain/models";
import type {
  ExportResponse,
  ImportMode,
  ImportPreview,
  ImportSource,
  TransferResult,
} from "../transfer/types";
import type { StorageGateway } from "./gateway";

export class TauriStorageGateway implements StorageGateway {
  loadBoard(): Promise<BoardSnapshot> {
    return invoke("load_board");
  }

  createMotherTask(input: CreateMotherTaskInput): Promise<MotherTask> {
    return invoke("create_mother_task", { input });
  }

  renameMotherTask(input: RenameMotherTaskInput): Promise<void> {
    return invoke("rename_mother_task", { input });
  }

  setMotherExpanded(input: SetMotherExpandedInput): Promise<void> {
    return invoke("set_mother_expanded", { input });
  }

  reorderMotherTasks(input: ReorderMotherTasksInput): Promise<void> {
    return invoke("reorder_mother_tasks", { input });
  }

  reorderSubTasks(input: ReorderSubTasksInput): Promise<void> {
    return invoke("reorder_sub_tasks", { input });
  }

  deleteMotherTask(id: string): Promise<void> {
    return invoke("delete_mother_task", { id });
  }

  createSubTask(input: CreateSubTaskInput): Promise<SubTask> {
    return invoke("create_sub_task", { input });
  }

  updateSubTask(input: UpdateSubTaskInput): Promise<void> {
    return invoke("update_sub_task", { input });
  }

  deleteSubTask(id: string): Promise<void> {
    return invoke("delete_sub_task", { id });
  }

  setDependencies(input: SetDependenciesInput): Promise<string[]> {
    return invoke("set_dependencies", { input });
  }

  saveViewSettings(settings: ViewSettings): Promise<void> {
    return invoke("save_view_settings", { settings });
  }

  analyzeImport(source: ImportSource, mode: ImportMode): Promise<ImportPreview> {
    return source.kind === "path"
      ? invoke("analyze_import_file", { path: source.value, mode })
      : invoke("analyze_import_content", { content: source.value, mode });
  }

  applyImport(source: ImportSource, mode: ImportMode): Promise<TransferResult> {
    return source.kind === "path"
      ? invoke("apply_import_file", { path: source.value, mode })
      : invoke("apply_import_content", { content: source.value, mode });
  }

  async exportJson(destinationPath?: string): Promise<ExportResponse> {
    if (destinationPath) {
      const result = await invoke<TransferResult>("export_json_file", {
        path: destinationPath,
      });
      return { content: null, result };
    }
    const content = await invoke<string>("export_json_content");
    const parsed = JSON.parse(content) as {
      tasks: Array<{ dependsOn?: string[]; subTasks?: unknown[] }>;
    };
    return {
      content,
      result: {
        motherTaskCount: parsed.tasks.length,
        subTaskCount: parsed.tasks.reduce(
          (total, task) => total + (task.subTasks?.length ?? 0),
          0,
        ),
        dependencyCount: parsed.tasks.reduce(
          (total, task) => total + (task.dependsOn?.length ?? 0),
          0,
        ),
      },
    };
  }
}
