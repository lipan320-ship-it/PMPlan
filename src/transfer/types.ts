export type ImportMode = "overwrite" | "merge";

export type ImportSource =
  | { kind: "content"; value: string; fileName: string }
  | { kind: "path"; value: string; fileName: string };

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ImportPreview {
  valid: boolean;
  version: string | null;
  motherTaskCount: number;
  subTaskCount: number;
  dependencyCount: number;
  errors: ValidationIssue[];
}

export interface TransferResult {
  motherTaskCount: number;
  subTaskCount: number;
  dependencyCount: number;
}

export interface ExportResponse {
  content: string | null;
  result: TransferResult;
}
