import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ArrowUpIcon, GitCommitHorizontalIcon, ListFilterIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarStaticShelfHeader } from "./SidebarListMarkers";

export interface SidebarChangedProject {
  readonly projectKey: string;
  readonly name: string;
  readonly icon: ProjectFaviconProject | null;
  readonly uncommittedFiles: number;
  readonly unpushedCommits: number;
}

const HiddenProjectKeys = Schema.Array(Schema.String);
const NO_HIDDEN_KEYS: ReadonlyArray<string> = [];

// A folder of untracked output can hold tens of thousands of files; the tooltip has the count.
const compactCount = (count: number) =>
  count < 1_000 ? `${count}` : `${Math.floor(count / 100) / 10}k`;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function changeSummary(project: SidebarChangedProject): string {
  return [
    project.uncommittedFiles > 0 ? `${plural(project.uncommittedFiles, "file")} uncommitted` : null,
    project.unpushedCommits > 0 ? `${plural(project.unpushedCommits, "commit")} not pushed` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/**
 * Each chosen project's uncommitted files and unpushed commits, read from Git: a shelf beside
 * Later and History, since it is looked at now and then, not worked from. The header's menu
 * picks which projects it lists; a project left out stays in the menu, so it can come back.
 */
export function SidebarChangesShelf(props: {
  /** Every project whose checkout holds changes, in sidebar order. */
  projects: ReadonlyArray<SidebarChangedProject>;
  first: boolean;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useLocalStorage("sidebar_changes_expanded", true, Schema.Boolean);
  const [hiddenKeys, setHiddenKeys] = useLocalStorage(
    "sidebar_changes_hidden_projects",
    NO_HIDDEN_KEYS,
    HiddenProjectKeys,
  );
  const shown = props.projects.filter((project) => !hiddenKeys.includes(project.projectKey));
  return (
    <>
      <SidebarStaticShelfHeader
        shelf="changes"
        Icon={GitCommitHorizontalIcon}
        label="Changes"
        count={shown.length}
        first={props.first}
        tide
        toggle={{ expanded, onToggle: () => setExpanded(!expanded) }}
        action={
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-micro"
                        variant="ghost-muted"
                        className="me-0.5 shrink-0"
                        aria-label="Choose the projects listed under Changes"
                      />
                    }
                  />
                }
              >
                <ListFilterIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Choose projects</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end">
              <MenuGroup>
                <MenuGroupLabel>Show changes for</MenuGroupLabel>
                {props.projects.map((project) => (
                  <MenuCheckboxItem
                    key={project.projectKey}
                    checked={!hiddenKeys.includes(project.projectKey)}
                    // The menu stays open, so several projects can be picked in one visit.
                    closeOnClick={false}
                    onCheckedChange={(checked) =>
                      setHiddenKeys((keys) =>
                        checked
                          ? keys.filter((key) => key !== project.projectKey)
                          : [
                              ...keys.filter((key) => key !== project.projectKey),
                              project.projectKey,
                            ],
                      )
                    }
                  >
                    {project.name}
                  </MenuCheckboxItem>
                ))}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        }
      />
      {expanded
        ? shown.map((project) => {
            const summary = changeSummary(project);
            return (
              <li key={project.projectKey} data-thread-selection-safe className="list-none">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuButton
                        type="button"
                        size="sm"
                        data-sidebar-row={`changes:${project.projectKey}`}
                        aria-label={`${project.name}: ${summary}. Show its changes`}
                        onClick={() =>
                          void navigate({
                            to: "/history",
                            search: { project: project.projectKey, view: "changes" },
                          })
                        }
                      />
                    }
                  >
                    {/* The icon sits as close to its name as on a thread row. */}
                    <span className="flex min-w-0 flex-1 items-center gap-1">
                      {project.icon ? (
                        <span className="flex shrink-0">
                          <ProjectFavicon project={project.icon} className="size-3" />
                        </span>
                      ) : null}
                      <span className="min-w-0 truncate">{project.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 font-normal tabular-nums">
                      {project.uncommittedFiles > 0 ? (
                        <span>
                          {compactCount(project.uncommittedFiles)}{" "}
                          {project.uncommittedFiles === 1 ? "file" : "files"}
                        </span>
                      ) : null}
                      {project.unpushedCommits > 0 ? (
                        <span className="flex items-center">
                          <ArrowUpIcon aria-hidden className="size-3" />
                          {compactCount(project.unpushedCommits)}
                        </span>
                      ) : null}
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="right">{summary}</TooltipPopup>
                </Tooltip>
              </li>
            );
          })
        : null}
    </>
  );
}
