import { assertDateOnly, validateDateRange } from "../domain/dateOnly";
import { validateDependencyChange } from "../domain/dependencies";
import type {
  BoardSnapshot,
  MotherTask,
  SubTask,
} from "../domain/models";
import type {
  ImportMode,
  ImportPreview,
  TransferResult,
  ValidationIssue,
} from "./types";

interface PreparedTransfer {
  preview: ImportPreview;
  board: BoardSnapshot | null;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

function stringValue(
  object: JsonObject,
  key: string,
  path: string,
  errors: ValidationIssue[],
): string {
  const value = object[key];
  if (typeof value !== "string" || !value.trim()) {
    errors.push(issue(`${path}.${key}`, "字段不能为空"));
    return "";
  }
  return value.trim();
}

function optionalId(
  object: JsonObject,
  path: string,
  errors: ValidationIssue[],
): string | null {
  const value = object.id;
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    errors.push(issue(`${path}.id`, "id 必须是非空字符串"));
    return null;
  }
  return value.trim();
}

function cloneBoard(board: BoardSnapshot): BoardSnapshot {
  return structuredClone(board);
}

export function prepareJsonImport(
  content: string,
  mode: ImportMode,
  currentBoard: BoardSnapshot,
  createId: (prefix: "task" | "subtask") => string,
): PreparedTransfer {
  const errors: ValidationIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch (error) {
    return {
      preview: {
        valid: false,
        version: null,
        motherTaskCount: 0,
        subTaskCount: 0,
        dependencyCount: 0,
        errors: [issue("$", `JSON 无法解析：${String(error)}`)],
      },
      board: null,
    };
  }
  if (!isObject(parsed)) {
    return {
      preview: {
        valid: false,
        version: null,
        motherTaskCount: 0,
        subTaskCount: 0,
        dependencyCount: 0,
        errors: [issue("$", "JSON 根节点必须是对象")],
      },
      board: null,
    };
  }

  const version = typeof parsed.version === "string" ? parsed.version : null;
  if (!version) {
    errors.push(issue("version", "缺少必填版本号"));
  } else if (version.split(".")[0] !== "1") {
    errors.push(issue("version", `文件版本 ${version} 与当前 1.x 不兼容`));
  }
  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  if (!Array.isArray(parsed.tasks)) {
    errors.push(issue("tasks", "tasks 必须是数组"));
  }

  const motherIds = new Set<string>();
  const subTaskIds = new Set<string>();
  const importedTasks: MotherTask[] = [];
  let subTaskCount = 0;
  let dependencyCount = 0;

  rawTasks.forEach((rawTask, taskIndex) => {
    const taskPath = `tasks[${taskIndex}]`;
    if (!isObject(rawTask)) {
      errors.push(issue(taskPath, "母任务必须是对象"));
      return;
    }
    const name = stringValue(rawTask, "name", taskPath, errors);
    const suppliedId = optionalId(rawTask, taskPath, errors);
    if (!suppliedId && mode === "overwrite") {
      errors.push(issue(`${taskPath}.id`, "覆盖导入要求母任务包含 id"));
    }
    const id =
      suppliedId ??
      currentBoard.tasks.find((task) => task.name === name)?.id ??
      createId("task");
    if (motherIds.has(id)) {
      errors.push(issue(`${taskPath}.id`, `母任务 id ${id} 重复`));
    }
    motherIds.add(id);

    const rawDependencies = rawTask.dependsOn;
    const dependsOn = Array.isArray(rawDependencies)
      ? rawDependencies.filter((value): value is string => typeof value === "string")
      : [];
    if (
      rawDependencies !== undefined &&
      (!Array.isArray(rawDependencies) || dependsOn.length !== rawDependencies.length)
    ) {
      errors.push(issue(`${taskPath}.dependsOn`, "dependsOn 必须是字符串数组"));
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      errors.push(issue(`${taskPath}.dependsOn`, "前置母任务 id 不能重复"));
    }
    dependencyCount += dependsOn.length;

    const existingMother = currentBoard.tasks.find((task) => task.id === id);
    const rawSubTasks = rawTask.subTasks;
    const subTasks: SubTask[] = [];
    if (rawSubTasks !== undefined && !Array.isArray(rawSubTasks)) {
      errors.push(issue(`${taskPath}.subTasks`, "subTasks 必须是数组"));
    }
    for (const [subIndex, rawSubTask] of (Array.isArray(rawSubTasks)
      ? rawSubTasks
      : []
    ).entries()) {
      subTaskCount += 1;
      const subPath = `${taskPath}.subTasks[${subIndex}]`;
      if (!isObject(rawSubTask)) {
        errors.push(issue(subPath, "子任务必须是对象"));
        continue;
      }
      const subName = stringValue(rawSubTask, "name", subPath, errors);
      const startDate = stringValue(rawSubTask, "startDate", subPath, errors);
      const endDate =
        rawSubTask.endDate === null || rawSubTask.endDate === undefined
          ? null
          : typeof rawSubTask.endDate === "string"
            ? rawSubTask.endDate
            : "";
      if (rawSubTask.endDate !== undefined && endDate === "") {
        errors.push(issue(`${subPath}.endDate`, "endDate 必须是日期字符串或 null"));
      }
      try {
        assertDateOnly(startDate);
        validateDateRange(startDate, endDate || null);
      } catch (error) {
        errors.push(
          issue(
            `${subPath}.${endDate ? "endDate" : "startDate"}`,
            error instanceof Error ? error.message : "日期无效",
          ),
        );
      }
      const suppliedSubId = optionalId(rawSubTask, subPath, errors);
      if (!suppliedSubId && mode === "overwrite") {
        errors.push(issue(`${subPath}.id`, "覆盖导入要求子任务包含 id"));
      }
      const subId =
        suppliedSubId ??
        existingMother?.subTasks.find(
          (task) => task.name === subName && task.startDate === startDate,
        )?.id ??
        createId("subtask");
      if (subTaskIds.has(subId)) {
        errors.push(issue(`${subPath}.id`, `子任务 id ${subId} 重复`));
      }
      subTaskIds.add(subId);
      subTasks.push({
        id: subId,
        motherTaskId: id,
        name: subName,
        startDate,
        endDate: endDate || null,
        sortOrder: subIndex,
      });
    }

    importedTasks.push({
      id,
      name,
      expanded: typeof rawTask.expanded === "boolean" ? rawTask.expanded : false,
      sortOrder: taskIndex,
      dependsOn,
      subTasks,
    });
  });

  let finalTasks: MotherTask[];
  if (mode === "overwrite") {
    finalTasks = importedTasks;
  } else {
    finalTasks = cloneBoard(currentBoard).tasks;
    for (const imported of importedTasks) {
      const existingIndex = finalTasks.findIndex((task) => task.id === imported.id);
      if (existingIndex < 0) {
        finalTasks.push({ ...imported, sortOrder: finalTasks.length });
        continue;
      }
      const existing = finalTasks[existingIndex];
      const mergedSubTasks = [...existing.subTasks];
      for (const importedSubTask of imported.subTasks) {
        const subIndex = mergedSubTasks.findIndex(
          (task) => task.id === importedSubTask.id,
        );
        if (subIndex < 0) {
          mergedSubTasks.push({
            ...importedSubTask,
            sortOrder: mergedSubTasks.length,
          });
        } else {
          mergedSubTasks[subIndex] = {
            ...importedSubTask,
            sortOrder: mergedSubTasks[subIndex].sortOrder,
          };
        }
      }
      finalTasks[existingIndex] = {
        ...imported,
        sortOrder: existing.sortOrder,
        subTasks: mergedSubTasks,
      };
    }
  }

  const availableIds = new Set(finalTasks.map((task) => task.id));
  finalTasks.forEach((task, index) => {
    for (const dependencyId of task.dependsOn) {
      if (!availableIds.has(dependencyId)) {
        errors.push(
          issue(
            `tasks[${index}].dependsOn`,
            `前置母任务 id ${dependencyId} 不存在`,
          ),
        );
      }
    }
  });
  if (errors.length === 0) {
    try {
      for (const task of finalTasks) {
        validateDependencyChange(finalTasks, task.id, task.dependsOn);
      }
    } catch (error) {
      errors.push(
        issue(
          "tasks[].dependsOn",
          error instanceof Error ? error.message : "依赖关系无效",
        ),
      );
    }
  }

  const preview: ImportPreview = {
    valid: errors.length === 0,
    version,
    motherTaskCount: rawTasks.length,
    subTaskCount,
    dependencyCount,
    errors,
  };
  return {
    preview,
    board:
      errors.length === 0
        ? { ...cloneBoard(currentBoard), tasks: finalTasks }
        : null,
  };
}

export function exportBoardJson(board: BoardSnapshot): {
  content: string;
  result: TransferResult;
} {
  const document = {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    source: "工作规划时间板",
    tasks: board.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      expanded: task.expanded,
      dependsOn: task.dependsOn,
      subTasks: task.subTasks.map((subTask) => ({
        id: subTask.id,
        name: subTask.name,
        startDate: subTask.startDate,
        endDate: subTask.endDate,
      })),
    })),
  };
  return {
    content: JSON.stringify(document, null, 2),
    result: {
      motherTaskCount: board.tasks.length,
      subTaskCount: board.tasks.reduce(
        (total, task) => total + task.subTasks.length,
        0,
      ),
      dependencyCount: board.tasks.reduce(
        (total, task) => total + task.dependsOn.length,
        0,
      ),
    },
  };
}
