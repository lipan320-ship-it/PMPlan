import { useState } from "react";
import { createStorageGateway } from "./app/createStorageGateway";
import { BoardPage } from "./features/board/BoardPage";
import type { StorageGateway } from "./storage/gateway";

interface AppProps {
  gateway?: StorageGateway;
}

export function App({ gateway: providedGateway }: AppProps) {
  const [gateway] = useState(() => providedGateway ?? createStorageGateway());
  return <BoardPage gateway={gateway} />;
}
