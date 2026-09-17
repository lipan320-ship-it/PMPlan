import { DomainError, type MotherTask } from "./models";

function graphWithReplacement(
  tasks: MotherTask[],
  taskId: string,
  dependsOn: string[],
): Map<string, string[]> {
  const graph = new Map(tasks.map((task) => [task.id, [...task.dependsOn]]));
  graph.set(taskId, [...dependsOn]);
  return graph;
}

function hasCycle(graph: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }

    visiting.add(id);
    for (const dependencyId of graph.get(id) ?? []) {
      if (visit(dependencyId)) {
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return [...graph.keys()].some(visit);
}

export function validateDependencyChange(
  tasks: MotherTask[],
  taskId: string,
  dependsOn: string[],
): void {
  const knownIds = new Set(tasks.map((task) => task.id));
  if (!knownIds.has(taskId)) {
    throw new DomainError("not_found", "当前母任务不存在。");
  }

  const uniqueIds = new Set(dependsOn);
  if (uniqueIds.size !== dependsOn.length) {
    throw new DomainError("duplicate_dependency", "前置母任务不能重复。");
  }
  if (uniqueIds.has(taskId)) {
    throw new DomainError("self_dependency", "母任务不能依赖自身。");
  }
  for (const dependencyId of dependsOn) {
    if (!knownIds.has(dependencyId)) {
      throw new DomainError("invalid_dependency", "存在无效的前置母任务引用。");
    }
  }

  if (hasCycle(graphWithReplacement(tasks, taskId, dependsOn))) {
    throw new DomainError("dependency_cycle", "该设置会形成循环依赖。");
  }
}
