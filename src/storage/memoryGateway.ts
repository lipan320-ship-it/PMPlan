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
  MOTHER_TAG_MAX_LENGTH,
  normalizeMotherTag,
} from "../domain/models";
import type { StorageGateway } from "./gateway";
import type { ProjectState, RecentProject } from "./projectTypes";
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

function optionalTag(value: string | null | undefined): string | null {
  const tag = normalizeMotherTag(value);
  if (tag && tag.length > MOTHER_TAG_MAX_LENGTH) {
    throw new DomainError("validation_error", `标签不能超过 ${MOTHER_TAG_MAX_LENGTH} 个字符。`);
  }
  return tag;
}

export class MemoryStorageGateway implements StorageGateway {
  private board: BoardSnapshot;
  private nextId = 1;
  private readonly projects = new Map<string, BoardSnapshot>();
  private projectState: ProjectState = {
    activePath: null,
    activeName: null,
    parentPath: null,
    workspaceMode: "unnamedLegacy",
    saveStatus: "saved",
    lastError: null,
    recent: [],
  };

  constructor(initialBoard: BoardSnapshot) {
    this.board = structuredClone(initialBoard);
  }

  async loadBoard(): Promise<BoardSnapshot> {
    this.syncActiveProject();
    return structuredClone(this.board);
  }

  async getProjectState(): Promise<ProjectState> {
    this.syncActiveProject();
    return structuredClone(this.projectState);
  }

  async openProject(path: string): Promise<ProjectState> {
    const normalized = normalizeMemoryPath(path);
    const project = this.projects.get(normalized);
    if (!project) {
      throw new DomainError("not_found", "项目文件不存在或尚未创建");
    }
    this.board = structuredClone(project);
    this.activateProject(normalized);
    return this.getProjectState();
  }

  async createProject(path: string): Promise<ProjectState> {
    const normalized = normalizeMemoryPath(path);
    if (this.projects.has(normalized)) {
      throw new DomainError("conflict", "项目文件已经存在");
    }
    this.projects.set(normalized, structuredClone({ ...this.board, tasks: [] }));
    this.board = structuredClone(this.projects.get(normalized)!);
    this.activateProject(normalized);
    return this.getProjectState();
  }

  async saveActiveProject(): Promise<ProjectState> {
    if (!this.projectState.activePath) {
      throw new DomainError("validation_error", "请先选择项目文件");
    }
    this.syncActiveProject();
    this.projectState = { ...this.projectState, saveStatus: "saved", lastError: null };
    return this.getProjectState();
  }

  async saveAsProject(path: string): Promise<ProjectState> {
    const normalized = normalizeMemoryPath(path);
    this.projects.set(normalized, structuredClone(this.board));
    this.activateProject(normalized);
    return this.getProjectState();
  }

  async removeRecentProject(path: string): Promise<void> {
    const normalized = normalizeMemoryPath(path);
    this.projectState = {
      ...this.projectState,
      recent: this.projectState.recent.filter((item) => item.path !== normalized),
    };
  }

  async createMotherTask(input: CreateMotherTaskInput): Promise<MotherTask> {
    const task: MotherTask = {
      id: `memory_task_${this.nextId++}`,
      name: requiredName(input.name),
      tag: optionalTag(input.tag),
      expanded: true,
      sortOrder: this.board.tasks.length,
      dependsOn: [],
      subTasks: [],
    };
    this.board.tasks.push(task);
    this.syncActiveProject();
    return structuredClone(task);
  }

  async renameMotherTask(input: RenameMotherTaskInput): Promise<void> {
    const task = this.requireMother(input.id);
    task.name = requiredName(input.name);
    if (input.tag !== undefined) {
      task.tag = optionalTag(input.tag);
    }
    this.syncActiveProject();
  }

  async setMotherExpanded(input: SetMotherExpandedInput): Promise<void> {
    this.requireMother(input.id).expanded = input.expanded;
    this.syncActiveProject();
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
    this.syncActiveProject();
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
    this.syncActiveProject();
  }

  async deleteMotherTask(id: string): Promise<void> {
    this.requireMother(id);
    this.board.tasks = this.board.tasks.filter((task) => task.id !== id);
    for (const task of this.board.tasks) {
      task.dependsOn = task.dependsOn.filter((dependencyId) => dependencyId !== id);
    }
    this.syncActiveProject();
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
    this.syncActiveProject();
    return structuredClone(subTask);
  }

  async updateSubTask(input: UpdateSubTaskInput): Promise<void> {
    validateDateRange(input.startDate, input.endDate);
    const subTask = this.requireSubTask(input.id);
    subTask.name = requiredName(input.name);
    subTask.startDate = input.startDate;
    subTask.endDate = input.endDate;
    this.syncActiveProject();
  }

  async deleteSubTask(id: string): Promise<void> {
    const subTask = this.requireSubTask(id);
    const mother = this.requireMother(subTask.motherTaskId);
    mother.subTasks = mother.subTasks.filter((task) => task.id !== id);
    this.syncActiveProject();
  }

  async setDependencies(input: SetDependenciesInput): Promise<string[]> {
    validateDependencyChange(this.board.tasks, input.taskId, input.dependsOn);
    this.requireMother(input.taskId).dependsOn = [...input.dependsOn];
    this.syncActiveProject();
    return [...input.dependsOn];
  }

  async saveViewSettings(settings: ViewSettings): Promise<void> {
    this.board.viewSettings = structuredClone({
      ...settings,
      taskColumnWidth: clampTaskColumnWidth(settings.taskColumnWidth),
      motherSortMode: settings.motherSortMode ?? "manual",
    });
    this.syncActiveProject();
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
    this.syncActiveProject();
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

  private activateProject(path: string): void {
    const segments = path.split(/[\\/]/);
    const name = segments.at(-1) ?? path;
    const parentPath = segments.slice(0, -1).join("/");
    const recent: RecentProject[] = [
      {
        path,
        name,
        parentPath,
        status: "available" as const,
        lastError: null,
      },
      ...this.projectState.recent.filter((item) => item.path !== path),
    ].slice(0, 8);
    this.projectState = {
      ...this.projectState,
      activePath: path,
      activeName: name,
      parentPath,
      workspaceMode: "namedProject",
      saveStatus: "saved",
      lastError: null,
      recent,
    };
  }

  private syncActiveProject(): void {
    if (this.projectState.activePath) {
      this.projects.set(this.projectState.activePath, structuredClone(this.board));
    }
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

function normalizeMemoryPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
}
