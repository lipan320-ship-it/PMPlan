import { compareDateOnly } from "./dateOnly";
import type { DateOnly, MotherTask } from "./models";

export interface DateSpan {
  startDate: DateOnly;
  endDate: DateOnly;
}

export interface DependencyConflict {
  taskId: string;
  dependsOnTaskId: string;
  taskStartDate: DateOnly;
  predecessorEndDate: DateOnly;
}

export function getMotherSpan(task: MotherTask): DateSpan | null {
  if (task.subTasks.length === 0) {
    return null;
  }

  let startDate = task.subTasks[0].startDate;
  let endDate = task.subTasks[0].endDate ?? task.subTasks[0].startDate;

  for (const subTask of task.subTasks.slice(1)) {
    const effectiveEnd = subTask.endDate ?? subTask.startDate;
    if (compareDateOnly(subTask.startDate, startDate) < 0) {
      startDate = subTask.startDate;
    }
    if (compareDateOnly(effectiveEnd, endDate) > 0) {
      endDate = effectiveEnd;
    }
  }

  return { startDate, endDate };
}

export function evaluateDependencyConflicts(
  tasks: MotherTask[],
): DependencyConflict[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const spans = new Map(
    tasks.map((task) => [task.id, getMotherSpan(task)] as const),
  );
  const conflicts: DependencyConflict[] = [];

  for (const task of tasks) {
    const taskSpan = spans.get(task.id);
    if (!taskSpan) {
      continue;
    }

    for (const dependsOnTaskId of task.dependsOn) {
      const predecessor = byId.get(dependsOnTaskId);
      const predecessorSpan = spans.get(dependsOnTaskId);
      if (!predecessor || !predecessorSpan) {
        continue;
      }

      if (compareDateOnly(taskSpan.startDate, predecessorSpan.endDate) <= 0) {
        conflicts.push({
          taskId: task.id,
          dependsOnTaskId,
          taskStartDate: taskSpan.startDate,
          predecessorEndDate: predecessorSpan.endDate,
        });
      }
    }
  }

  return conflicts;
}
