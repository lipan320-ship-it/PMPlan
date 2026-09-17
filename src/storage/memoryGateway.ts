import { validateDependencyChange } from "../domain/dependencies";
import { validateDateRange } from "../domain/dateOnly";
import {
  DomainError,
  type BoardSnapshot,
  type CreateMotherTaskInput,
  type CreateSubTaskInput,
  type MotherTask,
  type RenameMotherTaskInput,
  type SetDependenciesInput,
  type SetMotherExpandedInput,
  type SubTask,
  type UpdateSubTaskInput,
  type ViewSettings,
} from "../domain/models";
import type { StorageGateway } from "./gateway";

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
    this.board.viewSettings = structuredClone(settings);
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
}
