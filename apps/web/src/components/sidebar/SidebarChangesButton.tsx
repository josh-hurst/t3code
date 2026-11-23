import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ArrowUpIcon, GitCommitHorizontalIcon } from "lucide-react";

import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarChangedProject {
  readonly projectKey: string;
  readonly name: string;
  readonly icon: ProjectFaviconProject | null;
  readonly uncommittedFiles: number;
  readonly unpushedCommits: number;
}

// A folder of untracked output can hold tens of thousands of files; compact counts keep rows tidy.
const compactCount = (count: number) =>
  count < 1_000 ? `${count}` : `${Math.floor(count / 100) / 10}k`;

/**
 * Compact Changes icon button in the sidebar footer. Jumps straight to Changes when a single
 * project is in scope, or opens a quick project picker popover otherwise.
 */
export function SidebarChangesButton(props: {
  readonly projects: ReadonlyArray<SidebarChangedProject>;
  readonly onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const gt = useGT();
  if (props.projects.length === 0) return null;

  const label = gt("Changes");
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
            <MenuGroupLabel>{label}</MenuGroupLabel>
            {props.projects.map((project) => (
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
            ))}
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}
