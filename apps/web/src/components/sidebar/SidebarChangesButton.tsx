import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { ArrowUpIcon, GitCommitHorizontalIcon, ListFilterIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarChangedProject {
  readonly projectKey: string;
  readonly name: string;
  readonly icon: ProjectFaviconProject | null;
  readonly uncommittedFiles: number;
  readonly unpushedCommits: number;
}

const HiddenProjectKeys = Schema.Array(Schema.String);
const NO_HIDDEN_KEYS: ReadonlyArray<string> = [];

// A folder of untracked output can hold tens of thousands of files; compact counts keep rows tidy.
const compactCount = (count: number) =>
  count < 1_000 ? `${count}` : `${Math.floor(count / 100) / 10}k`;

/**
 * Compact Changes icon button in the sidebar footer. Jumps straight to Changes when a single
 * project is in scope, or opens a project picker popover with a Choose projects filter submenu.
 */
export function SidebarChangesButton(props: {
  readonly projects: ReadonlyArray<SidebarChangedProject>;
  readonly onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const gt = useGT();
  const [hiddenKeys, setHiddenKeys] = useLocalStorage(
    "sidebar_changes_hidden_projects",
    NO_HIDDEN_KEYS,
    HiddenProjectKeys,
  );
  if (props.projects.length === 0) return null;

  const label = gt("Changes");
  const shown = props.projects.filter((project) => !hiddenKeys.includes(project.projectKey));
  const openProject = (projectKey: string) => {
    props.onNavigate?.();
    void navigate({
      to: "/history",
      search: { project: projectKey, view: "changes" },
    });
  };

  if (props.projects.length === 1) {
    const only = props.projects[0]!;
    return (
      <SidebarMenuItem className="shrink-0">
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton
                aria-label={label}
                size="icon"
                onClick={() => openProject(only.projectKey)}
              >
                <GitCommitHorizontalIcon />
              </SidebarMenuButton>
            }
          />
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem className="shrink-0">
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <SidebarMenuButton aria-label={label} size="icon">
                    <GitCommitHorizontalIcon />
                  </SidebarMenuButton>
                }
              />
            }
          />
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
        <MenuPopup side="top" align="start" className="min-w-52">
          <MenuGroup>
            <div className="flex items-center justify-between gap-2 pe-1">
              <MenuGroupLabel>{label}</MenuGroupLabel>
              <MenuSub>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <MenuPrimitive.SubmenuTrigger
                        nativeButton
                        openOnHover={false}
                        render={
                          <Button
                            type="button"
                            size="icon-micro"
                            variant="ghost-muted"
                            aria-label="Choose projects"
                          >
                            <ListFilterIcon />
                          </Button>
                        }
                      />
                    }
                  />
                  <TooltipPopup side="top">Choose projects</TooltipPopup>
                </Tooltip>
                <MenuSubPopup align="start">
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
                        <span className="flex min-w-0 items-center gap-1.5">
                          {project.icon ? (
                            <span className="flex shrink-0">
                              <ProjectFavicon project={project.icon} className="size-3.5" />
                            </span>
                          ) : null}
                          <span className="min-w-0 truncate">{project.name}</span>
                        </span>
                      </MenuCheckboxItem>
                    ))}
                  </MenuGroup>
                </MenuSubPopup>
              </MenuSub>
            </div>
            {shown.length > 0 ? (
              shown.map((project) => (
                <MenuItem key={project.projectKey} onClick={() => openProject(project.projectKey)}>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    {project.icon ? (
                      <span className="flex shrink-0">
                        <ProjectFavicon project={project.icon} className="size-3.5" />
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate">{project.name}</span>
                  </span>
                  {project.uncommittedFiles > 0 || project.unpushedCommits > 0 ? (
                    <span className="ms-3 flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
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
                  ) : null}
                </MenuItem>
              ))
            ) : (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No projects selected</p>
            )}
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}
