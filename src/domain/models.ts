export type DateOnly = string;
export type ViewMode = "week" | "biweek" | "month";

export const DEFAULT_TASK_COLUMN_WIDTH = 348;
export const MIN_TASK_COLUMN_WIDTH = 240;
export const MAX_TASK_COLUMN_WIDTH = 600;

export function clampTaskColumnWidth(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TASK_COLUMN_WIDTH;
  }
  return Math.round(Math.min(MAX_TASK_COLUMN_WIDTH, Math.max(MIN_TASK_COLUMN_WIDTH, value)));
}

export interface SubTask {
  id: string;
  motherTaskId: string;
  name: string;
  startDate: DateOnly;
  endDate: DateOnly | null;
  sortOrder: number;
}

export interface MotherTask {
  id: string;
  name: string;
  expanded: boolean;
  sortOrder: number;
  dependsOn: string[];
  subTasks: SubTask[];
}

export interface ViewSettings {
  viewMode: ViewMode;
  anchorDate: DateOnly;
  showDependencies: boolean;
  taskColumnWidth: number;
}

export interface BoardSnapshot {
  tasks: MotherTask[];
  viewSettings: ViewSettings;
}

export interface CreateMotherTaskInput {
  name: string;
}

export interface RenameMotherTaskInput {
  id: string;
  name: string;
}

export interface SetMotherExpandedInput {
  id: string;
  expanded: boolean;
}

export interface ReorderMotherTasksInput {
  orderedIds: string[];
}

export interface ReorderSubTasksInput {
  motherId: string;
  orderedIds: string[];
}

export interface CreateSubTaskInput {
  motherTaskId: string;
  name: string;
  startDate: DateOnly;
  endDate: DateOnly | null;
}

export interface UpdateSubTaskInput {
  id: string;
  name: string;
  startDate: DateOnly;
  endDate: DateOnly | null;
}

export interface SetDependenciesInput {
  taskId: string;
  dependsOn: string[];
}

export interface DomainErrorShape {
  code: string;
  message: string;
}

export class DomainError extends Error implements DomainErrorShape {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
