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

export interface StorageGateway {
  loadBoard(): Promise<BoardSnapshot>;
  createMotherTask(input: CreateMotherTaskInput): Promise<MotherTask>;
  renameMotherTask(input: RenameMotherTaskInput): Promise<void>;
  setMotherExpanded(input: SetMotherExpandedInput): Promise<void>;
  deleteMotherTask(id: string): Promise<void>;
  createSubTask(input: CreateSubTaskInput): Promise<SubTask>;
  updateSubTask(input: UpdateSubTaskInput): Promise<void>;
  deleteSubTask(id: string): Promise<void>;
  setDependencies(input: SetDependenciesInput): Promise<string[]>;
  saveViewSettings(settings: ViewSettings): Promise<void>;
}
