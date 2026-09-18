import { validateDependencyChange } from "../domain/dependencies";
import { validateDateRange } from "../domain/dateOnly";
import {
  DomainError,
  type BoardSnapshot,
  type CreateMotherTaskInput,
  type CreateSubTaskInput,
  type MotherTask,
  type ReorderMotherTasksInput,
  type ReorderSubTasksInput,
  type RenameMotherTaskInput,
  type SetDependenciesInput,
  type SetMotherExpandedInput,
  type SubTask,
  type UpdateSubTaskInput,
  type ViewSettings,
  clampTaskColumnWidth,
} from "../domain/models";
import type { StorageGateway } from "./gateway";
import { exportBoardJson, prepareJsonImport } from "../transfer/jsonTransfer";
import type {
  ExportResponse,
  ImportMode,
  ImportPreview,
  ImportSource,
  TransferResult,
} from "../transfer/types";

function requiredName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new DomainError("validation_error", "任务名称不能为空。");
  }
  return name;
}

export class MemoryStorageGateway implements StorageGateway {
  private board: BoardSnapshot;
  private nextId = 1;

  constructor(initialBoard: BoardSnapshot) {
    this.board = structuredClone(initialBoard);
  }

  async loadBoard(): Promise<BoardSnapshot> {
    return structuredClone(this.board);
  }

  async createMotherTask(input: CreateMotherTaskInput): Promise<MotherTask> {
    const task: MotherTask = {
      id: `memory_task_${this.nextId++}`,
      name: requiredName(input.name),
      expanded: true,
      sortOrder: this.board.tasks.length,
      dependsOn: [],
      subTasks: [],
    };
    this.board.tasks.push(task);
    return structuredClone(task);
  }

  async renameMotherTask(input: RenameMotherTaskInput): Promise<void> {
    const task = this.requireMother(input.id);
    task.name = requiredName(input.name);
  }

  async setMotherExpanded(input: SetMotherExpandedInput): Promise<void> {
    this.requireMother(input.id).expanded = input.expanded;
  }

  async reorderMotherTasks(input: ReorderMotherTasksInput): Promise<void> {
    const uniqueIds = new Set(input.orderedIds);
    if (
      input.orderedIds.length !== this.board.tasks.length ||
      uniqueIds.size !== this.board.tasks.length ||
      input.orderedIds.some((id) => !this.board.tasks.some((task) => task.id === id))
    ) {
      throw new DomainError(
        "validation_error",
        "母任务排序必须完整包含每个母任务且不能重复。",
      );
    }

    const tasksById = new Map(this.board.tasks.map((task) => [task.id, task]));
    this.board.tasks = input.orderedIds.map((id, sortOrder) => ({
      ...tasksById.get(id)!,
      sortOrder,
    }));
  }

  async reorderSubTasks(input: ReorderSubTasksInput): Promise<void> {
    const mother = this.requireMother(input.motherId);
    const uniqueIds = new Set(input.orderedIds);
    if (
      input.orderedIds.length !== mother.subTasks.length ||
      uniqueIds.size !== mother.subTasks.length ||
      input.orderedIds.some((id) => !mother.subTasks.some((subTask) => subTask.id === id))
    ) {
      throw new DomainError(
        "validation_error",
        "子任务排序必须完整包含每个子任务且不能重复。",
      );
    }

    const subTasksById = new Map(mother.subTasks.map((subTask) => [subTask.id, subTask]));
    mother.subTasks = input.orderedIds.map((id, sortOrder) => ({
      ...subTasksById.get(id)!,
      sortOrder,
    }));
  }

  async deleteMotherTask(id: string): Promise<void> {
    this.requireMother(id);
    this.board.tasks = this.board.tasks.filter((task) => task.id !== id);
    for (const task of this.board.tasks) {
      task.dependsOn = task.dependsOn.filter((dependencyId) => dependencyId !== id);
    }
  }

  async createSubTask(input: CreateSubTaskInput): Promise<SubTask> {
    validateDateRange(input.startDate, input.endDate);
    const mother = this.requireMother(input.motherTaskId);
    const subTask: SubTask = {
      id: `memory_subtask_${this.nextId++}`,
      motherTaskId: mother.id,
      name: requiredName(input.name),
      startDate: input.startDate,
      endDate: input.endDate,
      sortOrder: mother.subTasks.length,
    };
    mother.subTasks.push(subTask);
    return structuredClone(subTask);
  }

  async updateSubTask(input: UpdateSubTaskInput): Promise<void> {
    validateDateRange(input.startDate, input.endDate);
    const subTask = this.requireSubTask(input.id);
    subTask.name = requiredName(input.name);
    subTask.startDate = input.startDate;
    subTask.endDate = input.endDate;
  }

  async deleteSubTask(id: string): Promise<void> {
    const subTask = this.requireSubTask(id);
    const mother = this.requireMother(subTask.motherTaskId);
    mother.subTasks = mother.subTasks.filter((task) => task.id !== id);
  }

  async setDependencies(input: SetDependenciesInput): Promise<string[]> {
    validateDependencyChange(this.board.tasks, input.taskId, input.dependsOn);
    this.requireMother(input.taskId).dependsOn = [...input.dependsOn];
    return [...input.dependsOn];
  }

  async saveViewSettings(settings: ViewSettings): Promise<void> {
    this.board.viewSettings = structuredClone({
      ...settings,
      taskColumnWidth: clampTaskColumnWidth(settings.taskColumnWidth),
    });
  }

  async analyzeImport(
    source: ImportSource,
    mode: ImportMode,
  ): Promise<ImportPreview> {
    const content = this.requireContentSource(source);
    let previewId = this.nextId;
    return prepareJsonImport(
      content,
      mode,
      this.board,
      (prefix) => `memory_${prefix}_${previewId++}`,
    ).preview;
  }

  async applyImport(
    source: ImportSource,
    mode: ImportMode,
  ): Promise<TransferResult> {
    const content = this.requireContentSource(source);
    let nextId = this.nextId;
    const prepared = prepareJsonImport(
      content,
      mode,
      this.board,
      (prefix) => `memory_${prefix}_${nextId++}`,
    );
    if (!prepared.preview.valid || !prepared.board) {
      throw new DomainError(
        "validation_error",
        prepared.preview.errors[0]?.message ?? "导入文件校验失败。",
      );
    }
    this.board = prepared.board;
    this.nextId = nextId;
    return {
      motherTaskCount: prepared.preview.motherTaskCount,
      subTaskCount: prepared.preview.subTaskCount,
      dependencyCount: prepared.preview.dependencyCount,
    };
  }

  async exportJson(destinationPath?: string): Promise<ExportResponse> {
    if (destinationPath) {
      throw new DomainError(
        "unsupported_path",
        "浏览器预览模式不能写入系统文件路径。",
      );
    }
    const exported = exportBoardJson(this.board);
    return { content: exported.content, result: exported.result };
  }

  private requireMother(id: string): MotherTask {
    const mother = this.board.tasks.find((task) => task.id === id);
    if (!mother) {
      throw new DomainError("not_found", "母任务不存在。");
    }
    return mother;
  }

  private requireSubTask(id: string): SubTask {
    for (const mother of this.board.tasks) {
      const subTask = mother.subTasks.find((task) => task.id === id);
      if (subTask) {
        return subTask;
      }
    }
    throw new DomainError("not_found", "子任务不存在。");
  }

  private requireContentSource(source: ImportSource): string {
    if (source.kind !== "content") {
      throw new DomainError(
        "unsupported_path",
        "浏览器预览模式不能读取系统文件路径。",
      );
    }
    return source.value;
  }
}
