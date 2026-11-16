import { createFileRoute } from "@tanstack/react-router";

import { HistoryPage } from "../components/history/HistoryPage";
import { validateHistorySearch } from "../components/history/historyPage.logic";

export const Route = createFileRoute("/_chat/history")({
  validateSearch: validateHistorySearch,
  component: HistoryPage,
});
