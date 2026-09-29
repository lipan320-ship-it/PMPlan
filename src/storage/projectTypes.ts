export type WorkspaceMode = "namedProject" | "unnamedLegacy";
export type ProjectSaveStatus = "saved" | "saving" | "unsaved" | "conflict" | "error";
export type RecentProjectStatus =
  | "available"
  | "missing"
  | "unreadable"
  | "invalid"
  | "conflict";

export interface RecentProject {
  path: string;
  name: string;
  parentPath: string;
  status: RecentProjectStatus;
  lastError: string | null;
}

export interface ProjectState {
  activePath: string | null;
  activeName: string | null;
  parentPath: string | null;
  workspaceMode: WorkspaceMode;
  saveStatus: ProjectSaveStatus;
  lastError: string | null;
  recent: RecentProject[];
}
