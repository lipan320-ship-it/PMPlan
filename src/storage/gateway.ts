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
import type { ProjectState } from "./projectTypes";

export interface StorageGateway {
  loadBoard(): Promise<BoardSnapshot>;
  getProjectState(): Promise<ProjectState>;
  openProject(path: string): Promise<ProjectState>;
  createProject(path: string): Promise<ProjectState>;
  saveActiveProject(): Promise<ProjectState>;
  saveAsProject(path: string): Promise<ProjectState>;
  removeRecentProject(path: string): Promise<void>;
  createMotherTask(input: CreateMotherTaskInput): Promise<MotherTask>;
  renameMotherTask(input: RenameMotherTaskInput): Promise<void>;
  setMotherExpanded(input: SetMotherExpandedInput): Promise<void>;
  reorderMotherTasks(input: ReorderMotherTasksInput): Promise<void>;
  reorderSubTasks(input: ReorderSubTasksInput): Promise<void>;
  deleteMotherTask(id: string): Promise<void>;
  createSubTask(input: CreateSubTaskInput): Promise<SubTask>;
  updateSubTask(input: UpdateSubTaskInput): Promise<void>;
  deleteSubTask(id: string): Promise<void>;
  setDependencies(input: SetDependenciesInput): Promise<string[]>;
  saveViewSettings(settings: ViewSettings): Promise<void>;
  analyzeImport(source: ImportSource, mode: ImportMode): Promise<ImportPreview>;
  applyImport(source: ImportSource, mode: ImportMode): Promise<TransferResult>;
  exportJson(destinationPath?: string): Promise<ExportResponse>;
}
