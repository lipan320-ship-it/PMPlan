import { invoke } from "@tauri-apps/api/core";
import type {
  BoardSnapshot,
  CreateMotherTaskInput,
  CreateSubTaskInput,
  MotherTask,
  RenameMotherTaskInput,
  SetDependenciesInput,
  SetMotherExpandedInput,
  SubTask,
  UpdateSubTaskInput,
  ViewSettings,
} from "../domain/models";
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
}
